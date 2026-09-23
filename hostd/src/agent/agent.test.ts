import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Agent, MAX_FOLLOWS_PER_PROJECT, type AgentDeps, type Outcome } from './agent.ts'
import { lifecycleArgv, type Runner, type RunResult } from './compose.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { EnvFs } from './env-files.ts'
import type { ProvisionDeps } from './provision.ts'
import type { DeployRequest } from './deploy.ts'
import { parseRegistry, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { emptyDeploys, type DeployRecord, type EnvironmentDeploys } from '../shared/deploys.ts'
import type { Change } from '../shared/registry-write.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'
import type { AgentRequest, BackupArgs, ConfigureArgs, DeployArgs, LogLine } from '../shared/protocol.ts'
import type { SystemUsage } from '../shared/system.ts'
import { emptyBackups, type BackupRecord, type Snapshot } from '../shared/backups.ts'
import type { BackupRequest } from './backup-run.ts'
import type { Restic } from './restic.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    capabilities: [lifecycle, logs, provision, env, backups]
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
    let refreshes = 0
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
        railAge: () => null,
        recheck: async (project: ProjectEntry) => {
            rechecked.push(project.id)
            return null
        },
        // A harmless default so every test that never touches configure need not supply one, exactly like
        // recheck above; the configure tests below override it to record or refuse.
        writer: { write: async () => ({ ok: true as const }) },
        refreshRegistry: async () => { refreshes += 1 },
        ...overrides,
    }
    return { agent: new Agent(deps), runs, rechecked, logStreams, listedAll: () => listedAll, refreshes: () => refreshes }
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

    it('warns when the backup disk is nearly full', async () => {
        const { backups } = backupsWiring({ snapshots: [], disk: { path: '/backups', totalBytes: 1000, usedBytes: 950, freeBytes: 50 } })
        const { agent } = setup({ backups })
        const outcome = await agent.handle({ verb: 'health' })
        const reply = replyOf(outcome)
        const warnings = reply && reply.ok && 'warnings' in reply ? reply.warnings : []
        assert.ok(warnings.some((warning: string) => /backup disk has less than 10% free/.test(warning)))
    })

    it('warns once per project whose newest scheduled backup failed', async () => {
        const { backups } = backupsWiring({ snapshots: [], failures: ['acme: the newest scheduled backup failed: the dump failed'] })
        const { agent } = setup({ backups })
        const outcome = await agent.handle({ verb: 'health' })
        const reply = replyOf(outcome)
        const warnings = reply && reply.ok && 'warnings' in reply ? reply.warnings : []
        assert.ok(warnings.includes('acme: the newest scheduled backup failed: the dump failed'))
    })

    it('says nothing about backups when they are not configured', async () => {
        const { agent } = setup()
        const outcome = await agent.handle({ verb: 'health' })
        const reply = replyOf(outcome)
        const warnings = reply && reply.ok && 'warnings' in reply ? reply.warnings : []
        assert.equal(warnings.some((warning: string) => /backup/.test(warning)), false)
    })

    it('stays healthy when backupDisk throws, and warns with the error', async () => {
        const { backups } = backupsWiring({ snapshots: [], diskError: new Error('the statfs syscall failed') })
        const { agent } = setup({ backups })
        const outcome = await agent.handle({ verb: 'health' })
        const reply = replyOf(outcome)
        assert.ok(reply && reply.ok, 'health should still be ok: true')
        const warnings = reply && reply.ok && 'warnings' in reply ? reply.warnings : []
        assert.ok(warnings.some((warning: string) => /the backup disk could not be read/.test(warning)))
    })

    it('warns when backupDisk returns null', async () => {
        const { backups } = backupsWiring({ snapshots: [], disk: null })
        const { agent } = setup({ backups })
        const outcome = await agent.handle({ verb: 'health' })
        const reply = replyOf(outcome)
        const warnings = reply && reply.ok && 'warnings' in reply ? reply.warnings : []
        assert.ok(warnings.some((warning: string) => /the backup disk could not be read/.test(warning)))
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
        move: async () => {},
        rmdir: async () => {},
        exists: async () => false,
        // The ownership a site directory has on the dedi, the same fixture deploy.test.ts uses: these
        // two only have to succeed here, since what provisioning does with them is provision.test.ts's.
        owner: async () => ({ uid: 1000, gid: 1000, mode: 0o775 }),
        own: async () => {},
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
        assert.deepEqual(mkdirs, ['/var/www/bakery', '/var/www/bakery/live', '/var/www/bakery/git'])
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
            readdir: async dir => dir === '/var/www/bakery/live'
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

describe('the branches verb', () => {
    const branches = (project = 'acme'): AgentRequest => ({ verb: 'branches', project })

    it('refuses when the fetcher is not configured', async () => {
        const { agent } = setup({ registry: () => deployRegistry })
        const reply = replyOf(await agent.handle(branches()))
        assert.deepEqual(reply, { ok: false, code: 'unavailable', message: 'the fetcher is not configured' })
    })

    it('refuses a project with no repo, naming it', async () => {
        const fetcher = { call: async () => { throw new Error('must not be called') } }
        const { agent } = setup({ registry: () => deployRegistry, fetcher })
        const reply = replyOf(await agent.handle(branches('quiet')))
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'quiet has no repo to list branches from' })
    })

    it('asks the fetcher for the project\'s own repo, taken from the registry entry rather than the caller', async () => {
        const fetched: FetchRequest[] = []
        const fetcher = { call: async (request: FetchRequest) => { fetched.push(request); return { ok: true as const, branches: ['main', 'develop'] } } }
        const { agent } = setup({ registry: () => deployRegistry, fetcher })
        const reply = replyOf(await agent.handle(branches('acme')))
        assert.deepEqual(reply, { ok: true, branches: ['main', 'develop'] })
        // deployRegistry's acme has no credential key, so the entry's own credential (null, the default
        // token) is what travels, not something the caller could have supplied.
        assert.deepEqual(fetched, [{ verb: 'branches', repo: 'git@github.com:ItsKodas/acme.git', credential: null }])
    })

    it('passes a fetcher failure through as a refusal', async () => {
        const fetcher = { call: async () => ({ ok: false as const, code: 'failed' as const, message: 'repository not found' }) }
        const { agent } = setup({ registry: () => deployRegistry, fetcher })
        const reply = replyOf(await agent.handle(branches('acme')))
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'repository not found' })
    })
})

