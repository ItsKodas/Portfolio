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
import { parseRegistry } from '../shared/registry.ts'
import type { AgentReply, AgentRequest, LogLine } from '../shared/protocol.ts'
import type { SystemUsage } from '../shared/system.ts'

const TOKEN = 'k'.repeat(64)
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env, deploy]
    environments:
      live: { dir: /var/www/acme, port: 5010, branch: main, domain: acme.example, certificate: letsencrypt, deployed: abc1234 }
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
                case 'health': return { ok: true, warnings: [], invalid: { acme: 'guard says no' }, system: usage }
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

let server: Server
let base = ''
let dir = ''
let audit: AuditLog
let agent: ReturnType<typeof fakeAgent>

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
    handler = createHandler({ token: TOKEN, registry: () => registry, refreshRegistry: async () => false, agent, audit, keepaliveMs: 60_000 })
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
                    id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy'],
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
                id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env', 'deploy'],
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
            : { ok: true, warnings: [], invalid: {}, system: usage }
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

describe('GET /health', () => {
    it('gives the admin the machine\'s figures', async () => {
        const response = await request('/health', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, warnings: [], invalid: { acme: 'guard says no' }, system: usage })
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

    it('refuses a branch keyed by something that is not a known environment, naming it', async () => {
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body: { branches: { staging: 'main' } } })
        assert.equal(response.status, 400)
        const body = await response.json() as { message: string }
        assert.match(body.message, /staging/)
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
            agent, audit, keepaliveMs: 60_000,
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
            agent, audit, keepaliveMs: 60_000,
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
