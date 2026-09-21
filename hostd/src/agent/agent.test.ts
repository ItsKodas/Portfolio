import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Agent, MAX_FOLLOWS_PER_PROJECT, type AgentDeps, type Outcome } from './agent.ts'
import { lifecycleArgv, type Runner, type RunResult } from './compose.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { EnvFs } from './env-files.ts'
import type { ProvisionDeps } from './provision.ts'
import type { DeployRequest } from './deploy.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import { emptyDeploys, type DeployRecord, type EnvironmentDeploys } from '../shared/deploys.ts'
import type { Change } from '../shared/registry-write.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'
import type { AgentRequest, DeployArgs, LogLine } from '../shared/protocol.ts'
import type { SystemUsage } from '../shared/system.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    capabilities: [lifecycle, logs, provision, env]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  broken:
    client: cl_1
`)

// The machine's figures as health reports them. Injected, so nothing here reads the real machine.
const usage: SystemUsage = {
    memory: { totalBytes: 8_000_000_000, usedBytes: 3_000_000_000, availableBytes: 5_000_000_000 },
    cpu: { cores: 4, load1: 0.5, load5: 0.4, load15: 0.25 },
    disk: { path: '/var/www', totalBytes: 500_000_000_000, usedBytes: 200_000_000_000, freeBytes: 275_000_000_000 },
    problems: [],
}

const WEB = 'a'.repeat(64)
const QUIET_WEB = 'b'.repeat(64)
// What listAllContainers sees: both projects at once, each container labelled with the compose project
// it belongs to, which is how the agent tells them apart without a filtered call per project.
const ALL_CONTAINERS: ContainerSummary[] = [
    { Id: WEB, State: 'running', Labels: { 'com.docker.compose.project': 'acme', 'com.docker.compose.service': 'web' } },
    { Id: QUIET_WEB, State: 'running', Labels: { 'com.docker.compose.project': 'quiet', 'com.docker.compose.service': 'web' } },
    { Id: 'c'.repeat(64), State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
]
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
    allContainers?: () => Promise<ContainerSummary[]>
}

function setup(options: SetupOptions = {}) {
    // The test-only knobs are taken out first, so only real AgentDeps fields are spread into deps.
    const { runResult, guardInvalid, containers, allContainers, ...overrides } = options
    const runs: Array<{ command: string, args: string[] }> = []
    let listedAll = 0
    const rechecked: string[] = []
    const logStreams: PassThrough[] = []
    const runner: Runner = async (command, args) => {
        runs.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: 'done', timedOut: false, ...runResult }
    }
    const docker: DockerApi = {
        ping: async () => true,
        listProjectContainers: async () => containers === false ? [] : [{ Id: WEB, State: 'running', Labels: { 'com.docker.compose.service': 'web' } }],
        listAllContainers: async () => {
            listedAll += 1
            return allContainers ? allContainers() : ALL_CONTAINERS
        },
        inspect: async () => inspectWeb,
        logs: async () => {
            const stream = new PassThrough()
            logStreams.push(stream)
            return stream
        },
        exec: async () => ({ exitCode: 0, stderr: '' }),
    }
    const deps: AgentDeps = {
        registry: () => registry,
        guardInvalid: () => guardInvalid ?? new Map(),
        warnings: () => [],
        docker,
        runner,
        system: async () => usage,
        recheck: async (project: ProjectEntry) => {
            rechecked.push(project.id)
            return null
        },
        ...overrides,
    }
    return { agent: new Agent(deps), runs, rechecked, logStreams, listedAll: () => listedAll }
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

    it('reports the machine\'s memory, CPU and disk as figures, never as warnings', async () => {
        const busy: SystemUsage = {
            memory: { totalBytes: 8_000_000_000, usedBytes: 7_800_000_000, availableBytes: 200_000_000 },
            cpu: { cores: 4, load1: 19, load5: 17, load15: 12 },
            disk: { path: '/var/www', totalBytes: 100, usedBytes: 99, freeBytes: 1 },
            problems: ['the disk holding /elsewhere could not be read: ENOENT'],
        }
        const { agent } = setup({ system: async () => busy })
        const reply = replyOf(await agent.handle({ verb: 'health' }))
        assert.ok(reply && reply.ok && 'system' in reply)
        assert.deepEqual(reply.system, busy)
        // The whole point of change 2: a machine at 97% memory, a load of 19 and a full disk is still
        // healthy as far as hostd is concerned. These are figures to draw, not checks.
        assert.deepEqual(reply.warnings, [])
    })
})

describe('statuses', () => {
    const statuses = (...projects: string[]): AgentRequest => ({ verb: 'statuses', projects })

    it('reports every project from a single container listing', async () => {
        const { agent, listedAll } = setup()
        const reply = replyOf(await agent.handle(statuses('acme', 'quiet')))
        assert.ok(reply && reply.ok && 'projects' in reply)
        assert.deepEqual(reply.projects, [
            {
                project: 'acme',
                ok: true,
                services: [
                    { service: 'web', role: 'site', state: 'running', health: null, startedAt: '2026-09-20T00:00:00Z', restartCount: 0, image: 'acme-web' },
                    { service: 'db', role: 'database', state: 'missing', health: null, startedAt: null, restartCount: null, image: null },
                ],
            },
            {
                project: 'quiet',
                ok: true,
                services: [
                    { service: 'web', role: 'site', state: 'running', health: null, startedAt: '2026-09-20T00:00:00Z', restartCount: 0, image: 'acme-web' },
                ],
            },
        ])
        // One listing for both, which is the reason this verb exists rather than api calling status twice.
        assert.equal(listedAll(), 1)
    })

    it('answers in the order asked, and refuses one project without losing the others', async () => {
        const { agent } = setup({ guardInvalid: new Map([['quiet', 'guard problem']]) })
        const reply = replyOf(await agent.handle(statuses('ghost', 'quiet', 'acme')))
        assert.ok(reply && reply.ok && 'projects' in reply)
        assert.deepEqual(reply.projects.map(status => [status.project, status.ok]), [['ghost', false], ['quiet', false], ['acme', true]])
        assert.deepEqual(
            reply.projects.flatMap(status => (status.ok ? [] : [[status.code, status.message]])),
            [['unknown-project', 'ghost is not registered'], ['invalid-project', 'quiet is invalid: guard problem']],
        )
    })

    it('reports a Docker failure per project rather than failing the whole batch', async () => {
        const { agent } = setup({ allContainers: async () => { throw new Error('socket gone') } })
        const reply = replyOf(await agent.handle(statuses('acme', 'ghost')))
        assert.ok(reply && reply.ok && 'projects' in reply)
        const [acme, ghost] = reply.projects
        assert.ok(acme && !acme.ok)
        assert.equal(acme.code, 'failed')
        assert.match(acme.message, /socket gone/)
        // The refusal that needed no Docker at all is unaffected.
        assert.ok(ghost && !ghost.ok)
        assert.equal(ghost.code, 'unknown-project')
    })

    it('touches Docker at all only when some project survived the registry check', async () => {
        const { agent, listedAll } = setup()
        const reply = replyOf(await agent.handle(statuses('ghost', 'broken')))
        assert.ok(reply && reply.ok && 'projects' in reply)
        assert.deepEqual(reply.projects.map(status => status.ok), [false, false])
        assert.equal(listedAll(), 0)
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

function fakeEnvFs(overrides: Partial<EnvFs> = {}): EnvFs {
    return {
        readdir: async () => [],
        readFile: async () => { throw new Error('ENOENT: no such file or directory') },
        writeFile: async () => {},
        rename: async () => {},
        stat: async () => ({ size: 0 }),
        realpath: async path => path,
        ...overrides,
    }
}

// A registry of its own, with no invalid entry: the top-level `registry` above deliberately keeps one
// (`broken`) for the must-exist tests that prove the agent refuses an invalid project, but createProject
// and addEnvironment now refuse provisioning entirely while any entry is invalid, which would make every
// fake below trip on `broken` for a reason none of these tests are actually about.
const provisionRegistry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    capabilities: [lifecycle, logs, provision, env]
`)

function fakeProvisionDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
    return {
        registry: () => provisionRegistry,
        refreshRegistry: async () => {},
        writer: { write: async () => ({ ok: true }) } as unknown as ProvisionDeps['writer'],
        fetcher: { call: async () => ({ ok: true }) },
        choosePort: async () => ({ ok: true, port: 5100 }),
        mkdir: async () => {},
        rmdir: async () => {},
        exists: async () => false,
        resolve: async () => ({ ok: true, services: { web: { role: 'site' } } }),
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        log: () => {},
        ...overrides,
    }
}

describe('provisioning and env', () => {
    const envWrite = (project = 'acme'): AgentRequest => ({ verb: 'env', project, args: { action: 'write', environment: 'live', path: '.env', text: 'A=1' } })

    it('refuses provision and env when the capability is off', async () => {
        const { agent } = setup({ provision: fakeProvisionDeps() })
        const provisionReply = replyOf(await agent.handle({ verb: 'provision', project: 'quiet', args: { action: 'remove', environment: null } }))
        assert.equal(provisionReply?.ok === false && provisionReply.code, 'capability-disabled')

        const envReply = replyOf(await agent.handle({ verb: 'env', project: 'quiet', args: { action: 'list', environment: 'live' } }))
        assert.equal(envReply?.ok === false && envReply.code, 'capability-disabled')
    })

    it('refuses an env write whose path is not an env file', async () => {
        const { agent } = setup({ envFs: fakeEnvFs() })
        const reply = replyOf(await agent.handle({ verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: 'src/index.ts', text: 'x' } }))
        assert.equal(reply?.ok, false)
        assert.equal(reply?.ok === false && reply.code, 'bad-request')
        assert.match(reply?.ok === false ? reply.message : '', /env file/)
    })

    it('holds the env lock while writing, so a second write is refused as busy', async () => {
        let release: () => void = () => {}
        const blocked = new Promise<void>(resolve => { release = resolve })
        const { agent } = setup({ envFs: fakeEnvFs({ writeFile: async () => { await blocked } }) })

        const first = agent.handle(envWrite())
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(replyOf(await agent.handle(envWrite())), { ok: false, code: 'busy', message: 'acme already has an env write running for live' })
        release()
        assert.equal(replyOf(await first)?.ok, true)
        assert.equal(replyOf(await agent.handle(envWrite()))?.ok, true)
    })

    const create = (id: string): AgentRequest => ({
        verb: 'provision',
        args: { action: 'create', id, client: 'cl_2', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git', branch: 'main', domain: null, certificate: null },
    })

    it('serialises every provisioning action, regardless of id, and never touches the first\'s folder', async () => {
        const mkdirs: string[] = []
        const rmdirs: string[] = []
        let release: () => void = () => {}
        const blocked = new Promise<void>(resolve => { release = resolve })
        const provision = fakeProvisionDeps({
            mkdir: async dir => { mkdirs.push(dir) },
            rmdir: async dir => { rmdirs.push(dir) },
            fetcher: { call: async () => { await blocked; return { ok: true, commit: 'abc1234' } } },
        })
        const { agent } = setup({ provision })

        const first = agent.handle(create('bakery'))
        await new Promise(resolve => setImmediate(resolve))
        // A different id is refused too: choosePort and the domain check both read one registry snapshot,
        // which two overlapping creates for different ids would race exactly as badly as two for the same
        // id, so the lock is not keyed by id at all.
        assert.deepEqual(replyOf(await agent.handle(create('cafe'))), { ok: false, code: 'busy', message: 'another provisioning action is in progress' })
        // The busy refusal never even reached mkdir, so there is nothing for it to have removed.
        assert.deepEqual(rmdirs, [])

        release()
        assert.equal(replyOf(await first)?.ok, true)
        assert.deepEqual(mkdirs, ['/var/www/bakery'])
        assert.deepEqual(rmdirs, [])
        // The lock is released once the first call finishes, so a later create is not busy.
        assert.equal(replyOf(await agent.handle(create('bakery')))?.ok, true)
    })

    it('does not let a second create choose a port until the first is done, so they cannot both pick the same free one', async () => {
        const ports: number[] = []
        let nextPort = 5100
        let release: () => void = () => {}
        const blocked = new Promise<void>(resolve => { release = resolve })
        let calls = 0
        const provision = fakeProvisionDeps({
            choosePort: async () => {
                const port = nextPort++
                ports.push(port)
                return { ok: true, port }
            },
            // Only the first call blocks: once serialised, the second is free to run to completion.
            fetcher: { call: async () => { calls++; if (calls === 1) await blocked; return { ok: true, commit: 'abc1234' } } },
        })
        const { agent } = setup({ provision })

        const first = agent.handle(create('bakery'))
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(replyOf(await agent.handle(create('cafe'))), { ok: false, code: 'busy', message: 'another provisioning action is in progress' })

        release()
        assert.equal(replyOf(await first)?.ok, true)

        // Only now that the first is fully done does the second run for real, and choosePort is called
        // again rather than reusing the first's stale answer.
        assert.equal(replyOf(await agent.handle(create('cafe')))?.ok, true)
        assert.equal(ports.length, 2)
        assert.notEqual(ports[0], ports[1])
    })

    // The mirror of "does not re-run the guard before a stop": removal touches no files, so a project the
    // storage guard has just failed must still be removable, and is exactly the kind of project an
    // operator wants to unregister.
    it('removes a project despite a storage guard failure', async () => {
        const provision = fakeProvisionDeps()
        const { agent } = setup({ provision, guardInvalid: new Map([['acme', 'storage media overlaps a database mount']]) })
        const reply = replyOf(await agent.handle({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }))
        assert.equal(reply?.ok, true)
    })

    // Must-exist, per the whole-branch review: create and add-environment used to call createProject and
    // addEnvironment without this.deps.envFs at all, the way env() already does, so their own env-file
    // listing silently fell back to the real filesystem in every test that only overrode envFs.
    it('forwards envFs into create, so its env listing never reaches the real filesystem', async () => {
        const provision = fakeProvisionDeps()
        const envFs = fakeEnvFs({
            readdir: async dir => dir === '/var/www/bakery'
                ? [{ name: '.env', isDirectory: () => false, isFile: () => true }]
                : [],
            stat: async () => ({ size: 3 }),
        })
        const { agent } = setup({ provision, envFs })
        const reply = replyOf(await agent.handle(create('bakery')))
        assert.ok(reply?.ok && 'envFiles' in reply)
        assert.deepEqual(reply.ok && 'envFiles' in reply ? reply.envFiles.map(file => file.path) : [], ['.env'])
    })

    it('forwards envFs into add-environment, so its copy-and-rewrite step never reaches the real filesystem', async () => {
        const envFs = fakeEnvFs({
            readdir: async dir => dir === '/var/www/acme'
                ? [{ name: '.env', isDirectory: () => false, isFile: () => true }]
                : [],
            readFile: async path => path === '/var/www/acme/.env' ? 'A=1' : (() => { throw new Error('ENOENT') })(),
            stat: async () => ({ size: 3 }),
        })
        const writes: Array<{ path: string, text: string }> = []
        const provision = fakeProvisionDeps({
            resolve: async () => ({ ok: true, services: { web: { role: 'site' } } }),
        })
        const { agent } = setup({
            provision,
            envFs: { ...envFs, writeFile: async (path, text) => { writes.push({ path, text }) } },
        })
        const reply = replyOf(await agent.handle({
            verb: 'provision', project: 'acme',
            args: { action: 'add-environment', environment: 'test', branch: 'develop', domain: null, certificate: null },
        }))
        assert.equal(reply?.ok, true)
        assert.ok(writes.some(write => write.path.startsWith('/var/www/acme-test/')))
    })
})

