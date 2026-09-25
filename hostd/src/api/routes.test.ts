import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, matchRoute, parseLogsQuery, RAIL_STALE_MS } from './routes.ts'
// The agent's own end of railAge. Imported into an api test on purpose: the figure is produced in one
// process and read in another, each side had its own passing tests, and what they disagreed about was
// what the figure meant. Only a test that joins them can see that.
import { ApacheRail, type RailFs } from '../agent/apache-rail.ts'
import { AuditLog } from './audit.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { ScheduleStore, type ScheduleFs } from './schedule.ts'
import { DomainStore, domainKey, newRecord, type DomainRecord } from './domain-state.ts'
// The verifier's own scheduling rule, imported here so "the operator can re-check this name" is asserted
// as the thing it actually is (a record the verifier will pick up) rather than as a state string.
import { nextCheckAt } from './verifier.ts'
import { parseRegistry, type Registry } from '../shared/registry.ts'
import { DOMAIN_TOKEN, checkStructure, type AgentReply, type AgentRequest, type CopyRecord, type LogLine } from '../shared/protocol.ts'
import type { SystemUsage } from '../shared/system.ts'

const TOKEN = 'k'.repeat(64)
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env, deploy, backups, domains]
    environments:
      live: { dir: /var/www/acme, port: 5010, branch: main, domain: acme.example, aliases: [www.acme.example], certificate: letsencrypt, deployed: abc1234 }
      test: { dir: /var/www/acme-test, port: 5013, branch: develop, domain: test.acme.example }
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  other:
    client: cl_2
    name: Other
    dir: /var/www/other
    upstream: 127.0.0.1:5012
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  broken:
    client: cl_1