// A credential is the NAME of one of the fetcher's GitHub tokens; the token itself never reaches this
// process. These registries exist only to give branches() a project with, and without, one set.
const withCredential = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    credential: acme
`)
const withoutCredential = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:acme/site.git
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
`)

describe('credentials', () => {
    it("answers the fetcher's list, with no project needed", async () => {
        const fetcher = { call: async () => ({ ok: true as const, credentials: ['acme'] }) }
        const { agent } = setup({ fetcher })
        const reply = replyOf(await agent.handle({ verb: 'credentials' }))
        assert.deepEqual(reply, { ok: true, credentials: ['acme'] })
    })

    it('says so when there is no fetcher to ask', async () => {
        const { agent } = setup({ fetcher: undefined })
        const reply = replyOf(await agent.handle({ verb: 'credentials' }))
        assert.deepEqual(reply, { ok: false, code: 'unavailable', message: 'the fetcher is not configured' })
    })

    it("sends the project's own credential when listing branches", async () => {
        const fetched: FetchRequest[] = []
        const fetcher = { call: async (request: FetchRequest) => { fetched.push(request); return { ok: true as const, branches: ['main'] } } }
        const { agent } = setup({ registry: () => withCredential, fetcher })
        await agent.handle({ verb: 'branches', project: 'acme' })
        assert.deepEqual(fetched, [{ verb: 'branches', repo: 'git@github.com:acme/site.git', credential: 'acme' }])
    })

    it('sends null for a project with no credential, which is the default token', async () => {
        const fetched: FetchRequest[] = []
        const fetcher = { call: async (request: FetchRequest) => { fetched.push(request); return { ok: true as const, branches: ['main'] } } }
        const { agent } = setup({ registry: () => withoutCredential, fetcher })
        await agent.handle({ verb: 'branches', project: 'acme' })
        assert.deepEqual(fetched, [{ verb: 'branches', repo: 'git@github.com:acme/site.git', credential: null }])
    })

    // Checked here, where the name is being SET, so the registry can never hold a name that cannot
    // work. Without this the save succeeds and the next deploy is what discovers the typo.
    it('refuses a configure naming a credential the fetcher does not hold, and writes nothing', async () => {
        const fetcher = { call: async () => ({ ok: true as const, credentials: ['acme'] }) }
        const written: Change[] = []
        const { agent } = setup({ fetcher, writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } } })
        const reply = replyOf(await agent.handle({ verb: 'configure', project: 'acme', args: { credential: 'nope' } }))
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'no credential named nope' })
        assert.deepEqual(written, [])
    })

    it('does not ask the fetcher anything when the configure clears the credential', async () => {
        const fetched: FetchRequest[] = []
        const fetcher = { call: async (request: FetchRequest) => { fetched.push(request); return { ok: true as const, credentials: ['acme'] } } }
        const { agent } = setup({ fetcher })
        await agent.handle({ verb: 'configure', project: 'acme', args: { credential: null } })
        assert.deepEqual(fetched, [])
    })
})

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