const deployRegistry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        port: 5010
        deployed: abc1234
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
`)

const deployRecord = (commit: string, outcome: DeployRecord['outcome']): DeployRecord => ({
    commit, subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 5, outcome, reason: null, output: null,
})

// Only what the deploy verb itself touches: the runner is a recorder (the real one is covered by
// deploy-runner.test.ts), the store is a plain map, and the deps carry the writer, the fetcher and the
// one filesystem question commits asks.
function fakeDeploys(options: {
    state?: EnvironmentDeploys
    writeProblem?: string
    logReply?: FetchReply
    repoExists?: boolean
} = {}) {
    const started: Array<{ id: string, environment: string, request: DeployRequest }> = []
    const fetched: FetchRequest[] = []
    const changes: Change[] = []
    let registry = deployRegistry
    const deploys = {
        runner: {
            start: (project: ProjectEntry, environment: { name: string }, request: DeployRequest) => {
                started.push({ id: project.id, environment: environment.name, request })
                return { ok: true as const, started: { environment: environment.name as 'live', trigger: request.trigger } }
            },
        },
        store: {
            get: () => options.state ?? emptyDeploys(),
            resume: async () => {},
        },
        deps: {
            registry: () => registry,
            refreshRegistry: async () => { registry = deployRegistry },
            writer: {
                write: async (change: Change) => {
                    changes.push(change)
                    return options.writeProblem ? { ok: false as const, problem: options.writeProblem } : { ok: true as const }
                },
            },
            fetcher: {
                call: async (request: FetchRequest) => {
                    fetched.push(request)
                    return options.logReply ?? { ok: true, commits: [{ commit: 'abc1234', subject: 'Add the thing', author: 'Koda', at: '2026-09-21T00:00:00Z' }] }
                },
            },
            fs: { exists: async () => options.repoExists ?? true },
        },
    }
    return { deploys: deploys as unknown as AgentDeps['deploys'], started, fetched, changes }
}

describe('the deploy verb', () => {
    const deploy = (args: DeployArgs, project = 'acme'): AgentRequest => ({ verb: 'deploy', project, args })

    it('refuses every deploy action when deploys are not configured', async () => {
        const { agent } = setup({ registry: () => deployRegistry })
        const reply = replyOf(await agent.handle(deploy({ action: 'deploy', environment: 'live' })))
        assert.deepEqual(reply, { ok: false, code: 'unavailable', message: 'deploys are not configured' })
    })

    it('refuses a project without the deploy capability', async () => {
        const { deploys } = fakeDeploys()
        const { agent } = setup({ registry: () => deployRegistry, deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'deploy', environment: 'live' }, 'quiet')))
        assert.equal(reply?.ok === false && reply.code, 'capability-disabled')
    })

    it('starts a manual deploy and answers at once', async () => {
        const context = fakeDeploys()
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'deploy', environment: 'live' })))
        assert.deepEqual(reply, { ok: true, started: { environment: 'live', trigger: 'manual' } })
        assert.equal(context.started[0]!.request.trigger, 'manual')
        assert.equal(context.started[0]!.request.actor, 'admin')
        assert.equal(context.started[0]!.request.commit, undefined)
    })

    it('returns the history with the branch, the deployed commit and the pause', async () => {
        const context = fakeDeploys({ state: { deploys: [deployRecord('abc1234', 'ok')], consecutiveFailures: 2, paused: true } })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'history', environment: 'live' })))
        assert.deepEqual(reply, {
            ok: true, environment: 'live', branch: 'main', deployed: 'abc1234',
            paused: true, consecutiveFailures: 2, deploys: [deployRecord('abc1234', 'ok')],
        })
    })

    it('reads the commit list from the repository once a deploy has moved it out of the tree', async () => {
        const context = fakeDeploys({ repoExists: true })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'commits', environment: 'live', limit: 5 })))
        assert.equal(reply?.ok, true)
        assert.deepEqual(context.fetched[0], { verb: 'log', dir: '/var/www/acme.git', branch: 'main', limit: 5 })
    })

    it('reads it from the tree itself before that, which is where provisioning cloned it', async () => {
        const context = fakeDeploys({ repoExists: false })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        await agent.handle(deploy({ action: 'commits', environment: 'live', limit: 5 }))
        assert.deepEqual(context.fetched[0], { verb: 'log', dir: '/var/www/acme', branch: 'main', limit: 5 })
    })

    it('passes a commit list failure through as a refusal', async () => {
        const context = fakeDeploys({ logReply: { ok: false, code: 'failed', message: 'not a git repository' } })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'commits', environment: 'live', limit: 5 })))
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'not a git repository' })
    })

    it('rolls back to the last commit recorded healthy, not to the one running now', async () => {
        const context = fakeDeploys({
            state: { deploys: [deployRecord('abc1234', 'ok'), deployRecord('9d8c7b6', 'ok')], consecutiveFailures: 0, paused: false },
        })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'rollback', environment: 'live' })))
        assert.equal(reply?.ok, true)
        assert.equal(context.started[0]!.request.trigger, 'rollback')
        assert.equal(context.started[0]!.request.commit, '9d8c7b6')
    })

    it('refuses a rollback when nothing has ever deployed healthily', async () => {
        const context = fakeDeploys({ state: { deploys: [deployRecord('abc1234', 'failed')], consecutiveFailures: 1, paused: false } })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'rollback', environment: 'live' })))
        assert.equal(reply?.ok === false && reply.code, 'bad-request')
        assert.deepEqual(context.started, [])
    })

    it('writes the new branch, then deploys it', async () => {
        const context = fakeDeploys()
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'set-branch', environment: 'live', branch: 'develop' })))
        assert.equal(reply?.ok, true)
        assert.deepEqual(context.changes, [{ kind: 'set-branch', id: 'acme', environment: 'live', branch: 'develop' }])
        assert.equal(context.started[0]!.request.trigger, 'branch')
    })

    it('refuses a branch the registry would not take, and starts nothing', async () => {
        const context = fakeDeploys({ writeProblem: 'environments.live.branch must be a plain branch name' })
        const { agent } = setup({ registry: () => deployRegistry, deploys: context.deploys })
        const reply = replyOf(await agent.handle(deploy({ action: 'set-branch', environment: 'live', branch: 'develop' })))
        assert.equal(reply?.ok === false && reply.code, 'bad-request')
        assert.deepEqual(context.started, [])
    })
})