`)

// Every environment of acme and of quiet as a client is allowed to see them: their own site's branch,
// domain, certificate and deployed commit, and nothing about the machine underneath. quiet is the
// single-environment shape, where the registry synthesises one live environment out of dir and upstream.
const acmeEnvironmentsForClient = [
    { name: 'live', branch: 'main', domain: 'acme.example', aliases: ['www.acme.example'], certificate: 'letsencrypt', websockets: false, flexibleSsl: false, deployed: 'abc1234' },
    { name: 'test', branch: 'develop', domain: 'test.acme.example', aliases: [], certificate: null, websockets: false, flexibleSsl: false, deployed: null },
]
const quietEnvironmentsForClient = [{ name: 'live', branch: null, domain: null, aliases: [], certificate: null, websockets: false, flexibleSsl: false, deployed: null }]

const logLine: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }
const usage: SystemUsage = {
    memory: { totalBytes: 8_000_000_000, usedBytes: 3_000_000_000, availableBytes: 5_000_000_000 },
    cpu: { cores: 4, load1: 0.5, load5: 0.4, load15: 0.25 },
    disk: { path: '/var/www', totalBytes: 500_000_000_000, usedBytes: 200_000_000_000, freeBytes: 275_000_000_000 },
    problems: [],
}

// The agent as api sees it. Tests replace call or stream to simulate refusals and outages.
function fakeAgent() {
    const calls: AgentRequest[] = []
    const agent: AgentClient & { calls: AgentRequest[], reply: (request: AgentRequest) => AgentReply } = {
        calls,
        reply: request => {
            switch (request.verb) {
                // A rail that answered a second ago, so only a test that asks for a quiet one sees the
                // warning about it.
                case 'health': return { ok: true, warnings: [], invalid: { acme: 'guard says no' }, system: usage, railAge: 1_000 }
                case 'status': return { ok: true, services: [] }
                case 'statuses': return { ok: true, projects: request.projects.map(project => ({ project, ok: true as const, services: [] })) }
                default: return { ok: true, output: 'done' }
            }
        },
        async call(request) {
            calls.push(request)
            return agent.reply(request)
        },
        async stream(request) {
            calls.push(request)
            return { ok: true, lines: (async function* () { yield logLine })(), close() {} }
        },
        async download(request) {
            calls.push(request)
            return { ok: true, body: (async function* () { yield Buffer.from('bytes') })(), close() {} }
        },
    }
    return agent
}

// An in-memory ScheduleFs, the same shape schedule.test.ts builds, so the schedule store here never
// touches a real disk.
function scheduleFs(): ScheduleFs {
    const store = new Map<string, string>()
    return {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error('ENOENT')
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => { store.set(to, store.get(from)!); store.delete(from) },
        mkdir: async () => {},
    }
}

// The real DomainStore over a file that only ever exists in memory: the class is what the routes are
// wired to in production, and its ordering and its key are part of what these tests are checking.
function memoryDomains(): DomainStore {
    let text = '[]'
    return new DomainStore('/state/domains.json', {
        readFile: async () => text,
        writeFile: async (_path, written) => { text = written },
        rename: async () => {},
        mkdir: async () => {},
    })
}

// The verifier as the routes see it: one record checked on demand. The outcome is a plain function so a
// test can decide what the check concluded without a network or a clock.
function fakeVerifier(store: () => DomainStore) {
    return {
        checked: [] as string[],
        outcome: (record: DomainRecord): DomainRecord => ({ ...record, state: 'active', checkedAt: CHECKED_AT, error: null }),
        async checkNow(key: string) {
            this.checked.push(key)
            const record = store().get(key)
            if (record) await store().put(this.outcome(record))
        },
    }
}

// The adopt route asks the hostname itself whether it is still answering, once before it replaces the
// vhost and once after. Nothing in this suite leaves the process, so the answers are scripted: each
// entry of `answers` is consumed by one probe, in order, and an Error is thrown rather than returned,
// which is what a name that does not resolve looks like. The default is a plain 200 both times, so every
// test that does not care about the check is unaffected by it.
function fakeProbe() {
    const probe = {
        calls: [] as string[],
        answers: [] as (number | Error)[],
        fetch: (async (url: string) => {
            probe.calls.push(String(url))
            const next = probe.answers.shift() ?? 200
            if (next instanceof Error) throw next
            const headers: Record<string, string> = next >= 300 && next < 400 ? { location: 'https://acme.example/' } : {}
            return new Response(null, { status: next, headers })
        }) as unknown as typeof fetch,
    }
    return probe
}

const CHECKED_AT = '2026-09-21T12:00:00.000Z'
const FIRST_SEEN = '2026-09-20T00:00:00.000Z'
const TOKEN_IN_PLACE = 'a1b2c3d4e5f6'

function domainRecord(over: Partial<DomainRecord> = {}): DomainRecord {
    return { ...newRecord('acme', 'live', 'acme.example', true, FIRST_SEEN), ...over }
}

async function seedDomains(records: DomainRecord[]): Promise<void> {
    for (const record of records) await domains.put(record)
}

let server: Server
let base = ''
let dir = ''
let audit: AuditLog
let agent: ReturnType<typeof fakeAgent>
let schedules: ScheduleStore
let domains: DomainStore
let verifier: ReturnType<typeof fakeVerifier>
let probe: ReturnType<typeof fakeProbe>

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hostd-routes-'))
    server = createServer((req, res) => handler(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
})

let handler: ReturnType<typeof createHandler>
beforeEach(async () => {
    audit = new AuditLog(join(dir, `audit-${Math.random().toString(36).slice(2)}`))
    agent = fakeAgent()
    schedules = new ScheduleStore('/state/schedules.json', scheduleFs())
    await schedules.load()
    domains = memoryDomains()
    verifier = fakeVerifier(() => domains)
    probe = fakeProbe()
    handler = createHandler({
        token: TOKEN, registry: () => registry, refreshRegistry: async () => false,
        agent, audit, schedules, domains, verifier, keepaliveMs: 60_000, fetch: probe.fetch,
    })
})

function request(
    path: string,
    options: { method?: string, actor?: string, token?: string | null, body?: unknown, rawBody?: string } = {},
) {
    const headers: Record<string, string> = { 'x-hostd-actor': options.actor ?? 'client:cl_1', 'x-hostd-user': 'user_1' }
    if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
    const hasBody = options.body !== undefined || options.rawBody !== undefined
    if (hasBody) headers['content-type'] = 'application/json'
    const body = options.rawBody !== undefined ? options.rawBody : hasBody ? JSON.stringify(options.body) : undefined
    return fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body })
}

describe('matchRoute', () => {
    it('matches every phase 1 route and refuses the rest', () => {
        assert.deepEqual(matchRoute('GET', '/projects'), { verb: 'list' })
        assert.deepEqual(matchRoute('GET', '/audit'), { verb: 'audit-all' })
        assert.deepEqual(matchRoute('GET', '/health'), { verb: 'health' })
        assert.deepEqual(matchRoute('POST', '/health'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme'), { verb: 'status', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/restart'), { verb: 'lifecycle', project: 'acme', action: 'restart' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/logs'), { verb: 'logs', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/audit'), { verb: 'audit', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/start'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/%2e%2e'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/files'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/'), { verb: 'not-found' })
    })

    it('matches the provisioning and env routes, and refuses the rest', () => {
        assert.deepEqual(matchRoute('POST', '/projects'), { verb: 'create' })
        assert.deepEqual(matchRoute('DELETE', '/projects'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme'), { verb: 'delete', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/environments'), { verb: 'add-environment', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/environments'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/environments/test'), { verb: 'remove-environment', project: 'acme', environment: 'test' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/environments/uat1'), { verb: 'remove-environment', project: 'acme', environment: 'uat1' })
        for (const name of ['uat-1', 'git', 'Staging']) {
            assert.deepEqual(matchRoute('DELETE', `/projects/acme/environments/${name}`), { verb: 'not-found' }, name)
        }
        assert.deepEqual(matchRoute('GET', '/projects/acme/environments/test'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/env'), { verb: 'env-list', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/env'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/test/env/db/.env'), { verb: 'env-file', project: 'acme', environment: 'test', path: 'db/.env' })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/test/env/.env'), { verb: 'env-file', project: 'acme', environment: 'test', path: '.env' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/test/env/.env'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/staging/env'), { verb: 'env-list', project: 'acme', environment: 'staging' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/Staging/env'), { verb: 'not-found' })
    })

    it('matches the deploy routes under an environment, and refuses the rest', () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy'), { verb: 'deploy', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/test/rollback'), { verb: 'rollback', project: 'acme', environment: 'test' })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/branch'), { verb: 'branch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploys'), { verb: 'deploys', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/commits'), { verb: 'commits', project: 'acme', environment: 'live' })
        // GET on the deploy path watches the one that is running rather than 405ing: see the
        // 'watching a deploy' describe block below for the rest of that shape.
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploy'), { verb: 'deploy-watch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/branch'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/nonsense'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy/now'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/uat1/deploy'), { verb: 'deploy', project: 'acme', environment: 'uat1' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/uat1/deploys'), { verb: 'deploys', project: 'acme', environment: 'uat1' })
        for (const name of ['uat-1', 'next', 'prev', 'git', 'UAT1', 'a'.repeat(17)]) {
            assert.deepEqual(matchRoute('POST', `/projects/acme/${name}/deploy`), { verb: 'not-found' }, name)
        }
    })
})

describe('domain routes', () => {
    it('matches the six endpoints', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/domains'), { verb: 'domains-list', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/domains'), { verb: 'domain-add', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/domains/www.acme.com'), { verb: 'domain-remove', project: 'acme', environment: 'live', hostname: 'www.acme.com' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/domains/www.acme.com/verify'), { verb: 'domain-verify', project: 'acme', environment: 'live', hostname: 'www.acme.com' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/adopt'), { verb: 'adopt-preview', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/adopt'), { verb: 'adopt', project: 'acme', environment: 'live' })
    })

    it('refuses the wrong method on each of them', () => {
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/domains'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/adopt'), { verb: 'method-not-allowed' })
    })

    it('does not match a name that is not an environment name', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/uat-1/domains'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/uat1/domains'), { verb: 'domains-list', project: 'acme', environment: 'uat1' })
    })

    it('refuses the wrong method and an unknown tail under one hostname', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/domains/www.acme.com'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/domains/www.acme.com/verify'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/domains/www.acme.com/check'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/adopt/now'), { verb: 'not-found' })
    })
})

describe('parseLogsQuery', () => {
    const parse = (query: string) => parseLogsQuery(new URLSearchParams(query))

    it('defaults tail, since and follow', () => {
        assert.deepEqual(parse('service=web'), { ok: true, args: { service: 'web', tail: 200, since: null, follow: false } })
    })

    it('accepts since as Unix seconds or as an RFC 3339 timestamp', () => {
        assert.deepEqual(parse('service=web&since=1726790400.5&follow=1&tail=0'), { ok: true, args: { service: 'web', tail: 0, since: 1726790400.5, follow: true } })
        const parsed = parse('service=web&since=2026-09-20T00:00:00.123456789Z')
        assert.equal(parsed.ok && parsed.args.since, Date.parse('2026-09-20T00:00:00.123Z') / 1000)
    })

    it('refuses bad values', () => {
        for (const query of ['', 'service=a/b', 'service=web&tail=5001', 'service=web&tail=1.5', 'service=web&since=yesterday', 'service=web&follow=maybe']) {
            assert.equal(parse(query).ok, false, query)
        }
    })
})

describe('authentication', () => {
    it('answers 401 without the token and audits the attempt', async () => {
        const response = await request('/projects', { token: null })
        assert.equal(response.status, 401)
        const [entry] = await audit.read({ limit: 10 })
        assert.equal(entry?.actor, 'unauthenticated (claimed client:cl_1)')
        assert.equal(entry?.outcome, 'refused')
        assert.deepEqual(agent.calls, [])
    })

    it('answers 400 for a malformed actor', async () => {
        const response = await request('/projects', { actor: 'root' })
        assert.equal(response.status, 400)
    })
})

describe('GET /projects', () => {
    it('lists only the client\'s own projects, with validity from the agent', async () => {
        const body = await (await request('/projects')).json()
        assert.deepEqual(body, {
            ok: true,
            projects: [
                {
                    id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy', 'backups', 'domains'],
                    valid: false, reason: 'guard says no', environments: acmeEnvironmentsForClient,
                },
                { id: 'quiet', name: 'Quiet', capabilities: [], valid: true, environments: quietEnvironmentsForClient },
            ],
        })
    })

    it('shows the admin every project, invalid registry entries included', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, valid: boolean }> }
        assert.deepEqual(body.projects.map(p => [p.id, p.valid]), [['acme', false], ['quiet', true], ['other', true], ['broken', false]])
    })

    it('asks the agent for nothing but health, so the plain listing costs no Docker read', async () => {
        await request('/projects')
        assert.deepEqual(agent.calls, [{ verb: 'health' }])
    })

    it('carries each project\'s status with status=1, asking only for the ones this actor can see', async () => {
        const body = await (await request('/projects?status=1')).json() as { projects: Array<Record<string, unknown>> }
        assert.deepEqual(agent.calls, [{ verb: 'health' }, { verb: 'statuses', projects: ['acme', 'quiet'] }])
        assert.deepEqual(body.projects, [
            {
                id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy', 'backups', 'domains'],
                valid: false, reason: 'guard says no', environments: acmeEnvironmentsForClient, status: { ok: true, services: [] },
            },
            { id: 'quiet', name: 'Quiet', capabilities: [], valid: true, environments: quietEnvironmentsForClient, status: { ok: true, services: [] } },
        ])
    })

    it('answers an invalid registry entry\'s status from the registry, without asking the agent about it', async () => {
        const body = await (await request('/projects?status=1', { actor: 'admin' })).json() as { projects: Array<{ id: string, status: { ok: boolean, code?: string } }> }
        assert.deepEqual(agent.calls[1], { verb: 'statuses', projects: ['acme', 'quiet', 'other'] })
        const broken = body.projects.find(project => project.id === 'broken')
        assert.deepEqual([broken?.status.ok, broken?.status.code], [false, 'invalid-project'])
    })

    it('carries a refusal per project rather than failing the list', async () => {
        agent.reply = request => request.verb === 'statuses'
            ? { ok: true, projects: [{ project: 'acme', ok: false, code: 'failed', message: 'the Docker API could not be read' }] }
            : { ok: true, warnings: [], invalid: {}, system: usage, railAge: null }
        const response = await request('/projects?status=1')
        assert.equal(response.status, 200)
        const body = await response.json() as { projects: Array<{ id: string, status: Record<string, unknown> }> }
        assert.deepEqual(body.projects.map(project => [project.id, project.status]), [
            ['acme', { ok: false, code: 'failed', message: 'the Docker API could not be read' }],
            // Nothing came back for quiet at all, which is still an answer the dashboard can draw.
            ['quiet', { ok: false, code: 'failed', message: 'the agent returned no status for quiet' }],
        ])
    })

    it('refuses a status flag it cannot read rather than treating it as off', async () => {
        const response = await request('/projects?status=yes')
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    // The test that matters most. A key that is present and undefined would serialise away here but
    // would still be there in any other caller of the same code, so absence is asserted on the key.
    it('keeps the machine out of a client\'s environments: no dir and no port, in any of them', async () => {
        const body = await (await request('/projects')).json() as { projects: Array<{ environments: Array<Record<string, unknown>> }> }
        const environments = body.projects.flatMap(project => project.environments)
        assert.equal(environments.length, 3)
        for (const environment of environments) {
            assert.equal(Object.hasOwn(environment, 'dir'), false)
            assert.equal(Object.hasOwn(environment, 'port'), false)
            assert.equal(Object.hasOwn(environment, 'composePaths'), false)
        }
    })

    it('gives the operator the whole entry, dir and port included', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, environments?: Array<Record<string, unknown>> }> }
        assert.deepEqual(body.projects.find(project => project.id === 'acme')?.environments, [
            {
                name: 'live', dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'], port: 5010,
                branch: 'main', domain: 'acme.example', aliases: ['www.acme.example'], certificate: 'letsencrypt', websockets: false, flexibleSsl: false, deployed: 'abc1234',
            },
            {
                name: 'test', dir: '/var/www/acme-test', composePaths: ['/var/www/acme-test/docker-compose.yml'], port: 5013,
                branch: 'develop', domain: 'test.acme.example', aliases: [], certificate: null, websockets: false, flexibleSsl: false, deployed: null,
            },
        ])
    })

    // A registry entry api itself could not parse has no environments to report, so it carries none
    // rather than an empty list that would read as a site with nothing running.
    it('leaves environments off an invalid registry entry', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string }> }
        const broken = body.projects.find(project => project.id === 'broken')
        assert.equal(Object.hasOwn(broken ?? {}, 'environments'), false)
    })

    it('answers the operator a project\'s repo', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, repo?: string | null }> }
        const acme = body.projects.find(project => project.id === 'acme')
        assert.equal(acme?.repo, 'git@github.com:acme/site.git')
    })

    it('tells a client nothing about the repo', async () => {
        const body = await (await request('/projects')).json() as { projects: Array<Record<string, unknown>> }
        for (const project of body.projects) {
            assert.equal(Object.hasOwn(project, 'repo'), false)
        }
    })
})

describe('GET /credentials', () => {
    it('routes at the top level, not under a project, and allows only GET', () => {
        assert.deepEqual(matchRoute('GET', '/credentials'), { verb: 'credentials' })
        assert.equal(matchRoute('POST', '/credentials').verb, 'method-not-allowed')
    })

    it('asks the agent and answers its list', async () => {
        agent.reply = () => ({ ok: true, credentials: ['acme', 'northwind'] })
        const response = await request('/credentials', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, credentials: ['acme', 'northwind'] })
        assert.deepEqual(agent.calls, [{ verb: 'credentials' }])
    })

    // 403 rather than the 404 a project route gives: there is no project here to be coy about, and
    // this is gated the way audit-all is.
    it('refuses a client, and never calls the agent', async () => {
        const response = await request('/credentials')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })
})

describe('GET /ports', () => {
    it('routes at the top level and allows only GET', () => {
        assert.deepEqual(matchRoute('GET', '/ports'), { verb: 'ports' })
        assert.equal(matchRoute('POST', '/ports').verb, 'method-not-allowed')
    })

    it('asks the agent about the port and the environment it is for', async () => {
        agent.reply = () => ({ ok: true, suggested: 5012, problem: null })
        const response = await request('/ports?port=5010&project=acme&environment=live', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, suggested: 5012, problem: null })
        assert.deepEqual(agent.calls, [{ verb: 'ports', args: { port: 5010, own: { project: 'acme', environment: 'live' } } }])
    })

    it('takes any environment name as the own environment', async () => {
        agent.reply = () => ({ ok: true, suggested: 5012, problem: null })
        const response = await request('/ports?port=5010&project=acme&environment=uat1', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'ports', args: { port: 5010, own: { project: 'acme', environment: 'uat1' } } }])
    })

    it('asks about no port when none is given', async () => {
        agent.reply = () => ({ ok: true, suggested: 5012, problem: null })
        await request('/ports', { actor: 'admin' })
        assert.deepEqual(agent.calls, [{ verb: 'ports', args: { port: null, own: null } }])
    })

    it('refuses a malformed query without asking the agent', async () => {
        for (const query of ['?port=abc', '?port=5012&project=acme', '?environment=live', '?project=acme&environment=uat-1', '?project=acme&environment=next']) {
            const response = await request(`/ports${query}`, { actor: 'admin' })
            assert.equal(response.status, 400)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('refuses a client, and never calls the agent', async () => {
        const response = await request('/ports')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })
})

describe('the credential on a project', () => {
    it('carries a settings credential through to the agent, null included rather than dropped', async () => {
        agent.reply = () => ({ ok: true, output: 'configured' })
        const body = { credential: null }
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'configure', project: 'acme', args: body }])
    })

    // The operator sees the entry as it is; a client has no use for a name that means nothing to them
    // and everything to the machine, so it is absent rather than null, exactly as repo is.
    it('answers the credential to an admin and withholds it from a client', async () => {
        const forAdmin = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<Record<string, unknown>> }
        assert.ok(Object.hasOwn(forAdmin.projects[0]!, 'credential'))

        const forClient = await (await request('/projects')).json() as { projects: Array<Record<string, unknown>> }
        assert.ok(!Object.hasOwn(forClient.projects[0]!, 'credential'))
    })
})

describe('GET /health', () => {
    it('gives the admin the machine\'s figures', async () => {
        const response = await request('/health', { actor: 'admin' })
        assert.equal(response.status, 200)
        // acme live is set to letsencrypt, which 4a cannot serve yet, so health says so once.
        assert.deepEqual(await response.json(), {
            ok: true, warnings: ['waiting for Let\'s Encrypt support: acme live'],
            invalid: { acme: 'guard says no' }, system: usage, railAge: 1_000,
        })
    })

    it('refuses a client', async () => {
        const response = await request('/health')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.outcome, entry?.reason], ['refused', 'admin-only'])
    })
})

describe('GET /projects/:id', () => {
    it('carries the environments beside the agent\'s services', async () => {
        const response = await request('/projects/acme')
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, services: [], environments: acmeEnvironmentsForClient })
    })

    it('keeps the machine out of a client\'s environments here too', async () => {
        const body = await (await request('/projects/acme')).json() as { environments: Array<Record<string, unknown>> }
        for (const environment of body.environments) {
            assert.equal(Object.hasOwn(environment, 'dir'), false)
            assert.equal(Object.hasOwn(environment, 'port'), false)
            assert.equal(Object.hasOwn(environment, 'composePaths'), false)
        }
    })

    // The portal lists every hostname of every environment, so each carries its aliases beside its
    // primary, for a client as much as the operator: they are the site's own hostnames.
    it('carries each environment\'s aliases', async () => {
        for (const actor of ['admin', 'client:cl_1']) {
            const body = await (await request('/projects/acme', { actor })).json() as { environments: Array<Record<string, unknown>> }
            assert.deepEqual(body.environments.map(environment => [environment.name, environment.aliases]), [
                ['live', ['www.acme.example']],
                ['test', []],
            ])
        }
    })

    it('gives the operator dir and port', async () => {
        const body = await (await request('/projects/acme', { actor: 'admin' })).json() as { environments: Array<Record<string, unknown>> }
        assert.deepEqual(body.environments.map(environment => [environment.dir, environment.port]), [
            ['/var/www/acme', 5010],
            ['/var/www/acme-test', 5013],
        ])
    })

    // The single-environment shape: no environments key in the registry at all, which the registry reads
    // as live only, so the answer is one live environment rather than none.
    it('answers a single-environment project with its one live environment', async () => {
        const body = await (await request('/projects/quiet')).json()
        assert.deepEqual(body, { ok: true, services: [], environments: quietEnvironmentsForClient })
    })

    it('refuses another client\'s project without asking the agent', async () => {
        const response = await request('/projects/other')
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

describe('project routes', () => {
    it('answers 404 for another client\'s project without asking the agent', async () => {
        const response = await request('/projects/other/start', { method: 'POST' })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.outcome, entry?.reason, entry?.project], ['refused', 'not-found', 'other'])
    })

    it('answers 403 for a switched-off capability without asking the agent', async () => {
        const response = await request('/projects/quiet/restart', { method: 'POST' })
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })

    it('runs a lifecycle action through the agent and audits it with its output', async () => {
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, output: 'done' })
        assert.deepEqual(agent.calls, [{ verb: 'lifecycle', project: 'acme', args: { action: 'start' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual(
            [entry?.actor, entry?.user, entry?.project, entry?.verb, entry?.target, entry?.outcome, entry?.output],
            ['client:cl_1', 'user_1', 'acme', 'lifecycle', 'start', 'ok', 'done'],
        )
    })

    it('passes an agent refusal through with its HTTP status', async () => {
        agent.reply = () => ({ ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        const response = await request('/projects/acme/stop', { method: 'POST' })
        assert.equal(response.status, 409)
        assert.deepEqual(await response.json(), { ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        assert.equal((await audit.read({ limit: 1 }))[0]?.outcome, 'refused')
    })

    it('reports a failed command as 502 with its output, audited as failed', async () => {
        agent.reply = () => ({ ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 502)
        assert.deepEqual(await response.json(), { ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.outcome, entry?.reason, entry?.output], ['failed', 'start exited with code 1', 'no such image'])
    })

    it('answers 503 when the agent cannot be reached', async () => {
        agent.call = async () => { throw new AgentUnavailableError('the agent closed the connection without answering') }
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 503)
        assert.equal(((await response.json()) as { code: string }).code, 'agent-unavailable')
        assert.equal((await audit.read({ limit: 1 }))[0]?.outcome, 'failed')
    })

    it('returns status without auditing a plain read', async () => {
        const response = await request('/projects/acme')
        assert.deepEqual(await response.json(), { ok: true, services: [], environments: acmeEnvironmentsForClient })
        assert.deepEqual(await audit.read({ limit: 10 }), [])
    })

    it('answers 405 and 404 for the wrong method or path', async () => {
        assert.equal((await request('/projects/acme', { method: 'PUT' })).status, 405)
        assert.equal((await request('/nope')).status, 404)
    })
})

describe('GET /projects/:id/logs', () => {
    it('streams log lines as Server-Sent Events, ending with an end event', async () => {
        const response = await request('/projects/acme/logs?service=web&tail=5')
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
        const text = await response.text()
        assert.ok(text.includes(`event: line\ndata: ${JSON.stringify(logLine)}\n\n`), text)
        assert.ok(text.endsWith('event: end\ndata: {}\n\n'), text)
        assert.deepEqual(agent.calls, [{ verb: 'logs', project: 'acme', args: { service: 'web', tail: 5, since: null, follow: false } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['logs', 'web', 'ok'])
    })

    it('answers 400 for a bad query without asking the agent', async () => {
        const response = await request('/projects/acme/logs?service=web&tail=99999')
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('passes a stream refusal through as JSON', async () => {
        agent.stream = async () => ({ ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
        const response = await request('/projects/acme/logs?service=web&follow=1')
        assert.equal(response.status, 409)
    })
})

describe('audit routes', () => {
    it('shows a project\'s own trail to its owner, and all of it only to the admin', async () => {
        await request('/projects/acme/start', { method: 'POST' })
        await request('/projects/other/start', { method: 'POST', actor: 'client:cl_2' })

        const own = await (await request('/projects/acme/audit')).json() as { events: Array<{ project: string }> }
        assert.deepEqual(own.events.map(e => e.project), ['acme'])

        assert.equal((await request('/audit')).status, 403)
        const all = await (await request('/audit', { actor: 'admin' })).json() as { events: unknown[] }
        // The two starts, plus the refused client attempt at /audit just above.
        assert.equal(all.events.length, 3)
    })

    it('refuses a bad limit', async () => {
        assert.equal((await request('/projects/acme/audit?limit=0')).status, 400)
        assert.equal((await request('/projects/acme/audit?limit=501')).status, 400)
    })
})

const CREATE_BODY = {
    id: 'newsite', client: 'cl_1', name: 'New Site', repo: 'git@example.com:cl1/newsite.git',
    branch: 'main', domain: null, certificate: null,
}

describe('POST /projects', () => {
    it('creates a project and returns what the agent replied', async () => {
        const provisionReply: AgentReply = { ok: true, project: { id: 'newsite', state: 'needs-setup' }, envFiles: [] }
        agent.reply = () => provisionReply
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: CREATE_BODY })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), provisionReply)
        assert.deepEqual(agent.calls, [{ verb: 'provision', args: { action: 'create', ...CREATE_BODY } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual(
            [entry?.actor, entry?.project, entry?.verb, entry?.target, entry?.outcome],
            ['admin', 'newsite', 'provision', 'newsite create', 'ok'],
        )
    })

    it('refuses a create with a missing or malformed field, without calling the agent', async () => {
        const { domain: _domain, ...withoutDomain } = CREATE_BODY
        const missing = await request('/projects', { method: 'POST', actor: 'admin', body: withoutDomain })
        assert.equal(missing.status, 400)

        const malformed = await request('/projects', { method: 'POST', actor: 'admin', body: { ...CREATE_BODY, id: 42 } })
        assert.equal(malformed.status, 400)

        const extraField = await request('/projects', { method: 'POST', actor: 'admin', body: { ...CREATE_BODY, extra: 'nope' } })
        assert.equal(extraField.status, 400)

        assert.deepEqual(agent.calls, [])
    })

    it('carries a port through to the agent', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'newsite', state: 'needs-setup' }, envFiles: [] })
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: { ...CREATE_BODY, domain: null, certificate: null, port: 5012 } })
        assert.equal(response.status, 200)
        assert.equal((agent.calls[0] as { args: { port?: number } }).args.port, 5012)
    })

    it('returns 503 when the agent refuses because provisioning is not configured', async () => {
        // This is a well-formed agent reply (a Refusal with code 'unavailable'), not a dropped
        // connection: it exercises the ordinary refusal pass-through in respondAgentAction, mapped
        // through AGENT_STATUS like any other refusal code.
        agent.reply = () => ({ ok: false, code: 'unavailable', message: 'provisioning is not configured' })
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: CREATE_BODY })
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { ok: false, code: 'unavailable', message: 'provisioning is not configured' })
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.outcome, 'refused')
    })

    it('returns 503 with code agent-unavailable when the agent connection is actually lost', async () => {
        agent.call = async () => { throw new AgentUnavailableError('the agent closed the connection without answering') }
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: CREATE_BODY })
        assert.equal(response.status, 503)
        assert.equal(((await response.json()) as { code: string }).code, 'agent-unavailable')
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.outcome], ['provision', 'failed'])
    })

    it('passes the New site fields through to the agent, and a create with no client', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'newsite', state: 'needs-setup' }, envFiles: [] })
        const { client: _client, ...body } = {
            ...CREATE_BODY, dir: 'newsite_www', compose: ['docker-compose.yml', 'prod.yml'],
            capabilities: ['lifecycle', 'deploy'], websockets: true, flexibleSsl: false,
        }
        const response = await request('/projects', { method: 'POST', actor: 'admin', body })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', args: { action: 'create', ...body } }])
    })

    it('refuses a malformed New site field without calling the agent', async () => {
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: { ...CREATE_BODY, dir: '../etc' } })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    // acme stands in for the site just created: the fake agent does not write the registry, and acme is
    // already in it with the domain the create names, which is what the refreshed registry would hold.
    describe('with a domain', () => {
        const CREATED: AgentReply = { ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] }
        const body = { ...CREATE_BODY, id: 'acme', domain: 'acme.example', certificate: 'letsencrypt' }
        const previewWith = (claims: string[]): AgentReply => ({
            ok: true,
            preview: {
                proposed: '<VirtualHost *:443>', extraNames: [], unreadable: [], adoptable: true, flexibleSsl: false,
                claims: claims.map(path => ({ path, text: '', names: ['acme.example'], unsupported: [] })),
            },
        })

        it('writes the first vhost through an adopt with nothing to disable, and starts its hostnames verifying', async () => {
            agent.reply = request => request.verb === 'provision' ? CREATED
                : request.verb === 'domains' && request.args.action === 'preview' ? previewWith([])
                : WRITTEN
            const response = await request('/projects', { method: 'POST', actor: 'admin', body })
            assert.equal(response.status, 200)
            assert.deepEqual(await response.json(), { ...CREATED, vhost: { ok: true } })

            const [, preview, adopt] = agent.calls
            assert.ok(preview?.verb === 'domains' && preview.args.action === 'preview')
            assert.ok(adopt?.verb === 'domains' && adopt.args.action === 'adopt')
            assert.deepEqual(adopt.args.disable, [])
            // One token, the one the preview rendered, is what the adopt wrote and what the record holds
            assert.ok(preview.args.action === 'preview' && preview.args.token === adopt.args.token)
            const record = domains.forEnvironment('acme', 'live').find(entry => entry.hostname === 'acme.example')
            assert.deepEqual([record?.state, record?.token], ['pending', adopt.args.token])
        })

        it('leaves a hostname another file already serves for the operator to adopt, and still answers the create', async () => {
            agent.reply = request => request.verb === 'provision' ? CREATED : previewWith(['/etc/apache2/sites-enabled/acme.conf'])
            const response = await request('/projects', { method: 'POST', actor: 'admin', body })
            assert.equal(response.status, 200)
            const answer = await response.json() as { vhost: { ok: boolean, message: string } }
            assert.equal(answer.vhost.ok, false)
            assert.match(answer.vhost.message, /acme\.conf/)
            assert.deepEqual(agent.calls.map(call => call.verb === 'domains' ? call.args.action : call.verb), ['provision', 'preview'])
        })

        it('reports an Apache refusal beside the create rather than instead of it', async () => {
            agent.reply = request => request.verb === 'provision' ? CREATED
                : request.verb === 'domains' && request.args.action === 'preview' ? previewWith([])
                : { ok: false, code: 'failed', message: 'Apache refused the new configuration', output: 'Syntax error' }
            const response = await request('/projects', { method: 'POST', actor: 'admin', body })
            assert.equal(response.status, 200)
            assert.deepEqual((await response.json() as { vhost: unknown }).vhost, { ok: false, message: 'Apache refused the new configuration' })
            const record = domains.forEnvironment('acme', 'live').find(entry => entry.hostname === 'acme.example')
            assert.deepEqual(record?.vhost, { ok: false, output: 'Syntax error' })
        })

        it('reports a lost agent connection during the vhost step without failing the create', async () => {
            agent.call = async request => {
                agent.calls.push(request)
                if (request.verb === 'provision') return CREATED
                throw new AgentUnavailableError('the agent closed the connection without answering')
            }
            const response = await request('/projects', { method: 'POST', actor: 'admin', body })
            assert.equal(response.status, 200)
            assert.equal((await response.json() as { vhost: { ok: boolean } }).vhost.ok, false)
        })
    })

    it('refuses a body over the 64 KB cap without calling the agent', async () => {
        const response = await request('/projects', { method: 'POST', actor: 'admin', rawBody: 'x'.repeat(64 * 1024 + 1) })
        assert.equal(response.status, 400)
        const responseBody = await response.json() as { code: string }
        assert.equal(responseBody.code, 'bad-request')
        assert.deepEqual(agent.calls, [])
    })
})

describe('DELETE /projects/:id', () => {
    it('requires the project name typed back to delete, and refuses when it does not match', async () => {
        const wrongName = await request('/projects/acme', { method: 'DELETE', actor: 'admin', body: { name: 'Not Acme' } })
        assert.equal(wrongName.status, 400)
        assert.deepEqual(agent.calls, [])
        const [refusal] = await audit.read({ limit: 1 })
        assert.deepEqual([refusal?.verb, refusal?.target, refusal?.outcome, refusal?.reason], ['provision', 'acme remove', 'refused', 'bad-request'])

        agent.reply = () => ({ ok: true, output: '/var/www/acme was left in place, along with its volumes and databases' })
        const rightName = await request('/projects/acme', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(rightName.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'acme remove', 'ok'])
    })

    it('refuses a missing or malformed confirmation body without calling the agent', async () => {
        assert.equal((await request('/projects/acme', { method: 'DELETE', actor: 'admin' })).status, 400)
        assert.equal((await request('/projects/acme', { method: 'DELETE', actor: 'admin', body: {} })).status, 400)
        assert.equal((await request('/projects/acme', { method: 'DELETE', actor: 'admin', body: { name: 1 } })).status, 400)
        assert.deepEqual(agent.calls, [])
    })

    // quiet has no provision capability, which is every site the portal creates unless it was ticked
    it('removes a project without the provision capability', async () => {
        agent.reply = () => ({ ok: true, output: 'quiet was stopped and unregistered' })
        const response = await request('/projects/quiet', { method: 'DELETE', actor: 'admin', body: { name: 'Quiet' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'quiet', args: { action: 'remove', environment: null } }])
    })

    it('answers its owner 404 without calling the agent', async () => {
        const response = await request('/projects/acme', { method: 'DELETE', actor: 'client:cl_1', body: { name: 'Acme' } })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

// acme nested, the only shape an environment can be added to, with and without a uat1 beside live
const NESTED_ACME = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [provision, domains]
    environments:
      live: { dir: /var/www/acme/live, port: 5010, branch: main, domain: acme.example, certificate: letsencrypt }
`
const nestedWithUat1 = (domain: string | null): Registry => parseRegistry(
    `${NESTED_ACME}      uat1: { dir: /var/www/acme/uat1, port: 5020, branch: main${domain === null ? '' : `, domain: ${domain}`} }\n`,
)
const UAT1_WRITTEN: AgentReply = { ok: true, written: { hostnames: ['uat1.acme.example'], path: '/etc/apache2/hostd/acme-uat1.conf' } }
const EMPTY_PREVIEW: AgentReply = {
    ok: true,
    preview: { proposed: '<VirtualHost *:443>', extraNames: [], unreadable: [], adoptable: true, flexibleSsl: false, claims: [] },
}

