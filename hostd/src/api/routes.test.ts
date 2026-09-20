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

const TOKEN = 'k'.repeat(64)
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env]
    environments:
      live: { dir: /var/www/acme, port: 5010 }
      test: { dir: /var/www/acme-test, port: 5013 }
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

const logLine: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }

// The agent as api sees it. Tests replace call or stream to simulate refusals and outages.
function fakeAgent() {
    const calls: AgentRequest[] = []
    const agent: AgentClient & { calls: AgentRequest[], reply: (request: AgentRequest) => AgentReply } = {
        calls,
        reply: request => {
            switch (request.verb) {
                case 'health': return { ok: true, warnings: [], invalid: { acme: 'guard says no' } }
                case 'status': return { ok: true, services: [] }
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
    handler = createHandler({ token: TOKEN, registry: () => registry, agent, audit, keepaliveMs: 60_000 })
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
                { id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs', 'provision', 'env'], valid: false, reason: 'guard says no' },
                { id: 'quiet', name: 'Quiet', capabilities: [], valid: true },
            ],
        })
    })

    it('shows the admin every project, invalid registry entries included', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, valid: boolean }> }
        assert.deepEqual(body.projects.map(p => [p.id, p.valid]), [['acme', false], ['quiet', true], ['other', true], ['broken', false]])
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
        assert.deepEqual(await response.json(), { ok: true, services: [] })
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

    it('returns 503 with code unavailable when the agent cannot be reached', async () => {
        agent.reply = () => ({ ok: false, code: 'unavailable', message: 'provisioning is not configured' })
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: CREATE_BODY })
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { ok: false, code: 'unavailable', message: 'provisioning is not configured' })
        const [entry] = await audit.read({ limit: 1 })
        assert.equal(entry?.outcome, 'refused')
    })
})

describe('DELETE /projects/:id', () => {
    it('requires the project name typed back to delete, and refuses when it does not match', async () => {
        const wrongName = await request('/projects/acme', { method: 'DELETE', actor: 'admin', body: { name: 'Not Acme' } })
        assert.equal(wrongName.status, 400)
        assert.deepEqual(agent.calls, [])

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

        const response = await request('/projects/acme/environments/test', { method: 'DELETE', actor: 'admin', body: { name: 'Acme' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } }])
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
    })

    it('passes an env write through with its path and text, and audits it without the text', async () => {
        agent.reply = () => ({ ok: true, output: '.env was written' })
        const response = await request('/projects/acme/live/env/.env', { method: 'PUT', actor: 'admin', body: { text: 'SECRET=shh' } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{
            verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: '.env', text: 'SECRET=shh' },
        }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['env', '.env', 'ok'])
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