// Only what the backup verb itself touches: the runner is a recorder, the store answers a fixed history,
// and restic's snapshots list is what stands in for the project's own repository. dump returns a
// PassThrough carrying whatever `dump.chunks` says, then the exit code `dump.exitCode` says: the real
// StreamHandle's two halves, and the only way to drive a dump that dies partway.
function backupsWiring(options: {
    snapshots?: Snapshot[], runs?: BackupRecord[], running?: boolean, disk?: any, diskError?: Error, failures?: string[],
    dump?: { chunks?: string[], exitCode?: number, stderr?: string },
} = {}) {
    const started: Array<{ id: string, request: BackupRequest }> = []
    const restic: Restic = {
        init: async () => ({ ok: true }),
        backup: async () => ({ ok: true, snapshot: 'deadbeef', sizeBytes: null }),
        snapshots: async () => ({ ok: true, snapshots: options.snapshots ?? [] }),
        forget: async () => ({ ok: true }),
        retention: async () => ({ ok: true }),
        prune: async () => ({ ok: true }),
        dump: () => {
            const stdout = new PassThrough()
            for (const chunk of options.dump?.chunks ?? []) stdout.write(chunk)
            stdout.end()
            return { stdout, exit: Promise.resolve({ exitCode: options.dump?.exitCode ?? 0, stderr: options.dump?.stderr ?? '' }) }
        },
    }
    const backups = {
        runner: {
            start: (project: ProjectEntry, request: BackupRequest) => {
                started.push({ id: project.id, request })
                return { ok: true as const, started: { run: 'run1', tag: 'manual' as const } }
            },
            isRunning: () => options.running ?? false,
        },
        store: {
            get: () => ({ ...emptyBackups(), runs: options.runs ?? [] }),
            failures: () => options.failures ?? [],
        },
        restic,
        backupDir: '/var/backups',
        newRunId: () => 'run1',
        backupDisk: async () => {
            if (options.diskError) throw options.diskError
            // Plenty free unless a test says otherwise: a disk that cannot be read now refuses a run, so a
            // null default would refuse every run test for a reason it was not written to exercise.
            return options.disk === undefined ? { path: '/backups', totalBytes: 1000, usedBytes: 100, freeBytes: 900 } : options.disk
        },
    }
    return { backups, started }
}