// A handler whose registry moves the way the real one does: `from` until the refresh that follows an ok
// write, `to` after it, exactly as RegistryStore.refresh brings api's copy level in production.
function movingHandler(from: Registry, to: Registry) {
    let current = from
    return createHandler({
        token: TOKEN,
        registry: () => current,
        refreshRegistry: async () => { current = to; return true },
        agent, audit, schedules, domains, verifier, keepaliveMs: 60_000,
    })
}

function through(h: ReturnType<typeof createHandler>, path: string, options?: Parameters<typeof request>[1]) {
    const original = handler
    handler = h
    return request(path, options).finally(() => { handler = original })
}

describe('POST /projects/:id/environments', () => {
    it('adds a named environment through the agent', async () => {
        const provisionReply: AgentReply = { ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] }
        agent.reply = () => provisionReply
        const response = await request('/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), provisionReply)
        assert.deepEqual(agent.calls, [{
            verb: 'provision', project: 'acme',
            args: { action: 'add-environment', environment: 'uat1', branch: 'main', domain: null, certificate: null },
        }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'acme add-environment', 'ok'])
    })

    it('carries a certificate through when one is given', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] })
        await request('/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, certificate: 'letsencrypt' },
        })
        assert.equal((agent.calls[0] as { args: { certificate: unknown } }).args.certificate, 'letsencrypt')
    })

    it('refuses live, a reserved or invalid name, a missing name and an unknown field, without calling the agent', async () => {
        const bodies: unknown[] = [
            { name: 'live', branch: 'main', domain: null },
            { name: 'git', branch: 'main', domain: null },
            { name: 'backups', branch: 'main', domain: null },
            { name: 'uat-1', branch: 'main', domain: null },
            { branch: 'main', domain: null },
            { name: 'uat1', branch: 'main', domain: null, port: 5020 },
        ]
        for (const body of bodies) {
            const response = await request('/projects/acme/environments', { method: 'POST', actor: 'admin', body })
            assert.equal(response.status, 400, JSON.stringify(body))
        }
        assert.deepEqual(agent.calls, [])
    })

    it('writes the new environment\'s first vhost when it was given a domain, and starts its hostname verifying', async () => {
        const added: AgentReply = { ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] }
        agent.reply = sent => sent.verb === 'provision' ? added
            : sent.verb === 'domains' && sent.args.action === 'preview' ? EMPTY_PREVIEW
            : UAT1_WRITTEN
        const response = await through(movingHandler(parseRegistry(NESTED_ACME), nestedWithUat1('uat1.acme.example')), '/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: 'uat1.acme.example' },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ...added, vhost: { ok: true } })

        const [provision, preview, adopt] = agent.calls
        assert.deepEqual(provision, {
            verb: 'provision', project: 'acme',
            args: { action: 'add-environment', environment: 'uat1', branch: 'main', domain: 'uat1.acme.example', certificate: null },
        })
        assert.ok(preview?.verb === 'domains' && preview.args.action === 'preview' && preview.args.environment === 'uat1')
        assert.ok(adopt?.verb === 'domains' && adopt.args.action === 'adopt' && adopt.args.environment === 'uat1')
        assert.deepEqual(adopt.args.disable, [])
        const record = domains.forEnvironment('acme', 'uat1').find(entry => entry.hostname === 'uat1.acme.example')
        assert.deepEqual([record?.primary, record?.state, record?.token], [true, 'pending', adopt.args.token])
    })

    it('writes no vhost for an environment added without a domain', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] })
        await through(movingHandler(parseRegistry(NESTED_ACME), nestedWithUat1(null)), '/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null },
        })
        assert.deepEqual(agent.calls.map(call => call.verb), ['provision'])
    })

    it('writes no vhost when the agent refuses the add', async () => {
        agent.reply = () => ({ ok: false, code: 'bad-request', message: 'acme already has a uat1 environment' })
        const response = await request('/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: 'uat1.acme.example' },
        })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls.map(call => call.verb), ['provision'])
    })

    it('refuses a client actor without calling the agent', async () => {
        const response = await request('/projects/acme/environments', {
            method: 'POST', actor: 'client:cl_1', body: { name: 'uat1', branch: 'main', domain: 'uat1.acme.example' },
        })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

describe('DELETE /projects/:id/environments/:env', () => {
    it('requires the project name typed back, then deletes it into the trash as the user who asked', async () => {
        agent.reply = () => ({ ok: true, output: 'moved to the trash' })
        const wrongName = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'nope' } })
        assert.equal(wrongName.status, 400)
        const [refusal] = await audit.read({ limit: 1 })
        assert.deepEqual([refusal?.verb, refusal?.target, refusal?.outcome], ['provision', 'acme remove test', 'refused'])

        const response = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'acme', args: { action: 'delete-environment', environment: 'test', actor: 'user_1' } }])
    })

    it('drops the environment\'s domain verification records once the agent has deleted it, and only then', async () => {
        await seedDomains([
            domainRecord(),
            { ...newRecord('acme', 'test', 'test.acme.example', true, FIRST_SEEN), token: TOKEN_IN_PLACE },
        ])
        agent.reply = () => ({ ok: false, code: 'busy', message: 'acme test has a deploy running' })
        const refused = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(refused.status, 409)
        assert.equal(domains.forEnvironment('acme', 'test').length, 1)

        agent.reply = () => ({ ok: true, output: 'moved to the trash' })
        const response = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(domains.forEnvironment('acme', 'test'), [])
        assert.equal(domains.forEnvironment('acme', 'live').length, 1)
    })

    it('refuses live itself, without asking the agent', async () => {
        const response = await request('/projects/acme/environments/live', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 400)
        assert.equal((await response.json() as { code: string }).code, 'bad-request')
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'acme remove live', 'refused'])
    })
})

