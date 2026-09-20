import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Agent, MAX_FOLLOWS_PER_PROJECT, type AgentDeps, type Outcome } from './agent.ts'
import { lifecycleArgv, type Runner, type RunResult } from './compose.ts'
import type { ContainerInspect, DockerApi } from './docker.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { AgentRequest, LogLine } from '../shared/protocol.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    capabilities: [lifecycle, logs]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  broken:
    client: cl_1
`)

const WEB = 'a'.repeat(64)
const inspectWeb: ContainerInspect = {
    Id: WEB,
    RestartCount: 0,
    Config: { Tty: false, Image: 'acme-web' },
    State: { Status: 'running', StartedAt: '2026-09-20T00:00:00Z' },
}

function frame(text: string): Buffer {
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(Buffer.byteLength(text), 4)
    return Buffer.concat([header, Buffer.from(text)])
}

type SetupOptions = Partial<Omit<AgentDeps, 'guardInvalid'>> & {
    runResult?: Partial<RunResult>
    guardInvalid?: Map<string, string>
    containers?: boolean
}

function setup(options: SetupOptions = {}) {
    // The test-only knobs are taken out first, so only real AgentDeps fields are spread into deps.
    const { runResult, guardInvalid, containers, ...overrides } = options
    const runs: Array<{ command: string, args: string[] }> = []
    const rechecked: string[] = []
    const logStreams: PassThrough[] = []
    const runner: Runner = async (command, args) => {
        runs.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: 'done', timedOut: false, ...runResult }
    }
    const docker: DockerApi = {
        ping: async () => true,
        listProjectContainers: async () => containers === false ? [] : [{ Id: WEB, State: 'running', Labels: { 'com.docker.compose.service': 'web' } }],
        inspect: async () => inspectWeb,
        logs: async () => {
            const stream = new PassThrough()
            logStreams.push(stream)
            return stream
        },
    }
    const deps: AgentDeps = {
        registry: () => registry,
        guardInvalid: () => guardInvalid ?? new Map(),
        warnings: () => [],
        docker,
        runner,
        recheck: async (project: ProjectEntry) => {
            rechecked.push(project.id)
            return null
        },
        ...overrides,
    }
    return { agent: new Agent(deps), runs, rechecked, logStreams }
}

function replyOf(outcome: Outcome) {
    assert.equal(outcome.kind, 'reply')
    return outcome.kind === 'reply' ? outcome.reply : null
}

const lifecycle = (project: string, action: 'start' | 'stop' | 'restart' = 'start'): AgentRequest => ({ verb: 'lifecycle', project, args: { action } })
const logs = (follow: boolean, project = 'acme'): AgentRequest => ({ verb: 'logs', project, args: { service: 'web', tail: 10, since: null, follow } })

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
    const out: LogLine[] = []
    for await (const line of lines) out.push(line)
    return out
}

// Must-exist test 1 (spec, Testing strategy): the agent enforces the registry itself.
describe('must-exist: the agent refuses when api itself asks', () => {
    it('refuses an unregistered project without touching compose', async () => {
        const { agent, runs, rechecked } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('ghost'))), { ok: false, code: 'unknown-project', message: 'ghost is not registered' })
        assert.deepEqual(runs, [])
        assert.deepEqual(rechecked, [])
    })

    it('refuses a project the registry marked invalid', async () => {
        const { agent, runs } = setup()
        const reply = replyOf(await agent.handle(lifecycle('broken')))
        assert.equal(reply?.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(runs, [])
    })

    it('refuses a project the storage guard marked invalid', async () => {
        const { agent, runs } = setup({ guardInvalid: new Map([['acme', 'storage media overlaps a database service\'s mount']]) })
        const reply = replyOf(await agent.handle(lifecycle('acme')))
        assert.equal(reply?.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(runs, [])
    })

    it('refuses a verb whose capability is off', async () => {
        const { agent, runs } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('quiet'))), { ok: false, code: 'capability-disabled', message: 'lifecycle is not enabled for quiet' })
        const reply = replyOf(await agent.handle(logs(false, 'quiet')))
        assert.equal(reply?.ok === false && reply.code, 'capability-disabled')
        assert.deepEqual(runs, [])
    })
})

describe('lifecycle', () => {
    it('re-runs the storage guard before a start, then runs compose from the registry entry', async () => {
        const { agent, runs, rechecked } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'start'))), { ok: true, output: 'done' })
        assert.deepEqual(rechecked, ['acme'])
        assert.deepEqual(runs, [{ command: 'docker', args: lifecycleArgv(registry.projects.get('acme')!, 'start') }])
    })

    // Stopping reads no mounts, so a project whose guard has just failed can still be stopped.
    it('does not re-run the guard before a stop', async () => {
        const { agent, rechecked } = setup()
        await agent.handle(lifecycle('acme', 'stop'))
        assert.deepEqual(rechecked, [])
    })

    it('refuses to start when the re-run guard finds a problem', async () => {
        const { agent, runs } = setup({ recheck: async () => 'storage media contains /var/www/acme/uploads/.env, which compose reads' })
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'restart'))), {
            ok: false, code: 'invalid-project', message: 'storage media contains /var/www/acme/uploads/.env, which compose reads',
        })
        assert.deepEqual(runs, [])
    })

    it('reports a failed command with its output', async () => {
        const { agent } = setup({ runResult: { exitCode: 1, stderr: 'no such image' } })
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme'))), { ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
    })

    it('allows one lifecycle action per project at a time', async () => {
        let release: () => void = () => {}
        const blocked = new Promise<void>(resolve => { release = resolve })
        const { agent } = setup({
            runner: async () => {
                await blocked
                return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
            },
        })
        const first = agent.handle(lifecycle('acme'))
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'stop'))), { ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        release()
        assert.equal(replyOf(await first)?.ok, true)
        assert.equal(replyOf(await agent.handle(lifecycle('acme', 'stop')))?.ok, true)
    })
})

describe('status and health', () => {
    it('reports each registered service', async () => {
        const { agent } = setup()
        assert.deepEqual(replyOf(await agent.handle({ verb: 'status', project: 'acme' })), {
            ok: true,
            services: [
                { service: 'web', role: 'site', state: 'running', health: null, startedAt: '2026-09-20T00:00:00Z', restartCount: 0, image: 'acme-web' },
                { service: 'db', role: 'database', state: 'missing', health: null, startedAt: null, restartCount: null, image: null },
            ],
        })
    })

    it('reports warnings and every invalid project, from the registry and from the guard', async () => {
        const { agent } = setup({ guardInvalid: new Map([['acme', 'guard problem']]), warnings: () => ['registry reload rejected'] })
        const reply = replyOf(await agent.handle({ verb: 'health' }))
        assert.ok(reply && reply.ok && 'invalid' in reply)
        assert.deepEqual(reply.warnings, ['registry reload rejected'])
        assert.equal(reply.invalid.acme, 'guard problem')
        assert.ok(reply.invalid.broken)
    })
})

describe('logs', () => {
    it('streams decoded lines until Docker ends the stream', async () => {
        const { agent, logStreams } = setup()
        const outcome = await agent.handle(logs(false))
        assert.equal(outcome.kind, 'stream')
        if (outcome.kind !== 'stream') return
        logStreams[0]?.end(frame('2026-09-20T00:00:00Z hello\n'))
        assert.deepEqual(await collect(outcome.lines), [{ stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }])
    })

    it('says so when the service has no container at all', async () => {
        const { agent } = setup({ containers: false })
        assert.deepEqual(replyOf(await agent.handle(logs(false))), { ok: false, code: 'unavailable', message: 'web has no container; has acme been started?' })
    })

    it('allows four follow streams per project and frees a slot when one closes', async () => {
        const { agent } = setup()
        const open: Outcome[] = []
        for (let i = 0; i < MAX_FOLLOWS_PER_PROJECT; i++) open.push(await agent.handle(logs(true)))
        assert.deepEqual(replyOf(await agent.handle(logs(true))), { ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
        const first = open[0]
        assert.ok(first && first.kind === 'stream')
        first.close()
        assert.equal(agent.followCount('acme'), MAX_FOLLOWS_PER_PROJECT - 1)
        assert.equal((await agent.handle(logs(true))).kind, 'stream')
    })

    it('does not count a non-follow read against the limit', async () => {
        const { agent } = setup()
        await agent.handle(logs(false))
        assert.equal(agent.followCount('acme'), 0)
    })

    it('ends a follow stream on its own after the maximum duration, freeing its slot', async () => {
        const { agent } = setup({ followMaxMs: 20 })
        const outcome = await agent.handle(logs(true))
        assert.ok(outcome.kind === 'stream')
        // The close timer is unref'd in agent.ts, deliberately: a log follow must never hold the process
        // open at shutdown. That also means it cannot keep the event loop alive here, and when this suite
        // is the only thing running (as in the Docker build) the loop drains before the timer fires, and
        // node --test reports the awaited stream as "still pending". The ticker below holds the loop open
        // until the stream has ended.
        const keepAlive = setInterval(() => {}, 5)
        try {
            assert.deepEqual(await collect(outcome.lines), [])
        } finally {
            clearInterval(keepAlive)
        }
        assert.equal(agent.followCount('acme'), 0)
    })
})