describe('backup', () => {
    const backup = (action: BackupArgs, project = 'acme'): AgentRequest => ({ verb: 'backup', project, args: action })

    it('refuses when backups are not configured', async () => {
        const { agent } = setup()
        const outcome = await agent.handle(backup({ action: 'list' }))
        assert.equal(outcome.kind === 'reply' && outcome.reply.ok, false)
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'unavailable')
    })

    it('lists the snapshots and the run history together', async () => {
        const { backups } = backupsWiring({ snapshots: [{ id: 'deadbeef', at: '2026-09-21T02:00:00.000Z', tag: 'manual' }] })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'list' }))
        assert.equal(outcome.kind === 'reply' && outcome.reply.ok && 'snapshots' in outcome.reply && outcome.reply.snapshots.length, 1)
    })

    it('refuses a run on a nearly full backup disk instead of starting one', async () => {
        // The design's run order refuses on the disk before it refuses a sixth manual run, and the runbook
        // lists this under "When a backup is refused". Checked inside backup-run.ts too, but a check only
        // there answers 202 with a run id and puts the reason in a record minutes later.
        const full = { path: '/backups', totalBytes: 1000, usedBytes: 950, freeBytes: 50 }
        for (const tag of ['manual', 'scheduled'] as const) {
            const { backups, started } = backupsWiring({ snapshots: [], disk: full })
            const { agent } = setup({ backups })
            const outcome = await agent.handle(backup({ action: 'run', tag }))
            assert.ok(outcome.kind === 'reply' && !outcome.reply.ok)
            assert.equal(outcome.reply.code, 'unavailable')
            assert.equal(outcome.reply.message, 'the backup disk has less than 10% free')
            assert.deepEqual(started, [])
        }
    })

    it('refuses a run when the backup disk cannot be read at all', async () => {
        const { backups, started } = backupsWiring({ snapshots: [], diskError: new Error('the statfs syscall failed') })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'run', tag: 'manual' }))
        assert.ok(outcome.kind === 'reply' && !outcome.reply.ok)
        assert.match(outcome.reply.message, /the backup disk could not be read/)
        assert.deepEqual(started, [])
    })

    it('refuses a sixth manual run itself, whatever api decided', async () => {
        const snapshots = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => ({ id: id.padEnd(8, '0'), at: '2026-09-21T02:00:00.000Z', tag: 'manual' as const }))
        const { backups } = backupsWiring({ snapshots })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'run', tag: 'manual' }))
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'bad-request')
    })

    it('refuses to delete a snapshot that is not in this project\'s repository', async () => {
        const { backups } = backupsWiring({ snapshots: [] })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'delete', snapshot: 'deadbeef' }))
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'bad-request')
    })

    it('refuses to download a snapshot that is not in this project\'s repository', async () => {
        // The mirror of the delete refusal above: a regression that reordered or special-cased download
        // ahead of the shared lookup would be caught here, not just inferred from the delete test.
        const { backups } = backupsWiring({ snapshots: [] })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'download', snapshot: 'deadbeef' }))
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'bad-request')
    })

    it('answers a download with bytes', async () => {
        const { backups } = backupsWiring({
            snapshots: [{ id: 'deadbeef', at: '2026-09-21T02:00:00.000Z', tag: 'manual' }],
            dump: { chunks: ['a whole tar'] },
        })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'download', snapshot: 'deadbeef' }))
        assert.equal(outcome.kind, 'bytes')
        assert.ok(outcome.kind === 'bytes')
        const chunks: Buffer[] = []
        for await (const chunk of outcome.body) chunks.push(chunk)
        assert.equal(Buffer.concat(chunks).toString(), 'a whole tar')
    })

    it('throws rather than ending cleanly when restic dump exits non-zero', async () => {
        // The failure this exists for: restic dies partway, its stdout simply reaches EOF, and without
        // the exit code every layer below reads that as a complete archive and answers 200 with a
        // truncated tar.gz the client only finds out about at restore time.
        const { backups } = backupsWiring({
            snapshots: [{ id: 'deadbeef', at: '2026-09-21T02:00:00.000Z', tag: 'manual' }],
            dump: { chunks: ['half a tar'], exitCode: 1, stderr: 'pack 1a2b3c4d not found in repository' },
        })
        const { agent } = setup({ backups })
        const outcome = await agent.handle(backup({ action: 'download', snapshot: 'deadbeef' }))
        assert.ok(outcome.kind === 'bytes')
        const chunks: Buffer[] = []
        await assert.rejects(
            async () => { for await (const chunk of outcome.body) chunks.push(chunk) },
            /restic dump exited with code 1: pack 1a2b3c4d not found in repository/,
        )
        // The bytes that did arrive are exactly the truncated archive nobody may be handed as a whole one.
        assert.equal(Buffer.concat(chunks).toString(), 'half a tar')
    })

    it('answers get-run with the matching record, null for an unknown run, and whether a run is in progress', async () => {
        const record: BackupRecord = {
            run: 'run1', tag: 'manual', actor: 'client', startedAt: '2026-09-21T02:00:00.000Z',
            durationMs: 5000, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false,
        }
        const { backups } = backupsWiring({ runs: [record], running: true })
        const { agent } = setup({ backups })

        const found = await agent.handle(backup({ action: 'get-run', run: 'run1' }))
        assert.deepEqual(found, { kind: 'reply', reply: { ok: true, run: record, running: true } })

        const missing = await agent.handle(backup({ action: 'get-run', run: 'deadbeef1' }))
        assert.deepEqual(missing, { kind: 'reply', reply: { ok: true, run: null, running: true } })
    })

    it('starts a run and passes the tag, actor, generated run id and keep through to the runner', async () => {
        const { backups, started } = backupsWiring({ snapshots: [] })
        const { agent } = setup({ backups })
        const keep = { daily: 7, weekly: 4, monthly: 3 }
        const outcome = await agent.handle(backup({ action: 'run', tag: 'manual', keep }))
        assert.equal(outcome.kind === 'reply' && outcome.reply.ok, true)
        // The single assertion below is deliberately exhaustive: a wrong actor, a dropped keep or a run id
        // that never reached newRunId() would each slip past a looser check.
        assert.deepEqual(started, [{ id: 'acme', request: { tag: 'manual', actor: 'admin', run: 'run1', keep } }])
    })

    it('records the actor api sent, and hostd for a scheduled run whatever was sent', async () => {
        // A client's own manual backup must not be recorded as the operator's: the portal draws this
        // history for the client. The actor is a label only, so the one thing that is not taken on trust
        // is 'hostd', which only a scheduled run may ever be.
        const client = backupsWiring({ snapshots: [] })
        const { agent } = setup({ backups: client.backups })
        await agent.handle(backup({ action: 'run', tag: 'manual', actor: 'client' }))
        assert.equal(client.started[0]?.request.actor, 'client')

        const scheduled = backupsWiring({ snapshots: [] })
        const scheduledAgent = setup({ backups: scheduled.backups }).agent
        await scheduledAgent.handle(backup({ action: 'run', tag: 'scheduled', actor: 'client' }))
        assert.equal(scheduled.started[0]?.request.actor, 'hostd')

        // Nothing sent: the operator, as before, since only api's own routes carry an actor.
        const bare = backupsWiring({ snapshots: [] })
        const bareAgent = setup({ backups: bare.backups }).agent
        await bareAgent.handle(backup({ action: 'run', tag: 'manual' }))
        assert.equal(bare.started[0]?.request.actor, 'admin')
    })
})