describe('deleted environments', () => {
    const deletedAt = '2026-09-23T10:00:00.000Z'

    it('matches the list and the restore, and nothing else under them', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/deleted-environments'), { verb: 'deleted-environments', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/deleted-environments'), { verb: 'method-not-allowed' })
        assert.deepEqual(
            matchRoute('POST', '/projects/acme/deleted-environments/uat1/restore'),
            { verb: 'restore-environment', project: 'acme', environment: 'uat1' },
        )
        assert.deepEqual(matchRoute('GET', '/projects/acme/deleted-environments/uat1/restore'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/deleted-environments/uat-1/restore'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/deleted-environments/uat1'), { verb: 'not-found' })
    })

    it('lists a project\'s deleted environments for the admin', async () => {
        const environments = [{ environment: 'uat1', deletedAt, purgeAt: '2026-10-23T10:00:00.000Z', branch: 'develop', domain: 'uat1.acme.example', aliases: [] }]
        agent.reply = () => ({ ok: true, environments })
        const response = await request('/projects/acme/deleted-environments', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, environments })
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'acme', args: { action: 'deleted-environments' } }])
    })

    it('restores one with a fresh token, and records its hostnames against that token', async () => {
        agent.reply = () => ({ ok: true, port: 5013, portChanged: false, droppedHostnames: [], warnings: [], vhost: true })
        const response = await request('/projects/acme/deleted-environments/test/restore', { method: 'POST', actor: 'admin', body: { deletedAt } })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, port: 5013, portChanged: false, droppedHostnames: [], warnings: [], vhost: true })

        const call = agent.calls[0]
        assert.ok(call && call.verb === 'provision' && call.args.action === 'restore-environment')
        assert.equal(call.args.environment, 'test')
        assert.equal(call.args.deletedAt, deletedAt)
        const token = call.args.token ?? ''
        assert.match(token, DOMAIN_TOKEN)

        const records = domains.forEnvironment('acme', 'test')
        assert.deepEqual(records.map(record => [record.hostname, record.state, record.token, record.primary]), [['test.acme.example', 'pending', token, true]])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'acme restore test', 'ok'])
    })

    it('records no hostnames when the agent wrote no vhost', async () => {
        agent.reply = () => ({ ok: true, port: 5013, portChanged: false, droppedHostnames: [], warnings: [], vhost: false })
        const response = await request('/projects/acme/deleted-environments/test/restore', { method: 'POST', actor: 'admin', body: { deletedAt } })
        assert.equal(response.status, 200)
        assert.ok(domains.forEnvironment('acme', 'test').every(record => record.token === null))
    })

    it('refuses a restore body without a deletedAt', async () => {
        const response = await request('/projects/acme/deleted-environments/test/restore', { method: 'POST', actor: 'admin', body: { when: 'now' } })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('passes a refused restore through', async () => {
        agent.reply = () => ({ ok: false, code: 'bad-request', message: 'acme already has a test environment again' })
        const response = await request('/projects/acme/deleted-environments/test/restore', { method: 'POST', actor: 'admin', body: { deletedAt } })
        assert.equal(response.status, 400)
        assert.deepEqual(domains.forEnvironment('acme', 'test'), [])
    })

    it('refuses a client every one of them, without asking the agent', async () => {
        const attempts = [
            () => request('/projects/acme/environments/test', { method: 'DELETE', body: { name: 'Acme' } }),
            () => request('/projects/acme/deleted-environments'),
            () => request('/projects/acme/deleted-environments/test/restore', { method: 'POST', body: { deletedAt } }),
        ]
        for (const attempt of attempts) assert.equal((await attempt()).status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

describe('GET /projects/:id/:env/env', () => {
    it('lists the environment\'s env files', async () => {
        const listReply: AgentReply = { ok: true, files: [{ path: '.env', example: null, bytes: 12 }] }
        agent.reply = () => listReply
        const response = await request('/projects/acme/live/env', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), listReply)
        assert.deepEqual(agent.calls, [{ verb: 'env', project: 'acme', args: { action: 'list', environment: 'live' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['env', 'live', 'ok'])
    })
})

describe('GET|PUT /projects/:id/:env/env/*path', () => {
    it('reads an env file and returns its text', async () => {
        agent.reply = () => ({ ok: true, text: 'SECRET=shh\n' })
        const response = await request('/projects/acme/live/env/.env', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, text: 'SECRET=shh\n' })
        assert.deepEqual(agent.calls, [{ verb: 'env', project: 'acme', args: { action: 'read', environment: 'live', path: '.env' } }])
        const [entry] = await audit.read({ limit: 1 })
        // The environment is part of the target, not just the path: live and test each have their own
        // .env, and the audit trail for secret access has to say which one.
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['env', 'live/.env', 'ok'])
    })

    it('passes an env write through with its path and text, and audits it without the text', async () => {
        agent.reply = () => ({ ok: true, output: '.env was written' })
        const response = await request('/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: { text: 'SECRET=shh' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: '.env', text: 'SECRET=shh' },
        }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['env', 'live/.env', 'ok'])
        const serialised = JSON.stringify(entry)
        assert.equal(serialised.includes('shh'), false)
        assert.equal(serialised.includes('SECRET'), false)
    })

    it('rejects an env path that cannot be a real env file, before the agent is called', async () => {
        // A literal .. segment can never arrive here: `new URL()` collapses ../ and even %2e%2e/ per
        // the URL Standard's dot-segment rule before matchRoute ever sees the path, for any request
        // built the normal way (fetch does this, and so does this handler's own `new URL(req.url, ...)`
        // for a raw request line). What envPathProblem is left to catch at this boundary is anything
        // that only looks like an escape once written out, such as a slash smuggled inside one segment.
        const response = await request('/projects/acme/live/env/..%2Fsecret.env', { actor: 'admin' })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('rejects a path with too many folders, before the agent is called', async () => {
        const response = await request('/projects/acme/live/env/a/b/c/d/e.env', { actor: 'admin' })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('refuses a malformed write body without calling the agent', async () => {
        assert.equal((await request('/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: {} })).status, 400)
        assert.equal((await request('/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: { text: 1 } })).status, 400)
        assert.equal((await request('/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: { text: 'x', extra: 1 } })).status, 400)
        assert.deepEqual(agent.calls, [])
    })

    // The 64 KB cap is on the whole JSON envelope, not the file text: MAX_ENV_BYTES (also 64 KB) bounds
    // the text alone, but wrapping it in {"text":"..."} pushes the envelope over its own cap first, so
    // this refuses before the agent, and before MAX_ENV_BYTES, ever gets a say.
    it('refuses a write whose JSON envelope is over the 64 KB cap, without calling the agent', async () => {
        const response = await request('/projects/acme/live/env/.env', {
            method: 'PUT', actor: 'admin', rawBody: `{"text":"${'x'.repeat(64 * 1024)}"}`,
        })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })
})

describe('deploy routes', () => {
    it('starts a deploy and audits it', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.verb, 'deploy')
        assert.equal(entry?.target, 'live deploy')
        assert.equal(entry?.outcome, 'ok')
    })

    it('starts a rollback', async () => {
        const response = await request('/projects/acme/test/rollback', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'deploy', project: 'acme', args: { action: 'rollback', environment: 'test' } }])
    })

    it('passes a branch switch through, and audits the branch rather than the whole body', async () => {
        const response = await request('/projects/acme/live/branch', { method: 'PUT', actor: 'admin', body: { branch: 'develop' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'deploy', project: 'acme', args: { action: 'set-branch', environment: 'live', branch: 'develop' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.target, 'live branch develop')
    })

    it('refuses a branch body that is missing, malformed or carries an unknown field', async () => {
        for (const body of [{}, { branch: 3 }, { branch: 'develop', force: true }]) {
            const response = await request('/projects/acme/live/branch', { method: 'PUT', actor: 'admin', body })
            assert.equal(response.status, 400, JSON.stringify(body))
        }
        assert.deepEqual(agent.calls, [])
    })

    it('lets a client read its own deploy history and commit list', async () => {
        agent.reply = request => request.verb === 'deploy' && request.args.action === 'history'
            ? { ok: true, environment: 'live', branch: 'main', deployed: 'abc1234', paused: false, consecutiveFailures: 0, deploys: [] }
            : { ok: true, commits: [] }

        const history = await request('/projects/acme/live/deploys')
        assert.equal(history.status, 200)
        assert.deepEqual(await history.json(), { ok: true, environment: 'live', branch: 'main', deployed: 'abc1234', paused: false, consecutiveFailures: 0, deploys: [] })

        const commits = await request('/projects/acme/live/commits?limit=5')
        assert.equal(commits.status, 200)
        assert.deepEqual(agent.calls[1], { verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: 5 } })
    })

    it('defaults the commit limit and refuses one that is not a small whole number', async () => {
        agent.reply = () => ({ ok: true, commits: [] })
        await request('/projects/acme/live/commits')
        assert.deepEqual(agent.calls[0], { verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: 30 } })
        for (const query of ['?limit=0', '?limit=1000', '?limit=all']) {
            const response = await request(`/projects/acme/live/commits${query}`)
            assert.equal(response.status, 400, query)
        }
        assert.equal(agent.calls.length, 1)
    })

    it('refuses a client the deploy, rollback and branch routes with a 404, and audits each refusal', async () => {
        const attempts = [
            () => request('/projects/acme/live/deploy', { method: 'POST' }),
            () => request('/projects/acme/live/rollback', { method: 'POST' }),
            () => request('/projects/acme/live/branch', { method: 'PUT', body: { branch: 'develop' } }),
        ]
        for (const attempt of attempts) {
            const response = await attempt()
            assert.equal(response.status, 404, await response.text())
        }
        assert.deepEqual(agent.calls, [])
        const events = await audit.read({ limit: attempts.length })
        assert.ok(events.every(event => event.outcome === 'refused' && event.reason === 'not-found'))
    })

    it('refuses the deploy routes for a project without the capability', async () => {
        const response = await request('/projects/quiet/live/deploys')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })

    // The route takes any environment name; whether the project has it is the agent's own structural
    // check, which answers unknown-environment and the api turns into a 404.
    it('reaches a named environment the project has, and answers 404 unknown-environment for one it lacks', async () => {
        const named = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [deploy]
    environments:
      live: { dir: /var/www/acme/live, port: 5010, branch: main }
      uat1: { dir: /var/www/acme/uat1, port: 5012, branch: develop }
`)
        handler = createHandler({
            token: TOKEN, registry: () => named, refreshRegistry: async () => false,
            agent, audit, schedules, domains, verifier, keepaliveMs: 60_000, fetch: probe.fetch,
        })
        agent.reply = request => {
            const checked = request.verb === 'deploy' ? checkStructure(named, request, new Map()) : null
            if (checked && !checked.ok) return checked
            return { ok: true, environment: 'uat1', branch: 'develop', deployed: null, paused: false, consecutiveFailures: 0, deploys: [] }
        }

        const found = await request('/projects/acme/uat1/deploys')
        assert.equal(found.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'deploy', project: 'acme', args: { action: 'history', environment: 'uat1' } }])

        const missing = await request('/projects/acme/staging/deploys')
        assert.equal(missing.status, 404)
        assert.equal((await missing.json() as { code?: string }).code, 'unknown-environment')
    })

    it('answers 503 when the agent cannot be reached, and audits the failure', async () => {
        agent.call = async () => { throw new AgentUnavailableError('the agent is not answering') }
        const response = await request('/projects/acme/live/deploy', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 503)
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.outcome, 'failed')
    })
})

const WRITTEN: AgentReply = { ok: true, written: { hostnames: ['acme.example'], path: '/etc/apache2/hostd/acme-live.conf' } }

describe('GET /projects/:id/:env/domains', () => {
    it('answers the primary first, with the environment\'s certificate mode joined on', async () => {
        await seedDomains([
            domainRecord({ hostname: 'www.acme.example', primary: false, state: 'pending', checkedAt: CHECKED_AT, error: 'No record exists yet.' }),
            domainRecord({ state: 'active', checkedAt: CHECKED_AT }),
        ])
        const response = await request('/projects/acme/live/domains')
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), {
            ok: true,
            domains: [
                { hostname: 'acme.example', primary: true, state: 'active', certificate: 'letsencrypt', checkedAt: CHECKED_AT, error: null, vhost: null },
                { hostname: 'www.acme.example', primary: false, state: 'pending', certificate: 'letsencrypt', checkedAt: CHECKED_AT, error: 'No record exists yet.', vhost: null },
            ],
        })
        assert.deepEqual(agent.calls, [])
    })

    it('keeps Apache\'s own words from the client and gives them to the operator', async () => {
        await seedDomains([domainRecord({ vhost: { ok: false, output: 'AH00526: Syntax error on line 12' } })])
        const mine = await (await request('/projects/acme/live/domains')).json() as { domains: Array<{ vhost: unknown }> }
        assert.deepEqual(mine.domains[0]?.vhost, { ok: false })
        const operator = await (await request('/projects/acme/live/domains', { actor: 'admin' })).json() as { domains: Array<{ vhost: unknown }> }
        assert.deepEqual(operator.domains[0]?.vhost, { ok: false, output: 'AH00526: Syntax error on line 12' })
    })

    // The token is the vhost's, and nothing outside hostd has any use for it.
    it('never answers the verification token, not even to the operator', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        const text = await (await request('/projects/acme/live/domains', { actor: 'admin' })).text()
        assert.equal(text.includes(TOKEN_IN_PLACE), false)
    })

    it('refuses a project without the domains capability, and another client\'s site', async () => {
        assert.equal((await request('/projects/quiet/live/domains')).status, 403)
        assert.equal((await request('/projects/other/live/domains')).status, 404)
    })
})

describe('POST /projects/:id/:env/domains', () => {
    it('sends the whole alias list with the environment\'s token, and records the new name pending', async () => {
        await seedDomains([
            domainRecord({ token: TOKEN_IN_PLACE, state: 'active' }),
            domainRecord({ hostname: 'www.acme.example', primary: false, token: TOKEN_IN_PLACE, state: 'active' }),
        ])
        agent.reply = () => WRITTEN
        const response = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'domains', project: 'acme',
            args: { action: 'set-aliases', environment: 'live', aliases: ['www.acme.example', 'shop.acme.example'], token: TOKEN_IN_PLACE },
        }])

        const added = domains.get(domainKey('acme', 'live', 'shop.acme.example'))
        assert.equal(added?.state, 'pending')
        // One token per environment, never one per hostname: the vhost carries a single token for the
        // primary and every alias, so an alias minted its own would fail against it forever.
        assert.equal(added?.token, TOKEN_IN_PLACE)
        // The names that were already proved keep the state they had; rewriting the vhost proves
        // nothing new about them.
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example'))?.state, 'active')

        const body = await response.json() as { domains: Array<{ hostname: string }> }
        assert.deepEqual(body.domains.map(domain => domain.hostname), ['acme.example', 'shop.acme.example', 'www.acme.example'])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'shop.acme.example', 'ok'])
    })

    it('mints one token for an environment that has none, and writes it onto every record of it', async () => {
        await seedDomains([domainRecord(), domainRecord({ hostname: 'www.acme.example', primary: false })])
        agent.reply = () => WRITTEN
        await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })

        const sent = agent.calls[0]
        const token = sent?.verb === 'domains' && sent.args.action === 'set-aliases' ? sent.args.token : ''
        assert.match(token, DOMAIN_TOKEN)
        for (const record of domains.forEnvironment('acme', 'live')) assert.equal(record.token, token, record.hostname)
    })

    it('refuses a hostname that is not one, or one the site already serves, without asking the agent', async () => {
        for (const hostname of ['not a host', 'https://acme.example', '', 'www.acme.example', 'acme.example']) {
            const response = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname } })
            assert.equal(response.status, 400, hostname)
        }
        const extra = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example', force: true } })
        assert.equal(extra.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    // The one thing that ever writes DomainRecord.vhost. Without it the design's rollback alarm, the
    // operator's "what Apache said" pane and needsYou's vhost branch are all unreachable code.
    it('records what Apache said about a write it refused, which is what raises the rollback alarm', async () => {
        await seedDomains([
            domainRecord({ token: TOKEN_IN_PLACE, state: 'active' }),
            domainRecord({ hostname: 'www.acme.example', primary: false, token: TOKEN_IN_PLACE, state: 'active' }),
        ])
        const health = agent.reply
        agent.reply = sent => sent.verb === 'domains'
            ? { ok: false, code: 'failed', message: 'Apache refused the new configuration for acme live', output: 'AH00526: Syntax error on line 9' }
            : health(sent)

        const response = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })
        assert.equal(response.status, 502)
        for (const record of domains.forEnvironment('acme', 'live')) {
            assert.deepEqual(record.vhost, { ok: false, output: 'AH00526: Syntax error on line 9' }, record.hostname)
        }

        // Once for the environment, not once per hostname of it.
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.deepEqual(body.warnings.filter(warning => warning.includes('rolled back')), ['the vhost for acme live was rolled back'])
    })

    it('clears it again once a write succeeds, so the alarm does not outlive the rollback', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE, vhost: { ok: false, output: 'AH00526' } })])
        const health = agent.reply
        agent.reply = sent => sent.verb === 'domains' ? WRITTEN : health(sent)
        await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example'))?.vhost, null)
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.deepEqual(body.warnings.filter(warning => warning.includes('rolled back')), [])
    })

    it('writes no record when the agent refuses, and audits the failure', async () => {
        agent.reply = () => ({ ok: false, code: 'failed', message: 'Apache refused the new configuration for acme live' })
        const response = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })
        assert.equal(response.status, 502)
        assert.equal(domains.get(domainKey('acme', 'live', 'shop.acme.example')), undefined)
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'shop.acme.example', 'failed'])
    })
})

describe('POST /projects/:id/:env/domains, on an environment with no primary yet', () => {
    const CONFIGURED: AgentReply = { ok: true, written: [], output: 'acme\'s registry entry was updated' }

    it('makes the first hostname its primary through configure, then writes its vhost and records it as primary', async () => {
        agent.reply = sent => sent.verb === 'configure' ? CONFIGURED
            : sent.verb === 'domains' && sent.args.action === 'preview' ? EMPTY_PREVIEW
            : UAT1_WRITTEN
        const response = await through(movingHandler(nestedWithUat1(null), nestedWithUat1('uat1.acme.example')), '/projects/acme/uat1/domains', {
            method: 'POST', actor: 'admin', body: { hostname: 'uat1.acme.example' },
        })
        assert.equal(response.status, 200)

        const [configure, preview, adopt] = agent.calls
        assert.deepEqual(configure, { verb: 'configure', project: 'acme', args: { domains: { uat1: 'uat1.acme.example' } } })
        assert.ok(preview?.verb === 'domains' && preview.args.action === 'preview' && preview.args.environment === 'uat1')
        assert.ok(adopt?.verb === 'domains' && adopt.args.action === 'adopt' && adopt.args.environment === 'uat1')
        assert.equal(agent.calls.length, 3)

        const record = domains.get(domainKey('acme', 'uat1', 'uat1.acme.example'))
        assert.deepEqual([record?.primary, record?.state, record?.token], [true, 'pending', adopt.args.token])
        const body = await response.json() as { ok: boolean, domains: Array<{ hostname: string, primary: boolean }>, vhost: unknown }
        assert.equal(body.ok, true)
        assert.deepEqual(body.domains.map(domain => [domain.hostname, domain.primary]), [['uat1.acme.example', true]])
        assert.deepEqual(body.vhost, { ok: true })
    })

    it('adds a second hostname as an alias, the way it always has', async () => {
        await seedDomains([{ ...newRecord('acme', 'uat1', 'uat1.acme.example', true, FIRST_SEEN), token: TOKEN_IN_PLACE, state: 'active' }])
        agent.reply = () => UAT1_WRITTEN
        const withPrimary = nestedWithUat1('uat1.acme.example')
        const response = await through(movingHandler(withPrimary, withPrimary), '/projects/acme/uat1/domains', {
            method: 'POST', actor: 'admin', body: { hostname: 'www.uat1.acme.example' },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'domains', project: 'acme',
            args: { action: 'set-aliases', environment: 'uat1', aliases: ['www.uat1.acme.example'], token: TOKEN_IN_PLACE },
        }])
        assert.equal(domains.get(domainKey('acme', 'uat1', 'www.uat1.acme.example'))?.primary, false)
    })

    it('writes no vhost and no record when configure refuses the hostname', async () => {
        agent.reply = () => ({ ok: false, code: 'bad-request', message: 'uat1.acme.example is already used by another project' })
        const response = await through(movingHandler(nestedWithUat1(null), nestedWithUat1(null)), '/projects/acme/uat1/domains', {
            method: 'POST', actor: 'admin', body: { hostname: 'uat1.acme.example' },
        })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls.map(call => call.verb), ['configure'])
        assert.equal(domains.get(domainKey('acme', 'uat1', 'uat1.acme.example')), undefined)
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'uat1.acme.example', 'refused'])
    })
})

describe('DELETE /projects/:id/:env/domains/:hostname', () => {
    it('refuses the primary outright, because the only way out of it is removing the environment', async () => {
        const response = await request('/projects/acme/live/domains/acme.example', { method: 'DELETE', actor: 'admin' })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'acme.example', 'refused'])
    })

    it('sends the list without that name and drops its record', async () => {
        await seedDomains([
            domainRecord({ token: TOKEN_IN_PLACE, state: 'active' }),
            domainRecord({ hostname: 'www.acme.example', primary: false, token: TOKEN_IN_PLACE, state: 'active' }),
        ])
        agent.reply = () => WRITTEN
        const response = await request('/projects/acme/live/domains/www.acme.example', { method: 'DELETE', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'domains', project: 'acme',
            args: { action: 'set-aliases', environment: 'live', aliases: [], token: TOKEN_IN_PLACE },
        }])
        assert.equal(domains.get(domainKey('acme', 'live', 'www.acme.example')), undefined)
        const body = await response.json() as { domains: Array<{ hostname: string }> }
        assert.deepEqual(body.domains.map(domain => domain.hostname), ['acme.example'])
    })

    it('answers 404 for a hostname this environment does not serve', async () => {
        const response = await request('/projects/acme/live/domains/elsewhere.example', { method: 'DELETE', actor: 'admin' })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

describe('PUT /projects/:id/settings', () => {
    it('routes a settings write, and allows only PUT there', () => {
        assert.deepEqual(matchRoute('PUT', '/projects/acme/settings'), { verb: 'settings', project: 'acme' })
        assert.equal(matchRoute('GET', '/projects/acme/settings').verb, 'method-not-allowed')
    })

    it('refuses a body with a field it does not recognise, without calling the agent', async () => {
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { nonsense: 1 } })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('refuses capabilities that is not a list of strings', async () => {
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { capabilities: 'lifecycle' } })
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('refuses a branch keyed by something that is not an environment of this project, naming it', async () => {
        for (const body of [{ branches: { staging: 'main' } }, { branches: { 'uat-1': 'main' } }, { domains: { uat1: 'uat.acme.example' } }, { websockets: { staging: true } }]) {
            const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body })
            assert.equal(response.status, 400, JSON.stringify(body))
            const answer = await response.json() as { message: string }
            assert.match(answer.message, new RegExp(Object.keys(Object.values(body)[0]!)[0]!), JSON.stringify(body))
        }
        assert.deepEqual(agent.calls, [])
    })

    it('carries capabilities, repo and branches through to the agent, with repo: null included rather than dropped', async () => {
        agent.reply = () => ({ ok: true, output: 'configured' })
        const settingsBody = { capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main' } }
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body: settingsBody })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'configure', project: 'acme', args: settingsBody }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['configure', 'settings', 'ok'])
    })

    // configure is in ADMIN_ONLY, so a client gets the same 404 every other admin-only route gives,
    // not a 403: that is what makes a client's attempt indistinguishable from a project that is not theirs.
    it('refuses a client with a 404, and never calls the agent', async () => {
        const response = await request('/projects/acme/settings', { method: 'PUT', body: { repo: 'git@example.com:acme/site.git' } })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

// Moving an environment's primary address goes through configure, and what the operator sees afterwards
// depends on something only the agent knows: whether hostd owns the vhost behind that environment. The
// reply carries it, and these are the two answers it can carry.
describe('PUT /projects/:id/settings, when the address moved', () => {
    const VHOST = '/etc/apache2/hostd/acme-live.conf'

    // acme live as the registry has it once the move has landed. api re-reads the registry before any of
    // the bookkeeping below, so this is what reconcile and the records are decided against.
    const movedRegistry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    capabilities: [domains]
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: shop.acme.example, aliases: [www.acme.example] }
`)

    // The same move on an environment with one address and nothing else, which is the shape every site on
    // this machine is in today. It is worth its own registry because it is the case where the address
    // that moved away held the ONLY copy of the environment's token: anything that reads the token after
    // reconcile has deleted that record finds nothing at all.
    const primaryOnlyRegistry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    capabilities: [domains]
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: shop.acme.example }
`)

    // A handler whose registry moves the way the real one does: the refresh that follows an ok configure
    // is what brings it level, exactly as RegistryStore.refresh does in production.
    function movedHandler(to: Registry) {
        let live = registry
        return createHandler({
            token: TOKEN,
            registry: () => live,
            refreshRegistry: async () => { live = to; return true },
            agent, audit, schedules, domains, verifier, keepaliveMs: 60_000,
        })
    }

    function via(h: ReturnType<typeof createHandler>, path: string, options?: Parameters<typeof request>[1]) {
        const original = handler
        handler = h
        return request(path, options).finally(() => { handler = original })
    }

    // The environment as it was: hostd serving it, every name proved and carrying the one token its vhost
    // renders. The aliases are named at each call site rather than baked in with a default, because a
    // helper that always seeds one means no test in this file can ever exercise an environment without
    // one, and that is the shape all five live sites are in. A default of "one alias" would hide exactly
    // the case worth testing; spelling it out makes each test say which shape it is about.
    const seedServed = (aliases: string[]) => seedDomains([
        domainRecord({ hostname: 'acme.example', primary: true, state: 'active', token: TOKEN_IN_PLACE }),
        ...aliases.map(hostname => domainRecord({ hostname, primary: false, state: 'active', token: TOKEN_IN_PLACE })),
    ])

    const move = (h: ReturnType<typeof createHandler>) =>
        via(h, '/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { domains: { live: 'shop.acme.example' } } })

    it('leaves the new hostname pending, with the token that vhost already carried', async () => {
        await seedServed(['www.acme.example'])
        agent.reply = () => ({
            ok: true,
            output: 'done',
            written: [{ environment: 'live', hostnames: ['shop.acme.example', 'www.acme.example'], path: VHOST }],
        })

        assert.equal((await move(movedHandler(movedRegistry))).status, 200)

        const moved = domains.get(domainKey('acme', 'live', 'shop.acme.example'))
        // pending and not unmanaged: hostd serves this name from a file it wrote a moment ago, and
        // unmanaged would say the opposite.
        assert.equal(moved?.state, 'pending')
        assert.equal(moved?.primary, true)
        // The token already in the vhost, never a fresh one: the rewrite kept it, so a new one would be
        // probing for a value Apache does not serve.
        assert.equal(moved?.token, TOKEN_IN_PLACE)
        // And that is what makes "Check again" mean something: the verifier schedules this record.
        assert.notEqual(nextCheckAt(moved!), null)

        // The poll comes round every ten seconds and must not undo any of it. reconcile only adds what
        // the registry names and deletes what it does not, so a record that already exists is left
        // exactly as the route left it. Asserted rather than assumed, because the whole answer above
        // would quietly revert to unmanaged ten seconds later if it were not true.
        await domains.reconcile(movedRegistry, '2026-09-22T00:00:00.000Z')
        const after = domains.get(domainKey('acme', 'live', 'shop.acme.example'))
        assert.equal(after?.state, 'pending')
        assert.equal(after?.token, TOKEN_IN_PLACE)
    })

    it('takes the old address away and leaves the aliases alone', async () => {
        await seedServed(['www.acme.example'])
        agent.reply = () => ({
            ok: true,
            output: 'done',
            written: [{ environment: 'live', hostnames: ['shop.acme.example', 'www.acme.example'], path: VHOST }],
        })

        assert.equal((await move(movedHandler(movedRegistry))).status, 200)

        // reconcile's own work, run here rather than waited for: the registry no longer names it.
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example')), undefined)
        // The alias never stopped answering and the token did not change, so it has nothing to prove
        // again. Putting it back to pending would start a 72 hour clock for a name that is working.
        assert.equal(domains.get(domainKey('acme', 'live', 'www.acme.example'))?.state, 'active')
    })

    // The shape every site on this machine is in: one address and no aliases. The record for the address
    // that moved away was the only place this environment's token lived, so reading it after reconcile
    // has deleted that record finds nothing and leaves the moved hostname unmanaged forever. Read it
    // first and it is there. Nothing about this test is exotic; it is the ordinary case.
    it('keeps the token when the address that moved away was the only record holding it', async () => {
        await seedServed([])
        agent.reply = () => ({
            ok: true,
            output: 'done',
            written: [{ environment: 'live', hostnames: ['shop.acme.example'], path: VHOST }],
        })

        assert.equal((await move(movedHandler(primaryOnlyRegistry))).status, 200)

        const moved = domains.get(domainKey('acme', 'live', 'shop.acme.example'))
        assert.equal(moved?.state, 'pending')
        assert.equal(moved?.token, TOKEN_IN_PLACE)
        assert.notEqual(nextCheckAt(moved!), null)
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example')), undefined)
    })

    it('leaves the new hostname unmanaged when hostd serves no vhost for that environment', async () => {
        await seedServed(['www.acme.example'])
        // The agent rewrote nothing, because there was no file of its own to rewrite. The site is still
        // served by a hand-written vhost, and unmanaged is exactly what that means.
        agent.reply = () => ({ ok: true, output: 'done', written: [] })

        assert.equal((await move(movedHandler(movedRegistry))).status, 200)

        const moved = domains.get(domainKey('acme', 'live', 'shop.acme.example'))
        assert.equal(moved?.state, 'unmanaged')
        assert.equal(moved?.token, null)
        // Nothing to re-check, and the tab says so rather than offering a button that does nothing.
        assert.equal(nextCheckAt(moved!), null)
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example')), undefined)
    })
})

describe('POST /projects/:id/:env/domains/:hostname/verify', () => {
    it('forces one check and answers the record it left behind', async () => {
        await seedDomains([domainRecord({ hostname: 'www.acme.example', primary: false, state: 'pending', token: TOKEN_IN_PLACE })])
        const response = await request('/projects/acme/live/domains/www.acme.example/verify', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(verifier.checked, [domainKey('acme', 'live', 'www.acme.example')])
        assert.deepEqual(await response.json(), {
            ok: true,
            domain: { hostname: 'www.acme.example', primary: false, state: 'active', certificate: 'letsencrypt', checkedAt: CHECKED_AT, error: null, vhost: null },
        })
        // Nothing is written to the host to check a name, so the agent hears nothing about it.
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome, entry?.output], ['domains', 'www.acme.example', 'ok', 'active'])
    })

    it('answers 404 for a hostname with no record of its own', async () => {
        const response = await request('/projects/acme/live/domains/elsewhere.example/verify', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 404)
        assert.deepEqual(verifier.checked, [])
    })
})

describe('GET|POST /projects/:id/:env/adopt', () => {
    const claim: { path: string, text: string, names: string[], unsupported: string[] } = {
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: '<VirtualHost *:443>\n    ServerName acme.example\n</VirtualHost>\n',
        names: ['acme.example'],
        unsupported: [],
    }
    const preview = (over: Partial<{ claims: typeof claim[], adoptable: boolean }> = {}): AgentReply => ({
        ok: true,
        preview: { proposed: '<VirtualHost *:443>', claims: over.claims ?? [claim], extraNames: [], unreadable: [], adoptable: over.adoptable ?? true, flexibleSsl: false },
    })

    it('previews with the token adopt will write, so the file shown is the file written', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = () => preview()
        const response = await request('/projects/acme/live/adopt', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), preview())
        assert.deepEqual(agent.calls, [{
            verb: 'domains', project: 'acme', args: { action: 'preview', environment: 'live', token: TOKEN_IN_PLACE },
        }])
    })

    // The case that matters: all five live sites begin with no token at all, so this is the first
    // adoption of each of them. A token minted for the preview and thrown away meant the file the
    // operator read and confirmed differed from the file that was written, in every line carrying it.
    it('persists a token it mints, so a first preview and the adopt that follows show one file', async () => {
        await seedDomains([domainRecord(), domainRecord({ hostname: 'www.acme.example', primary: false })])
        const tokenOf = (sent: AgentRequest | undefined): string =>
            sent?.verb === 'domains' && 'token' in sent.args ? sent.args.token : ''

        agent.reply = () => preview()
        await request('/projects/acme/live/adopt', { actor: 'admin' })
        const previewed = tokenOf(agent.calls[0])
        assert.match(previewed, DOMAIN_TOKEN)
        // Written to every record of the environment on the way out, which is what the second call reads.
        for (const record of domains.forEnvironment('acme', 'live')) assert.equal(record.token, previewed, record.hostname)

        await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })
        assert.equal(tokenOf(agent.calls[1]), previewed, 'the adopt previewed a different file from the one it wrote')
        assert.equal(tokenOf(agent.calls[2]), previewed)
    })

    it('refuses to adopt without the project\'s name typed back, and never its id', async () => {
        for (const confirm of ['acme', 'Acme Bakery', '']) {
            const response = await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm } })
            assert.equal(response.status, 400, confirm)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('disables the files the preview found and starts every hostname pending', async () => {
        await seedDomains([
            domainRecord({ token: TOKEN_IN_PLACE }),
            domainRecord({ hostname: 'www.acme.example', primary: false, token: TOKEN_IN_PLACE }),
        ])
        agent.reply = request => request.verb === 'domains' && request.args.action === 'preview'
            ? preview()
            : { ok: true, written: { hostnames: ['acme.example', 'www.acme.example'], path: '/etc/apache2/hostd/acme-live.conf' } }

        const response = await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls[1], {
            verb: 'domains', project: 'acme',
            args: { action: 'adopt', environment: 'live', token: TOKEN_IN_PLACE, disable: [claim.path] },
        })
        for (const record of domains.forEnvironment('acme', 'live')) {
            assert.equal(record.state, 'pending', record.hostname)
            // The 72 hour clock starts now, not when the registry first named the hostname: a record
            // the registry has named for days would otherwise fail on its very first check.
            assert.notEqual(record.firstSeenAt, FIRST_SEEN)
        }
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'acme.example', 'ok'])
    })

    // Adopt is the only route to a vhost hostd owns, so an environment nobody hand-wrote a file for has
    // to be able to take it: otherwise a newly provisioned site keeps its registry domain and never gets
    // a vhost at all.
    it('adopts an environment nothing claims, disabling nothing', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = request => request.verb === 'domains' && request.args.action === 'preview' ? preview({ claims: [] }) : WRITTEN
        const response = await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls[1], {
            verb: 'domains', project: 'acme',
            args: { action: 'adopt', environment: 'live', token: TOKEN_IN_PLACE, disable: [] },
        })
        assert.equal(domains.get(domainKey('acme', 'live', 'acme.example'))?.state, 'pending')
    })

    it('refuses when a claim cannot be read, naming the file', async () => {
        agent.reply = () => preview({ claims: [{ ...claim, unsupported: ['an IncludeOptional this parser cannot follow'] }], adoptable: false })
        const unreadable = await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })
        assert.equal(unreadable.status, 400)
        assert.equal((await unreadable.json() as { message: string }).message.includes(claim.path), true)
        // The preview, and never the adopt that would have moved a file.
        assert.equal(agent.calls.length, 1)
        // And nothing was asked of the hostname, because nothing was going to be replaced.
        assert.deepEqual(probe.calls, [])
    })
})

// The outage this was built for: adopting thebackroom.dev passed apache2ctl configtest, reloaded
// cleanly, was reported a success by every layer that was watching, and took the site off the internet
// until the operator noticed. The rail cannot see that and neither can the agent, which runs
// network_mode: none; api is the process with a network, so api asks the hostname.
describe('POST /projects/:id/:env/adopt: did the site survive it', () => {
    const claim: { path: string, text: string, names: string[], unsupported: string[] } = {
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: '<VirtualHost *:80>\n    ServerName acme.example\n</VirtualHost>\n',
        names: ['acme.example'],
        unsupported: [],
    }
    const adoptReply: AgentReply = { ok: true, written: { hostnames: ['acme.example'], path: '/etc/apache2/hostd/acme-live.conf' } }
    const replies = (over: { claims?: typeof claim[] } = {}): typeof agent.reply => request => {
        if (request.verb !== 'domains') return { ok: true, output: 'done' }
        if (request.args.action === 'preview') {
            return {
                ok: true,
                preview: {
                    proposed: '<VirtualHost *:443>', claims: over.claims ?? [claim],
                    extraNames: [], unreadable: [], adoptable: true, flexibleSsl: false,
                },
            }
        }
        return adoptReply
    }

    const adoptRequest = () => request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })

    it('takes a baseline before the vhost is replaced, and asks again after', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = replies()
        const response = await adoptRequest()
        assert.equal(response.status, 200)
        // Twice, both at the primary, over https, the way a visitor reaches it.
        assert.deepEqual(probe.calls, ['https://acme.example/', 'https://acme.example/'])
        // No rollback: the agent heard the preview and the adopt and nothing else.
        assert.equal(agent.calls.length, 2)
    })

    it('rolls back when a page became a redirect, which is what the outage looked like', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = replies()
        probe.answers = [200, 301]

        const response = await adoptRequest()
        assert.equal(response.status, 502)
        // The agent is asked to put the operator's own file back, naming the same path adopt disabled.
        assert.deepEqual(agent.calls[2], {
            verb: 'domains', project: 'acme',
            args: { action: 'restore', environment: 'live', restore: [claim.path] },
        })
        const said = (await response.json() as { message: string }).message
        assert.match(said, /answered 200/)
        assert.match(said, /answered 301/)
        assert.match(said, /acme\.conf/)
    })

    it('does not start a verification countdown against a vhost it just removed', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE, state: 'unmanaged' })])
        agent.reply = replies()
        probe.answers = [200, 503]

        await adoptRequest()
        const record = domains.get(domainKey('acme', 'live', 'acme.example'))!
        assert.equal(record.state, 'unmanaged', 'a rolled-back adoption wrote no vhost to prove anything against')
        // The operator has to go and look at this one, which is what needsYou reads in the portal.
        assert.equal(record.vhost?.ok, false)
    })

    it('audits the rollback as a failure rather than as an adoption', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = replies()
        probe.answers = [200, new Error('socket hang up')]

        await adoptRequest()
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.outcome, 'failed')
        assert.match(entry?.reason ?? '', /stopped answering as it had/)
    })

    it('says so plainly when putting the file back did not work either', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        const base = replies()
        agent.reply = request => {
            if (request.verb === 'domains' && request.args.action === 'restore') {
                return { ok: false, code: 'failed', message: 'Apache would not reload', output: 'AH00526' }
            }
            return base(request)
        }
        probe.answers = [200, 301]

        const response = await adoptRequest()
        assert.equal(response.status, 502)
        assert.match((await response.json() as { message: string }).message, /Apache would not reload/)
    })

    // Adoption is how an operator fixes a site that is already down. A baseline of "did not answer" has
    // nothing below it to fall to, so this can never be the thing standing in their way.
    it('lets an adoption of an already broken site through, however it comes out', async () => {
        for (const after of [200, 301, 500, new Error('ENOTFOUND')]) {
            await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
            agent.reply = replies()
            probe.answers = [new Error('getaddrinfo ENOTFOUND acme.example'), after]
            const response = await adoptRequest()
            assert.equal(response.status, 200, String(after))
        }
    })

    // With no hand-written file to put back, the only rollback available is to leave the hostname with
    // no vhost at all, which is worse than whatever the probe would have complained about.
    it('does not check an environment that had nothing to displace', async () => {
        await seedDomains([domainRecord({ token: TOKEN_IN_PLACE })])
        agent.reply = replies({ claims: [] })
        probe.answers = [200, 500]

        const response = await adoptRequest()
        assert.equal(response.status, 200)
        assert.deepEqual(probe.calls, [])
        assert.equal(agent.calls.length, 2)
    })
})

describe('the domain routes a client may not use', () => {
    it('answers 404 for every one of them, and audits the refusal', async () => {
        const attempts = [
            () => request('/projects/acme/live/domains', { method: 'POST', body: { hostname: 'shop.acme.example' } }),
            () => request('/projects/acme/live/domains/www.acme.example', { method: 'DELETE' }),
            () => request('/projects/acme/live/domains/www.acme.example/verify', { method: 'POST' }),
            () => request('/projects/acme/live/adopt'),
            () => request('/projects/acme/live/adopt', { method: 'POST', body: { confirm: 'Acme' } }),
        ]
        for (const attempt of attempts) {
            const response = await attempt()
            assert.equal(response.status, 404, await response.text())
        }
        assert.deepEqual(agent.calls, [])
        assert.deepEqual(verifier.checked, [])
        const events = await audit.read({ limit: attempts.length })
        assert.equal(events.length, attempts.length)
        assert.ok(events.every(event => event.outcome === 'refused' && event.reason === 'not-found'))
    })
})

describe('GET /health: what only health can see', () => {
    it('names a hostname that stopped answering and a vhost that was rolled back', async () => {
        await seedDomains([
            domainRecord({ state: 'broken' }),
            domainRecord({ hostname: 'www.acme.example', primary: false, vhost: { ok: false, output: 'AH00526' } }),
        ])
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.ok(body.warnings.some(warning => warning === 'acme.example stopped answering (acme live)'), body.warnings.join('; '))
        assert.ok(body.warnings.some(warning => warning === 'the vhost for acme live was rolled back'), body.warnings.join('; '))
    })

    // Said once, naming the environments, rather than once per hostname.
    it('names an environment waiting for Let\'s Encrypt once, however many hostnames it has', async () => {
        await seedDomains([domainRecord(), domainRecord({ hostname: 'www.acme.example', primary: false })])
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.deepEqual(body.warnings.filter(warning => warning.includes('Let\'s Encrypt')), ['waiting for Let\'s Encrypt support: acme live'])
    })

    // The warning that matters most: with the unit dead, every domain action hangs for 30 seconds
    // rather than failing, and nothing else says so before somebody tries one.
    it('warns when the Apache host unit has never answered, or has gone quiet', async () => {
        const railWarning = 'the Apache host unit has not answered; no domain change can take effect'
        for (const railAge of [null, 11 * 60_000]) {
            agent.reply = () => ({ ok: true, warnings: [], invalid: {}, system: usage, railAge })
            const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
            assert.ok(body.warnings.includes(railWarning), String(railAge))
        }
        agent.reply = () => ({ ok: true, warnings: [], invalid: {}, system: usage, railAge: 9 * 60_000 })
        const fresh = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.equal(fresh.warnings.includes(railWarning), false)
    })

    // The same warning again, but fed by the real ApacheRail rather than by a number this test chose:
    // both ends of the figure at once, which is the only place the timestamp-for-an-age mismatch that
    // kept this alarm permanently on could ever have been caught.
    it('does not warn one second after a real handshake, and does warn ten minutes later', async () => {
        const railWarning = 'the Apache host unit has not answered; no domain change can take effect'
        // A real epoch, which is exactly the value that used to make every reading look stale.
        let clock = 1_790_000_000_000
        const files = new Map<string, string>()
        const railFs: RailFs = {
            async writeFile(path, text) { files.set(path, text) },
            async rename(from, to) {
                const text = files.get(from)!
                files.delete(from)
                files.set(to, text)
                // The host unit, answering the request it was just handed.
                if (to.endsWith('request.json')) {
                    files.set('/rail/result.json', JSON.stringify({ seq: JSON.parse(text).seq, ok: true, output: 'Syntax OK' }))
                    files.delete(to)
                }
            },
            async readFile(path) {
                const text = files.get(path)
                if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
                return text
            },
            async unlink(path) { files.delete(path) },
        }
        const rail = new ApacheRail('/rail', railFs, { now: () => clock, sleep: async ms => { clock += ms } })
        agent.reply = () => ({ ok: true, warnings: [], invalid: {}, system: usage, railAge: rail.ageOfLastSuccess() })

        const never = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.ok(never.warnings.includes(railWarning), 'a rail that has never been answered is not healthy')

        await rail.send('reload', { write: null, remove: [], disable: [] })
        clock += 1_000
        const fresh = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.equal(fresh.warnings.includes(railWarning), false, fresh.warnings.join('; '))

        clock += RAIL_STALE_MS
        const stale = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.ok(stale.warnings.includes(railWarning), stale.warnings.join('; '))
    })

    it('keeps the agent\'s own warnings alongside them', async () => {
        agent.reply = () => ({ ok: true, warnings: ['the registry could not be re-read'], invalid: {}, system: usage, railAge: 1_000 })
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.equal(body.warnings[0], 'the registry could not be re-read')
    })
})

describe('GET /projects/:id/branches', () => {
    it('routes a branches read, project level rather than under an environment, and allows only GET there', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/branches'), { verb: 'branches', project: 'acme' })
        assert.equal(matchRoute('PUT', '/projects/acme/branches').verb, 'method-not-allowed')
    })

    it('asks the agent and answers its branch list', async () => {
        agent.reply = () => ({ ok: true, branches: ['main', 'develop'] })
        const response = await request('/projects/acme/branches', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, branches: ['main', 'develop'] })
        assert.deepEqual(agent.calls, [{ verb: 'branches', project: 'acme' }])
    })

    // Reusing 'configure' rather than a new policy verb: the list exists to fill the Settings form, which
    // is admin-only end to end, and configure is already the null-capability, admin-only verb this needs.
    it('refuses a client with a 404, the same as settings, and never calls the agent', async () => {
        const response = await request('/projects/acme/branches')
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })

    it('passes the agent\'s refusal through, mapped by its code', async () => {
        agent.reply = () => ({ ok: false, code: 'bad-request', message: 'acme has no repo to list branches from' })
        const response = await request('/projects/acme/branches', { actor: 'admin' })
        assert.equal(response.status, 400)
        const body = await response.json() as { message: string }
        assert.equal(body.message, 'acme has no repo to list branches from')
    })

    it('answers 503 when the agent cannot be reached', async () => {
        agent.call = async () => { throw new AgentUnavailableError('the agent is not answering') }
        const response = await request('/projects/acme/branches', { actor: 'admin' })
        assert.equal(response.status, 503)
    })
})

// api answers a write from its own in-memory copy of the registry, which otherwise only catches up on
// its own ten second poll. For a write that changed the file synchronously, that means an operator's own
// save can look like it did nothing for up to ten seconds. These tests stand in a RegistryStore with a
// refreshRegistry() that swaps in a second parsed registry, so "the read after the write sees the change"
// can be told apart from "some refresh function was called": the assertion is always what a request made
// after the write actually sees, not the call count on its own.
describe('registry refresh after a write', () => {
    const updatedRegistry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env, deploy, backups]
    environments:
      live: { dir: /var/www/acme, port: 5010, branch: main, domain: acme.example, certificate: letsencrypt, deployed: abc1234 }
      test: { dir: /var/www/acme-test, port: 5013, branch: develop, domain: test.acme.example }
`)

    // A fresh handler per test, wired to its own mutable "live" registry and its own count of
    // refreshRegistry calls, standing in for the RegistryStore api actually holds.
    function refreshableHandler() {
        let live = registry
        let calls = 0
        const h = createHandler({
            token: TOKEN,
            registry: () => live,
            refreshRegistry: async () => { calls++; live = updatedRegistry; return true },
            agent, audit, domains, verifier, keepaliveMs: 60_000,
        })
        return { handler: h, calls: () => calls }
    }

    function requestVia(h: ReturnType<typeof createHandler>, path: string, options?: Parameters<typeof request>[1]) {
        const original = handler
        handler = h
        return request(path, options).finally(() => { handler = original })
    }

    it('a settings write refreshes before answering, so the very next read sees it', async () => {
        agent.reply = () => ({ ok: true, output: 'configured' })
        const { handler: h, calls } = refreshableHandler()

        const write = await requestVia(h, '/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { capabilities: ['lifecycle'] } })
        assert.equal(write.status, 200)
        assert.equal(calls(), 1)

        const listBody = await (await requestVia(h, '/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, capabilities: string[] }> }
        const acme = listBody.projects.find(p => p.id === 'acme')
        assert.deepEqual(acme?.capabilities, ['lifecycle', 'logs', 'provision', 'env', 'deploy', 'backups'])
    })

    it('a provisioning write (create) refreshes before answering', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'newsite', state: 'needs-setup' }, envFiles: [] })
        const { handler: h, calls } = refreshableHandler()

        const response = await requestVia(h, '/projects', { method: 'POST', actor: 'admin', body: CREATE_BODY })
        assert.equal(response.status, 200)
        assert.equal(calls(), 1)
    })

    it('a delete (also provision) refreshes before answering', async () => {
        agent.reply = () => ({ ok: true, output: 'unregistered' })
        const { handler: h, calls } = refreshableHandler()

        const response = await requestVia(h, '/projects/acme', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 200)
        assert.equal(calls(), 1)
    })

    it('a branch switch refreshes before answering, even though it shares deploy\'s audit verb', async () => {
        agent.reply = () => ({ ok: true, output: 'live now tracks develop' })
        const { handler: h, calls } = refreshableHandler()

        const response = await requestVia(h, '/projects/acme/live/branch', { method: 'PUT', actor: 'admin', body: { branch: 'develop' } })
        assert.equal(response.status, 200)
        assert.equal(calls(), 1)
    })

    it('starting a deploy does not refresh: it answers before the registry write, which lands minutes later', async () => {
        const { handler: h, calls } = refreshableHandler()
        const response = await requestVia(h, '/projects/acme/live/deploy', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.equal(calls(), 0)
    })

    it('starting a rollback does not refresh, for the same reason as a deploy', async () => {
        const { handler: h, calls } = refreshableHandler()
        const response = await requestVia(h, '/projects/acme/test/rollback', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.equal(calls(), 0)
    })

    it('writing an env file does not refresh: it never touches the registry', async () => {
        agent.reply = () => ({ ok: true, output: '.env was written' })
        const { handler: h, calls } = refreshableHandler()
        const response = await requestVia(h, '/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: { text: 'SECRET=shh' } })
        assert.equal(response.status, 200)
        assert.equal(calls(), 0)
    })

    it('a refusal never refreshes, whether it is caught before the agent or comes back from it', async () => {
        const { handler: h, calls } = refreshableHandler()

        // Caught before the agent is ever called: a malformed settings body.
        const badBody = await requestVia(h, '/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { nonsense: 1 } })
        assert.equal(badBody.status, 400)
        assert.equal(calls(), 0)

        // The agent itself refuses the write.
        agent.reply = () => ({ ok: false, code: 'bad-request', message: 'nope' })
        const agentRefused = await requestVia(h, '/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { capabilities: ['lifecycle'] } })
        assert.equal(agentRefused.status, 400)
        assert.equal(calls(), 0)
    })

    it('a refresh that fails does not turn a successful write into an error answer', async () => {
        agent.reply = () => ({ ok: true, output: 'configured' })
        const failing = createHandler({
            token: TOKEN,
            registry: () => registry,
            refreshRegistry: async () => { throw new Error('registry disappeared mid-refresh') },
            agent, audit, domains, verifier, keepaliveMs: 60_000,
        })
        const response = await requestVia(failing, '/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { capabilities: ['lifecycle'] } })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, output: 'configured' })
    })
})

describe('provisioning and env routes refuse a client actor', () => {
    it('refuses every new route for a client actor, and audits the refusal', async () => {
        const attempts = [
            () => request('/projects', { method: 'POST', body: CREATE_BODY }),
            () => request('/projects/acme', { method: 'DELETE', body: { name: 'Acme' } }),
            () => request('/projects/acme/environments', { method: 'POST', body: { name: 'uat1', branch: 'main', domain: null } }),
            () => request('/projects/acme/environments/test', { method: 'DELETE', body: { name: 'Acme' } }),
            () => request('/projects/acme/live/env'),
            () => request('/projects/acme/live/env/.env'),
            () => request('/projects/acme/live/env/.env', { method: 'PUT', body: { text: 'x' } }),
        ]
        for (const attempt of attempts) {
            const response = await attempt()
            assert.equal(response.status, 404, await response.text())
        }
        assert.deepEqual(agent.calls, [])
        const events = await audit.read({ limit: attempts.length })
        assert.equal(events.length, attempts.length)
        assert.ok(events.every(event => event.outcome === 'refused' && event.reason === 'not-found'))
    })
})

describe('matchRoute for backups', () => {
    it('matches every backup path', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups'), { verb: 'backups', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/backups'), { verb: 'backup-run', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/runs/a1b2c3d4'), { verb: 'backup-run-status', project: 'acme', run: 'a1b2c3d4' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/deadbeef'), { verb: 'backup-delete', project: 'acme', snapshot: 'deadbeef' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/deadbeef/download'), { verb: 'backup-download', project: 'acme', snapshot: 'deadbeef' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/schedule'), { verb: 'backup-schedule', project: 'acme', write: false })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/backups/schedule'), { verb: 'backup-schedule', project: 'acme', write: true })
    })

    it('does not mistake schedule or runs for a snapshot id', () => {
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/schedule'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/not-hex'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/runs/not-hex'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/deadbeef/nope'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/backups/schedule'), { verb: 'method-not-allowed' })
    })
})

describe('the backup endpoints', () => {
    it('answers 202 with the run id when a run starts, and audits it', async () => {
        agent.reply = () => ({ ok: true, started: { run: 'a1b2c3d4', tag: 'manual' } })
        const response = await request('/projects/acme/backups', { method: 'POST' })
        assert.equal(response.status, 202)
        assert.deepEqual(await response.json(), { ok: true, run: 'a1b2c3d4' })
        // The actor's kind travels with the run, so the client's own backup is recorded as theirs in the
        // history the portal draws for them rather than as the operator's. Which user it was stays here,
        // in the audit entry, and never reaches the agent.
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 'client' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['backup', 'run', 'ok'])
    })

    it('sends admin as the actor when the operator starts the run', async () => {
        agent.reply = () => ({ ok: true, started: { run: 'a1b2c3d4', tag: 'manual' } })
        await request('/projects/acme/backups', { method: 'POST', actor: 'admin' })
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 'admin' } }])
    })

    it('passes a refused run through with its status, audited as refused', async () => {
        agent.reply = () => ({ ok: false, code: 'busy', message: 'acme already has a backup running' })
        const response = await request('/projects/acme/backups', { method: 'POST' })
        assert.equal(response.status, 409)
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.outcome, entry?.reason], ['backup', 'refused', 'busy'])
    })

    it('lists a project\'s backups without auditing a plain read', async () => {
        agent.reply = () => ({ ok: true, snapshots: [], runs: [], running: false })
        const response = await request('/projects/acme/backups')
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, snapshots: [], runs: [], running: false })
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'list' } }])
        assert.deepEqual(await audit.read({ limit: 10 }), [])
    })

    it('answers a run\'s status without auditing a plain read', async () => {
        agent.reply = () => ({ ok: true, run: null, running: false })
        const response = await request('/projects/acme/backups/runs/a1b2c3d4')
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, run: null, running: false })
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'get-run', run: 'a1b2c3d4' } }])
        assert.deepEqual(await audit.read({ limit: 10 }), [])
    })

    it('deletes a snapshot through the agent and audits it', async () => {
        agent.reply = () => ({ ok: true, output: 'backup deadbeef deleted' })
        const response = await request('/projects/acme/backups/deadbeef', { method: 'DELETE' })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'delete', snapshot: 'deadbeef' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['backup', 'deadbeef', 'ok'])
    })

    it('streams a download with a filename naming the project and the date, and audits it', async () => {
        const response = await request('/projects/acme/backups/deadbeef/download')
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), 'application/gzip')
        assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="acme-\d{4}-\d{2}-\d{2}\.tar\.gz"/)
        assert.equal(await response.text(), 'bytes')
        assert.deepEqual(agent.calls, [{ verb: 'backup', project: 'acme', args: { action: 'download', snapshot: 'deadbeef' } }])
        // A download is a read of the client's own data, but it is audited exactly like a mutation: it
        // is the one read here that moves the client's actual backup bytes off the dedi.
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['backup', 'deadbeef', 'ok'])
    })

    it('passes a download refusal through as JSON without streaming', async () => {
        agent.download = async agentRequest => {
            agent.calls.push(agentRequest)
            return { ok: false, code: 'bad-request', message: 'no backup deadbeef for acme' }
        }
        const response = await request('/projects/acme/backups/deadbeef/download')
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { ok: false, code: 'bad-request', message: 'no backup deadbeef for acme' })
    })

    // The headers are already on the wire by the time a mid-stream failure happens, so the only way to
    // tell the client anything is real broke is to leave the chunked response incomplete rather than
    // end it cleanly: a clean end reads as a short but valid file, which is only caught at restore time.
    it('destroys the response rather than ending it when the download fails mid-stream, so a truncated archive is never reported as complete', async () => {
        agent.download = async agentRequest => {
            agent.calls.push(agentRequest)
            return {
                ok: true,
                body: (async function* () {
                    yield Buffer.from('partial bytes')
                    throw new Error('the agent connection failed: socket reset')
                })(),
                close() {},
            }
        }
        // A deliberately slow failure entry, to make the order the handler promises observable. The
        // handler writes that entry before it destroys the response, so with the write held open the
        // client cannot see the transfer break until the record is on disk. Written the other way round
        // this test then fails outright rather than only under load, which is how the ordering escaped
        // it before.
        const append = audit.append.bind(audit)
        audit.append = async event => {
            if (event.outcome === 'failed') await new Promise(resolve => setTimeout(resolve, 50))
            await append(event)
        }

        // The status line and headers were already sent before the failure, so status alone would pass
        // whether the transfer completed or not; what actually distinguishes a truncated transfer is
        // that the client never gets to read a complete body. undici's fetch tears the whole request
        // promise down for this one (a destroyed socket before the response is framed as complete), but
        // either that or a Response whose .text() rejects would prove the same thing, so both are
        // covered here.
        await assert.rejects(async () => {
            const response = await request('/projects/acme/backups/deadbeef/download')
            await response.text()
        })

        // And the operator's own record must not say otherwise. The entry written before the transfer
        // records the authorization decision, which really was ok; without a second entry the audit log
        // would agree with the truncated archive that the download succeeded, and the one place the
        // failure could still be seen after the fact would be gone.
        //
        // Read the moment the client sees the failure, with nothing waiting in between: that is the
        // portal's position too, and it is the read that holds the handler to writing the entry before
        // it destroys the response rather than after.
        const entries = await audit.read({ limit: 10 })
        const [failure] = entries
        assert.deepEqual([failure?.verb, failure?.target, failure?.outcome], ['backup', 'deadbeef', 'failed'])
        assert.match(failure?.reason ?? '', /socket reset/)
        assert.deepEqual(entries.map(entry => entry.outcome), ['failed', 'ok'])
    })

    it('leaves no failure entry and delivers every byte when the download completes', async () => {
        // The other side of the same audit: a download that finishes must not gain a failure entry, or
        // the log stops meaning anything.
        const response = await request('/projects/acme/backups/deadbeef/download')
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'bytes')
        assert.deepEqual((await audit.read({ limit: 10 })).map(entry => entry.outcome), ['ok'])
    })

    it('reads the default schedule without asking the agent or auditing a plain read', async () => {
        const response = await request('/projects/acme/backups/schedule')
        assert.equal(response.status, 200)
        assert.equal((await response.json() as { schedule: { mode: string } }).schedule.mode, 'off')
        assert.deepEqual(agent.calls, [])
        assert.deepEqual(await audit.read({ limit: 10 }), [])
    })

    it('clamps a written schedule to the project ceiling and gives it back, and audits the write', async () => {
        const response = await request('/projects/acme/backups/schedule', {
            method: 'PUT',
            body: { mode: 'daily', hour: 2, minute: 0, weekday: 0, keep: { daily: 999, weekly: 1, monthly: 1 } },
        })
        assert.equal(response.status, 200)
        const body = await response.json() as { schedule: { keep: { daily: number } } }
        assert.equal(body.schedule.keep.daily, 14)
        assert.equal(schedules.get('acme').keep.daily, 14)
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['backup', 'schedule', 'ok'])
    })

    it('refuses a schedule that is not one, without touching the store', async () => {
        const response = await request('/projects/acme/backups/schedule', { method: 'PUT', body: { mode: 'hourly' } })
        assert.equal(response.status, 400)
        assert.equal(schedules.get('acme').mode, 'off')
    })

    it('refuses backups for a project without the capability', async () => {
        const response = await request('/projects/quiet/backups')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })

    it('refuses another client\'s backups with a 404, same as any other project route', async () => {
        const response = await request('/projects/other/backups')
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })

    // One representative test per distinct shape among the six endpoints besides the plain list above:
    // a write that reaches the agent, the streaming/audited-read download, and the one write that never
    // reaches the agent at all. Each checks that the refusal happened before anything downstream did.
    it('refuses starting a run for another client\'s project, without ever reaching the agent', async () => {
        const response = await request('/projects/other/backups', { method: 'POST' })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })

    it('refuses a download for a project without the capability, before streaming anything', async () => {
        const response = await request('/projects/quiet/backups/deadbeef/download')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
        assert.doesNotMatch(response.headers.get('content-type') ?? '', /gzip/)
    })

    it('refuses a schedule write for another client\'s project, without touching the store', async () => {
        const response = await request('/projects/other/backups/schedule', {
            method: 'PUT',
            body: { mode: 'daily', hour: 2, minute: 0, weekday: 0, keep: { daily: 1, weekly: 1, monthly: 1 } },
        })
        assert.equal(response.status, 404)
        assert.equal(schedules.get('other').mode, 'off')
    })

    it('answers 503 for a schedule request when no schedule store is configured', async () => {
        // Swaps the shared server's handler for one built without schedules, rather than standing up a
        // second server just for this one case.
        const original = handler
        // schedules is the one dep deliberately left out, which is what this case is about; the rest are
        // required by ApiDeps and are passed exactly as beforeEach passes them.
        handler = createHandler({
            token: TOKEN, registry: () => registry, refreshRegistry: async () => false,
            agent, audit, domains, verifier,
        })
        try {
            const response = await request('/projects/acme/backups/schedule')
            assert.equal(response.status, 503)
        } finally {
            handler = original
        }
    })
})

