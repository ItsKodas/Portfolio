import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, matchRoute, parseLogsQuery } from './routes.ts'
import { AuditLog } from './audit.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { DomainStore, domainKey, newRecord, type DomainRecord } from './domain-state.ts'
import { parseRegistry } from '../shared/registry.ts'
import { DOMAIN_TOKEN, type AgentReply, type AgentRequest, type LogLine } from '../shared/protocol.ts'
import type { SystemUsage } from '../shared/system.ts'

const TOKEN = 'k'.repeat(64)
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env, deploy, domains]
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
    { name: 'live', branch: 'main', domain: 'acme.example', certificate: 'letsencrypt', deployed: 'abc1234' },
    { name: 'test', branch: 'develop', domain: 'test.acme.example', certificate: null, deployed: null },
]
const quietEnvironmentsForClient = [{ name: 'live', branch: null, domain: null, certificate: null, deployed: null }]

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
    }
    return agent
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
let domains: DomainStore
let verifier: ReturnType<typeof fakeVerifier>

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
    domains = memoryDomains()
    verifier = fakeVerifier(() => domains)
    handler = createHandler({ token: TOKEN, registry: () => registry, agent, audit, domains, verifier, keepaliveMs: 60_000 })
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
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/environments/staging'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/environments/test'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/env'), { verb: 'env-list', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/env'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/test/env/db/.env'), { verb: 'env-file', project: 'acme', environment: 'test', path: 'db/.env' })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/test/env/.env'), { verb: 'env-file', project: 'acme', environment: 'test', path: '.env' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/test/env/.env'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/staging/env'), { verb: 'not-found' })
    })

    it('matches the deploy routes under an environment, and refuses the rest', () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy'), { verb: 'deploy', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/test/rollback'), { verb: 'rollback', project: 'acme', environment: 'test' })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/branch'), { verb: 'branch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploys'), { verb: 'deploys', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/commits'), { verb: 'commits', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploy'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/branch'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/nonsense'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy/now'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/staging/deploy'), { verb: 'not-found' })
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

    it('does not match an environment that does not exist', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/staging/domains'), { verb: 'not-found' })
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
                    id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy', 'domains'],
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
                id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy', 'domains'],
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
                branch: 'main', domain: 'acme.example', certificate: 'letsencrypt', deployed: 'abc1234',
            },
            {
                name: 'test', dir: '/var/www/acme-test', composePaths: ['/var/www/acme-test/docker-compose.yml'], port: 5013,
                branch: 'develop', domain: 'test.acme.example', certificate: null, deployed: null,
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
})

describe('POST /projects/:id/environments', () => {
    it('adds the test environment through the agent', async () => {
        const provisionReply: AgentReply = { ok: true, project: { id: 'acme', state: 'needs-setup' }, envFiles: [] }
        agent.reply = () => provisionReply
        const response = await request('/projects/acme/environments', {
            method: 'POST', actor: 'admin', body: { branch: 'main', domain: null, certificate: null },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'provision', project: 'acme',
            args: { action: 'add-environment', environment: 'test', branch: 'main', domain: null, certificate: null },
        }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['provision', 'acme add-environment', 'ok'])
    })
})

describe('DELETE /projects/:id/environments/:env', () => {
    it('requires the project name typed back too, and passes the environment through on a match', async () => {
        agent.reply = () => ({ ok: true, output: 'unregistered' })
        const wrongName = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'nope' } })
        assert.equal(wrongName.status, 400)
        const [refusal] = await audit.read({ limit: 1 })
        assert.deepEqual([refusal?.verb, refusal?.target, refusal?.outcome], ['provision', 'acme remove test', 'refused'])

        const response = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } }])
    })

    // registry-write.ts refuses to remove the live environment on its own (it is not this route's job
    // to know that; the agent is what enforces it). This just confirms that refusal comes back through
    // respondAgentAction as a failure, not silently as something else.
    it('passes a downstream refusal to remove live on its own through as a failure', async () => {
        agent.reply = () => ({ ok: false, code: 'failed', message: 'the live environment cannot be removed on its own' })
        const response = await request('/projects/acme/environments/live', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 502)
        assert.deepEqual(await response.json(), { ok: false, code: 'failed', message: 'the live environment cannot be removed on its own' })
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome, entry?.reason], ['provision', 'acme remove live', 'failed', 'the live environment cannot be removed on its own'])
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

    it('writes no record when the agent refuses, and audits the failure', async () => {
        agent.reply = () => ({ ok: false, code: 'failed', message: 'Apache refused the new configuration for acme live' })
        const response = await request('/projects/acme/live/domains', { method: 'POST', actor: 'admin', body: { hostname: 'shop.acme.example' } })
        assert.equal(response.status, 502)
        assert.equal(domains.get(domainKey('acme', 'live', 'shop.acme.example')), undefined)
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['domains', 'shop.acme.example', 'failed'])
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
    const claim: { path: string, names: string[], unsupported: string | null } =
        { path: '/etc/apache2/sites-enabled/acme.conf', names: ['acme.example'], unsupported: null }
    const preview = (over: Partial<{ claims: typeof claim[], adoptable: boolean }> = {}): AgentReply => ({
        ok: true,
        preview: { proposed: '<VirtualHost *:443>', claims: over.claims ?? [claim], extraNames: [], adoptable: over.adoptable ?? true },
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
        agent.reply = () => preview({ claims: [{ ...claim, unsupported: 'an IncludeOptional this parser cannot follow' }], adoptable: false })
        const unreadable = await request('/projects/acme/live/adopt', { method: 'POST', actor: 'admin', body: { confirm: 'Acme' } })
        assert.equal(unreadable.status, 400)
        assert.equal((await unreadable.json() as { message: string }).message.includes(claim.path), true)
        // The preview, and never the adopt that would have moved a file.
        assert.equal(agent.calls.length, 1)
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

    it('keeps the agent\'s own warnings alongside them', async () => {
        agent.reply = () => ({ ok: true, warnings: ['the registry could not be re-read'], invalid: {}, system: usage, railAge: 1_000 })
        const body = await (await request('/health', { actor: 'admin' })).json() as { warnings: string[] }
        assert.equal(body.warnings[0], 'the registry could not be re-read')
    })
})

describe('provisioning and env routes refuse a client actor', () => {
    it('refuses every new route for a client actor, and audits the refusal', async () => {
        const attempts = [
            () => request('/projects', { method: 'POST', body: CREATE_BODY }),
            () => request('/projects/acme', { method: 'DELETE', body: { name: 'Acme' } }),
            () => request('/projects/acme/environments', { method: 'POST', body: { branch: 'main', domain: null, certificate: null } }),
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