// The un-shadowed factory above, captured before the domains describe block below shadows `setup` with
// its own version: this is what that version delegates to for everything but the registry and the
// domains deps, exactly as fakeDeploys's callers pass registry and deploys in by hand.
const baseSetup = setup

const domainsRegistrySource = (capabilities: string) => `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: ${capabilities}
    environments:
      live:
        dir: /var/www/acme
        branch: main
        port: 5010
        domain: acme.com
        aliases: [www.acme.com]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
`

const domainsRegistry = parseRegistry(domainsRegistrySource('[lifecycle, logs, provision, env, domains]'))

type SentRail = { action: string, write: { path: string, text: string } | null, remove: string[], disable: string[] }

// Only what the domains verb itself touches: the rail is a recorder (the real one is covered by
// apache-rail.test.ts and the writeVhost/removeVhost/etc functions by domains.test.ts), so this exists
// only to prove the agent wires the request through, checks structure itself and reloads first.
function fakeDomains(registry: Registry) {
    const sent: SentRail[] = []
    const reload = { calls: 0 }
    const domains: NonNullable<AgentDeps['domains']> = {
        rail: {
            async send(action, parts) {
                sent.push({ action, ...parts })
                return { seq: sent.length - 1, ok: true, output: 'Syntax OK' }
            },
        },
        async readFile() { return null },
        async listSitesEnabled() { return { files: [], unreadable: [] } },
        async writeRegistry() { return { ok: true } },
        async reloadRegistry() {
            reload.calls += 1
            return registry
        },
        config: {
            includeDir: '/etc/apache2/hostd',
            sitesEnabled: '/etc/apache2/sites-enabled',
            originCert: '/etc/ssl/hostd/origin.pem',
            originKey: '/etc/ssl/hostd/origin.key',
            acmeWebroot: '/var/www/hostd-acme',
            maintenanceFlagDir: '/run/hostd/maintenance',
            maintenancePageDir: '/var/www/hostd-maintenance',
        },
    }
    return { domains, sent, reload }
}

describe('the domains verb', () => {
    // Shadows the module's own setup(), only within this describe block: the domains verb needs a
    // registry with the domains capability and a domain to write, which nothing above this point
    // provides, and every domains test below wants the rail's own recorders back rather than the ones
    // the base setup returns.
    function setup(options: { capabilities?: string } = {}) {
        const registry = options.capabilities === undefined ? domainsRegistry : parseRegistry(domainsRegistrySource(options.capabilities))
        const context = fakeDomains(registry)
        const base = baseSetup({ registry: () => registry, domains: context.domains })
        return { ...base, sent: context.sent, reload: context.reload }
    }

    it('refuses a project without the domains capability, before touching the rail', async () => {
        const { agent, sent } = setup({ capabilities: '[lifecycle]' })
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(result.ok, false)
        assert.equal(result.ok === false && result.code, 'capability-disabled')
        assert.equal(sent.length, 0)
    })

    it('refuses an unknown project', async () => {
        const { agent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'nobody', args: { action: 'remove', environment: 'live' } })
        assert.equal(result.ok === false && result.code, 'unknown-project')
    })

    it('refuses an environment the project does not have', async () => {
        const { agent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'remove', environment: 'test' } })
        assert.equal(result.ok === false && result.code, 'unknown-environment')
    })

    it('re-reads the registry rather than trusting what api sent', async () => {
        const { agent, reload } = setup()
        await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(reload.calls, 1)
    })

    it('writes the vhost for a project that has the capability', async () => {
        const { agent, sent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(result.ok, true)
        assert.equal(sent[0]!.write?.path, '/etc/apache2/hostd/acme-live.conf')
    })

    it('previews with the token that was passed in, not a placeholder', async () => {
        const { agent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'preview', environment: 'live', token: 'deadbeef' } })
        assert.equal(result.ok, true)
        assert.ok(result.ok && 'preview' in result && result.preview.proposed.includes('deadbeef'))
    })

    it('reports the rail\'s last answer in health, so a dead host unit is visible', async () => {
        const { agent } = setup()
        const health = replyOf(await agent.handle({ verb: 'health' }))
        assert.ok(health && 'railAge' in health)
    })
})