describe('PUT /projects/:id/:env/port', () => {
    it('routes under the environment and allows only PUT', () => {
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/port'), { verb: 'port', project: 'acme', environment: 'live' })
        assert.equal(matchRoute('GET', '/projects/acme/live/port').verb, 'method-not-allowed')
    })

    it('asks the agent to change the port', async () => {
        agent.reply = () => ({ ok: true, output: 'acme live now uses port 5012' })
        const response = await request('/projects/acme/live/port', { method: 'PUT', actor: 'admin', body: { port: 5012 } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'port', project: 'acme', args: { environment: 'live', port: 5012 } }])
    })

    it('refuses a body that is not one port', async () => {
        for (const body of [{}, { port: '5012' }, { port: 5012, extra: true }]) {
            const response = await request('/projects/acme/live/port', { method: 'PUT', actor: 'admin', body })
            assert.equal(response.status, 400)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('answers a client as though the project were not there', async () => {
        const response = await request('/projects/acme/live/port', { method: 'PUT', body: { port: 5012 } })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})

describe('watching a deploy', () => {
    it('sends GET and POST on one path to different places', async () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy'), { verb: 'deploy', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploy'), { verb: 'deploy-watch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/deploy'), { verb: 'method-not-allowed' })
    })

    it('streams a running deploy as Server-Sent Events, ending with an end event', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
        const text = await response.text()
        assert.ok(text.includes(`event: line\ndata: ${JSON.stringify(logLine)}\n\n`), text)
        assert.ok(text.endsWith('event: end\ndata: {}\n\n'), text)
        assert.deepEqual(agent.calls, [{ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['deploy-watch', 'live watch', 'ok'])
    })

    // Watching is the same kind of read as the history, which an owner may make.
    it('lets the owning client watch their own site', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'client:cl_1' })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    })

    it('refuses a client who does not own it, before any stream opens', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'client:cl_2' })
        assert.ok(response.status === 403 || response.status === 404, String(response.status))
        assert.equal((response.headers.get('content-type') ?? '').includes('event-stream'), false)
        assert.deepEqual(agent.calls, [])
    })

    it('passes a stream refusal through as JSON', async () => {
        agent.stream = async () => ({ ok: false, code: 'busy', message: 'acme already has a deploy watch open' })
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'admin' })
        assert.equal(response.status, 409)
        assert.equal((response.headers.get('content-type') ?? '').includes('event-stream'), false)
    })

    it('answers 503 when the agent cannot be reached', async () => {
        agent.stream = async () => { throw new AgentUnavailableError('the agent closed the connection without answering') }
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'admin' })
        assert.equal(response.status, 503)
        assert.equal(((await response.json()) as { code: string }).code, 'agent-unavailable')
        assert.equal((await audit.read({ limit: 1 }))[0]?.outcome, 'failed')
    })
})