// Left behind, a vhost goes on claiming its hostnames and goes on proxying to a port choosePort may
// hand to another project: one client's visitors reaching another client's application.
describe('removing an environment takes its vhost with it', () => {
    const twoEnvironments = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: [lifecycle, provision, domains]
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com }
      test: { dir: /var/www/acme-test, port: 5011, domain: test.acme.com }
`)

    function setup(registry: Registry) {
        const context = fakeDomains(registry)
        const base = baseSetup({
            registry: () => registry,
            domains: context.domains,
            provision: fakeProvisionDeps({ registry: () => registry }),
        })
        return { ...base, sent: context.sent }
    }

    it('removes only that environment\'s file', async () => {
        const { agent, sent } = setup(twoEnvironments)
        const reply = replyOf(await agent.handle({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } }))
        assert.equal(reply?.ok, true)
        assert.deepEqual(sent.map(request => request.remove), [['/etc/apache2/hostd/acme-test.conf']])
    })

    it('removes every environment\'s file when the whole project goes', async () => {
        const { agent, sent } = setup(twoEnvironments)
        const reply = replyOf(await agent.handle({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }))
        assert.equal(reply?.ok, true)
        assert.deepEqual(
            sent.flatMap(request => request.remove).sort(),
            ['/etc/apache2/hostd/acme-live.conf', '/etc/apache2/hostd/acme-test.conf'],
        )
    })

    // The registry entry is already gone by then, so an operator who is told the removal failed would
    // retry something that cannot happen twice. They are told which file is still there instead.
    it('reports a vhost it could not remove rather than failing the removal that already happened', async () => {
        const context = fakeDomains(twoEnvironments)
        context.domains.rail = { send: async () => { throw new Error('the Apache host unit did not answer request 3') } }
        const failing = baseSetup({
            registry: () => twoEnvironments,
            domains: context.domains,
            provision: fakeProvisionDeps({ registry: () => twoEnvironments }),
        })
        const answer = replyOf(await failing.agent.handle({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } }))
        assert.equal(answer?.ok, true)
        assert.match(answer?.ok && 'output' in answer ? answer.output : '', /vhost for acme test could not be removed/)
    })

    it('leaves the rail alone for a project hostd never wrote a vhost for', async () => {
        const noDomains = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    capabilities: [lifecycle, provision]
`)
        const { agent, sent } = setup(noDomains)
        const reply = replyOf(await agent.handle({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }))
        assert.equal(reply?.ok, true)
        assert.deepEqual(sent, [])
    })
})

describe('configure', () => {
    const configure = (args: ConfigureArgs, project = 'acme'): AgentRequest => ({ verb: 'configure', project, args })

    it('writes what it was given and says so', async () => {
        const written: Change[] = []
        const { agent } = setup({ writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } } })

        const reply = replyOf(await agent.handle(configure({ capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main' } })))

        assert.equal(reply?.ok, true)
        assert.deepEqual(written, [{
            kind: 'configure', id: 'acme', capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main' },
        }])
    })

    // The store reloads on its own ten second timer otherwise, so the very next request would answer from
    // the entry this write replaced: a capability just granted would still read as absent.
    it('reloads the registry once the write lands', async () => {
        const { agent, refreshes } = setup()
        assert.equal(replyOf(await agent.handle(configure({ capabilities: ['lifecycle'] })))?.ok, true)
        assert.equal(refreshes(), 1)
    })

    it('does not reload the registry when the write was refused', async () => {
        const { agent, refreshes } = setup({ writer: { write: async () => ({ ok: false as const, problem: 'repo is malformed' }) } })
        assert.equal(replyOf(await agent.handle(configure({ repo: 'not a url' })))?.ok, false)
        assert.equal(refreshes(), 0)
    })

    // bad-request, not failed: the writer's problem is the registry validator's words about what the
    // operator typed, which is the same class of refusal set-branch answers bad-request for. failed
    // reaches the portal as a 502 and is audited as hostd having failed.
    it('passes the writer\'s own refusal back as a bad request rather than a failure', async () => {
        const { agent } = setup({ writer: { write: async () => ({ ok: false as const, problem: 'acme has no test environment' }) } })
        const reply = replyOf(await agent.handle(configure({ branches: { test: 'x' } })))
        assert.equal(reply?.ok, false)
        assert.equal(reply?.ok === false && reply.code, 'bad-request')
        assert.match(reply?.ok === false ? reply.message : '', /no test environment/)
    })

    // The registry above gives acme no domain, which is the state every site enrolled by hand is in.
    // Recording it is all that happens: nothing writes a vhost, because the hand-written file still
    // serving that site is displaced by adopting it rather than by this.
    it('sets a first domain with a write of its own, and writes no vhost', async () => {
        const written: Change[] = []
        const { agent } = setup({ writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } } })

        const reply = replyOf(await agent.handle(configure({ domains: { live: 'acme.com' } })))

        assert.equal(reply?.ok, true)
        // The registry write and nothing else: no vhost is rendered, no rail is asked to reload.
        assert.deepEqual(written, [
            { kind: 'configure', id: 'acme' },
            { kind: 'set-domain', id: 'acme', environment: 'live', domain: 'acme.com' },
        ])
    })

    // Moving an address that already exists. Allowed since the portal grew a confirmation for it, and
    // the registry write is only half the job: hostd's own vhost still names the old hostname, and a
    // vhost claiming a name the registry no longer does is the one state nothing else here can correct.
    const moved = (domain: string) => parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    capabilities: [domains]
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: ${domain}
        aliases: [www.acme.com]
`)

    // What hostd wrote for this environment the last time round, cut down to the line the rewrite reads
    // out of it. The token is the whole reason the old file is read at all.
    const EXISTING_VHOST = `<VirtualHost *:443>
    ServerName acme.com
    <Location "/.well-known/hostd/abc123def456">
        Header always set X-Hostd-Token "abc123def456"
        Redirect 204
    </Location>
</VirtualHost>
`

    const movingSetup = (over: Partial<NonNullable<AgentDeps['domains']>> = {}) => {
        const context = fakeDomains(moved('shop.acme.com'))
        const written: Change[] = []
        const base = setup({
            registry: () => moved('acme.com'),
            domains: { ...context.domains, ...over },
            writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } },
        })
        return { ...base, written, sent: context.sent, reload: context.reload }
    }

    const outputOf = (reply: ReturnType<typeof replyOf>) =>
        reply !== null && reply.ok && 'output' in reply ? reply.output : ''

    it('rewrites the vhost behind an address that moved, keeping the token the file already carries', async () => {
        const { agent, written, sent, reload } = movingSetup({ readFile: async () => EXISTING_VHOST })

        const reply = replyOf(await agent.handle(configure({ domains: { live: 'shop.acme.com' } })))

        assert.equal(reply?.ok, true)
        assert.deepEqual(written, [
            { kind: 'configure', id: 'acme' },
            { kind: 'set-domain', id: 'acme', environment: 'live', domain: 'shop.acme.com' },
        ])
        assert.equal(sent.length, 1)
        assert.equal(sent[0]?.write?.path, '/etc/apache2/hostd/acme-live.conf')
        assert.match(sent[0]?.write?.text ?? '', /ServerName shop\.acme\.com/)
        // The token out of the file that was there, never a new one: every alias proves itself against
        // that one value and not one of them changed.
        assert.match(sent[0]?.write?.text ?? '', /\/\.well-known\/hostd\/abc123def456/)
        // Rendered from the reloaded entry rather than from the request, which is what keeps
        // parseRegistry's reserved names, allowed carve-out and uniqueness in front of Apache.
        assert.equal(reload.calls, 1)
        assert.match(outputOf(reply), /rewritten/)
        // What api has no other way to learn: these names are served from a file hostd wrote a moment
        // ago, so their records belong in pending with the environment's token rather than in unmanaged,
        // which is what reconcile alone would leave behind.
        assert.deepEqual(reply?.ok === true && 'written' in reply ? reply.written : null, [{
            environment: 'live',
            hostnames: ['shop.acme.com', 'www.acme.com'],
            path: '/etc/apache2/hostd/acme-live.conf',
        }])
    })

    // Switching WebSockets changes nothing but the vhost, so it has to reach Apache the same way a moved
    // address does, with the same token, and without making any hostname prove itself again.
    it('rewrites the vhost with upgrade=websocket when WebSockets is switched on', async () => {
        const switched = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    capabilities: [domains]
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: acme.com
        aliases: [www.acme.com]
        websockets: true
`)
        const context = fakeDomains(switched)
        const written: Change[] = []
        const { agent } = setup({
            registry: () => moved('acme.com'),
            domains: { ...context.domains, readFile: async () => EXISTING_VHOST },
            writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } },
        })

        const reply = replyOf(await agent.handle(configure({ websockets: { live: true } })))

        assert.equal(reply?.ok, true)
        assert.deepEqual(written, [
            { kind: 'configure', id: 'acme' },
            { kind: 'set-flag', id: 'acme', environment: 'live', flag: 'websockets', enabled: true },
        ])
        assert.equal(context.sent.length, 1)
        assert.match(context.sent[0]?.write?.text ?? '', /ProxyPass \/ http:\/\/127\.0\.0\.1:5010\/ upgrade=websocket/)
        assert.match(context.sent[0]?.write?.text ?? '', /\/\.well-known\/hostd\/abc123def456/)
    })

    it('writes nothing and asks Apache for nothing when WebSockets is already how it was asked to be', async () => {
        const { agent, written, sent } = movingSetup({ readFile: async () => EXISTING_VHOST })

        const reply = replyOf(await agent.handle(configure({ websockets: { live: false } })))

        assert.equal(reply?.ok, true)
        assert.deepEqual(written, [{ kind: 'configure', id: 'acme' }])
        assert.equal(sent.length, 0)
    })

    // Every site enrolled by hand is in this state: the registry knows its address, but the file serving
    // it is somebody's hand-written vhost in sites-enabled. Rewriting nothing is the right answer, and
    // the operator displaces that file by adopting the site, which is its own previewed decision.
    it('moves an address on an environment hostd serves no vhost for, and asks Apache for nothing', async () => {
        const { agent, written, sent } = movingSetup()

        const reply = replyOf(await agent.handle(configure({ domains: { live: 'shop.acme.com' } })))

        assert.equal(reply?.ok, true)
        assert.equal(sent.length, 0)
        assert.equal(written.length, 2)
        assert.doesNotMatch(outputOf(reply), /rewritten/)
        // An empty list rather than a missing field, and the emptiness is the message: hostd serves no
        // vhost here, so api leaves the new hostname unmanaged, which is the truth about it.
        assert.deepEqual(reply?.ok === true && 'written' in reply ? reply.written : null, [])
    })

    // The registry has already changed by then, so "it worked" would be a lie in the one direction that
    // matters: Apache is still serving the old address and nothing on the tab would say so.
    it('reports a vhost rewrite Apache refused instead of answering as though it worked', async () => {
        const { agent, written } = movingSetup({
            readFile: async () => EXISTING_VHOST,
            rail: { send: async () => ({ seq: 0, ok: false as const, output: 'AH00526: Syntax error' }) },
        })

        const reply = replyOf(await agent.handle(configure({ domains: { live: 'shop.acme.com' } })))

        assert.equal(reply?.ok, false)
        assert.equal(reply?.ok === false && reply.code, 'failed')
        // The registry write happened and is named as having happened, before the part that did not.
        assert.match(reply?.ok === false ? reply.message : '', /registry entry was updated, but/)
        assert.match(reply?.ok === false ? reply.message : '', /no longer agree/)
        assert.equal(written.length, 2)
    })

    // Saving the address the environment already has is not a move, so nothing is rewritten for it.
    it('asks Apache for nothing when the address given is the one already set', async () => {
        const { agent, sent } = movingSetup({ readFile: async () => EXISTING_VHOST })

        const reply = replyOf(await agent.handle(configure({ domains: { live: 'acme.com' } })))

        assert.equal(reply?.ok, true)
        assert.equal(sent.length, 0)
    })

    // checkStructure runs first, exactly as it does for every other verb: a project the guard has marked
    // invalid is refused before configure ever reaches the writer, even though configure's own capability
    // gate is null. Uses the storage guard (rather than a registry.invalid entry) because 'acme' must stay
    // a project registry.projects actually holds for the writer path above to mean anything either way.
    it('refuses a project the structural check already rejected, without writing anything', async () => {
        const written: Change[] = []
        const { agent } = setup({
            guardInvalid: new Map([['acme', 'storage media overlaps a database service\'s mount']]),
            writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } },
        })
        const reply = replyOf(await agent.handle(configure({ capabilities: [] })))
        assert.equal(reply?.ok, false)
        assert.deepEqual(written, [])
    })
})