describe('copying from live', () => {
    const RUN = 'abcdef012345'
    const record: CopyRecord = {
        project: 'acme', environment: 'test', run: RUN, actor: 'user_1', startedAt: '2026-09-25T10:00:00.000Z', durationMs: 0,
        outcome: 'running', step: null, reason: null, services: ['db'], storage: ['uploads'],
    }

    it('routes a start, the run list and one run under the environment', () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/test/copy-from-live'), { verb: 'copy-from-live', project: 'acme', environment: 'test' })
        assert.equal(matchRoute('GET', '/projects/acme/test/copy-from-live').verb, 'method-not-allowed')
        assert.deepEqual(matchRoute('GET', '/projects/acme/test/copy-runs'), { verb: 'copy-runs', project: 'acme', environment: 'test' })
        assert.deepEqual(matchRoute('GET', `/projects/acme/test/copy-runs/${RUN}`), { verb: 'copy-run', project: 'acme', environment: 'test', run: RUN })
        assert.equal(matchRoute('GET', '/projects/acme/test/copy-runs/not-a-run').verb, 'not-found')
        assert.equal(matchRoute('DELETE', `/projects/acme/test/copy-runs/${RUN}`).verb, 'method-not-allowed')
    })

    it('starts a copy for the admin, naming who asked, and audits it', async () => {
        agent.reply = () => ({ ok: true, run: RUN })
        const response = await request('/projects/acme/test/copy-from-live', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, run: RUN })
        assert.deepEqual(agent.calls, [{ verb: 'copy', project: 'acme', args: { action: 'start', environment: 'test', actor: 'user_1' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'test copy-from-live', 'ok'])
    })

    it('answers the agent\'s refusal with its status', async () => {
        agent.reply = () => ({ ok: false, code: 'busy', message: 'acme test has a deploy running' })
        const response = await request('/projects/acme/test/copy-from-live', { method: 'POST', actor: 'admin' })
        assert.equal(response.status, 409)
        assert.deepEqual(await response.json(), { ok: false, code: 'busy', message: 'acme test has a deploy running' })
    })

    it('refuses live, and an environment the project does not have, without calling the agent', async () => {
        const live = await request('/projects/acme/live/copy-from-live', { method: 'POST', actor: 'admin' })
        assert.equal(live.status, 400)
        assert.equal((await live.json()).message, 'live is what a copy reads from; it is never copied into')
        const missing = await request('/projects/acme/uat1/copy-from-live', { method: 'POST', actor: 'admin' })
        assert.equal(missing.status, 404)
        assert.deepEqual(agent.calls, [])
    })

    it('answers a client as though the project were not there, for a start and for the runs', async () => {
        for (const [path, method] of [
            ['/projects/acme/test/copy-from-live', 'POST'], ['/projects/acme/test/copy-runs', 'GET'], [`/projects/acme/test/copy-runs/${RUN}`, 'GET'],
        ] as const) {
            const response = await request(path, { method, actor: 'client:cl_1' })
            assert.equal(response.status, 404, path)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('lists the runs of the environment and whether one is running', async () => {
        agent.reply = () => ({ ok: true, runs: [record], running: true })
        const response = await request('/projects/acme/test/copy-runs', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, runs: [record], running: true })
        assert.deepEqual(agent.calls, [{ verb: 'copy', project: 'acme', args: { action: 'list', environment: 'test' } }])
    })

    it('answers one run as its record, and 404 for a run it does not have', async () => {
        agent.reply = () => ({ ok: true, record, running: true })
        const response = await request(`/projects/acme/test/copy-runs/${RUN}`, { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), record)
        assert.deepEqual(agent.calls, [{ verb: 'copy', project: 'acme', args: { action: 'get-run', environment: 'test', run: RUN } }])

        agent.reply = () => ({ ok: true, record: null, running: false })
        const missing = await request(`/projects/acme/test/copy-runs/${RUN}`, { actor: 'admin' })
        assert.equal(missing.status, 404)
    })

    describe('when an environment is added with copyFromLive', () => {
        const added: AgentReply = { ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] }

        it('starts a copy once the add succeeded, and says so in the reply', async () => {
            agent.reply = sent => (sent.verb === 'copy' ? { ok: true, run: RUN } : added)
            const response = await request('/projects/acme/environments', {
                method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, copyFromLive: true },
            })
            assert.equal(response.status, 200)
            assert.deepEqual(await response.json(), { ...added, copy: { run: RUN } })
            assert.deepEqual(agent.calls, [
                { verb: 'provision', project: 'acme', args: { action: 'add-environment', environment: 'uat1', branch: 'main', domain: null, certificate: null } },
                { verb: 'copy', project: 'acme', args: { action: 'start', environment: 'uat1', actor: 'user_1' } },
            ])
            const entries = await audit.read({ limit: 2 })
            assert.deepEqual(entries.map(entry => [entry.verb, entry.target, entry.outcome]).sort(), [
                ['provision', 'acme add-environment', 'ok'], ['provision', 'uat1 copy-from-live', 'ok'],
            ])
        })

        it('keeps the environment and says why when the copy is refused', async () => {
            agent.reply = sent => (sent.verb === 'copy' ? { ok: false, code: 'bad-request', message: 'db has no running container in live, so there is nothing to copy from' } : added)
            const response = await request('/projects/acme/environments', {
                method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, copyFromLive: true },
            })
            assert.equal(response.status, 200)
            assert.deepEqual(await response.json(), { ...added, copy: { refused: 'db has no running container in live, so there is nothing to copy from' } })
        })

        it('starts no copy when it is false, and none when the add is refused', async () => {
            agent.reply = () => added
            const plain = await request('/projects/acme/environments', {
                method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, copyFromLive: false },
            })
            assert.deepEqual(await plain.json(), added)
            agent.reply = () => ({ ok: false, code: 'bad-request', message: 'acme already has a uat1 environment' })
            const refused = await request('/projects/acme/environments', {
                method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, copyFromLive: true },
            })
            assert.equal(refused.status, 400)
            assert.deepEqual(agent.calls.map(call => call.verb), ['provision', 'provision'])
        })

        it('refuses a copyFromLive that is not true or false', async () => {
            const response = await request('/projects/acme/environments', {
                method: 'POST', actor: 'admin', body: { name: 'uat1', branch: 'main', domain: null, copyFromLive: 'yes' },
            })
            assert.equal(response.status, 400)
            assert.deepEqual(agent.calls, [])
        })
    })
})
