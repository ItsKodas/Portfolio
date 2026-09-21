import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runDeploy, currentTip, MIN_FREE_BYTES, type DeployDeps, type DeployFs } from './deploy.ts'
import { RegistryWriter, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { EnvFs } from './env-files.ts'
import type { Runner, RunResult } from './compose.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

const REGISTRY_PATH = '/etc/hostd/registry/projects.yaml'
const TIP = '3f7c1a2b5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'

const REGISTRY_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy, env]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        deployed: abc1234
`

type SetupOptions = {
    registryYaml?: string
    fetchReplies?: Partial<Record<FetchRequest['verb'], FetchReply>>
    existsPaths?: string[]
    freeBytes?: number
    envTree?: Record<string, string>
    // Keyed by the compose subcommand: 'build', 'up', 'down'.
    composeResults?: Record<string, Partial<RunResult>>
    containerState?: { state: string, health?: string }
    // What Docker reports once the previous copy is back in place, so a rollback can be watched all the
    // way to the end. Defaults to a healthy container, which is the case a rollback exists for.
    afterRollback?: { state: string, health?: string }
}

// Every dependency is a plain recorder, the same style provision.test.ts uses: a factory that hands back
// both the fakes and what they were asked to do, so a test can assert on order and on what never
// happened, not only on the reply.
function setup(options: SetupOptions = {}) {
    const yaml = options.registryYaml ?? REGISTRY_YAML
    let registry = parseRegistry(yaml)
    let clock = 1_000
    const calls: string[] = []
    const fetchRequests: FetchRequest[] = []
    const composeRuns: string[][] = []
    const logs: string[] = []
    const maintenance = new Set<string>()
    const exists = new Set(options.existsPaths ?? ['/var/www/acme/.git'])
    const files = new Map(Object.entries(options.envTree ?? { '/var/www/acme/.env': 'DATABASE_URL=postgres://live\n' }))

    const registryFiles = new Map<string, string>([[REGISTRY_PATH, yaml]])
    const registryFs: RegistryWriteFs = {
        readFile: async path => registryFiles.get(path) ?? Promise.reject(new Error('missing')),
        stat: async () => ({ mode: 0o664, uid: 1000, gid: 1000 }),
        writeFile: async (path, text) => { registryFiles.set(path, text) },
        chmod: async () => {},
        chown: async () => {},
        rename: async (from, to) => {
            registryFiles.set(to, registryFiles.get(from)!)
            registryFiles.delete(from)
            calls.push('registry-write')
        },
        unlink: async () => {},
    }

    const envFs: EnvFs = {
        async readdir(dir) {
            const prefix = dir.endsWith('/') ? dir : `${dir}/`
            const seen = new Set<string>()
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue
                const rest = path.slice(prefix.length)
                if (!rest.includes('/')) seen.add(rest)
            }
            return [...seen].map(name => ({ name, isDirectory: () => false, isFile: () => true }))
        },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) {
            files.set(to, files.get(from)!)
            files.delete(from)
        },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return { size: Buffer.byteLength(text) }
        },
        async realpath(path) { return path },
    }

    let rolledBack = false
    const fs: DeployFs = {
        exists: async path => exists.has(path),
        mkdir: async dir => { calls.push(`mkdir ${dir}`); exists.add(dir) },
        rmdir: async dir => { calls.push(`rmdir ${dir}`); exists.delete(dir) },
        move: async (from, to) => {
            calls.push(`move ${from} ${to}`)
            if (from.endsWith('.prev')) rolledBack = true
            exists.delete(from)
            exists.add(to)
        },
        freeBytes: async () => options.freeBytes ?? MIN_FREE_BYTES * 2,
        setMaintenance: async key => { calls.push('maintenance on'); maintenance.add(key) },
        clearMaintenance: async key => { calls.push('maintenance off'); maintenance.delete(key) },
    }

    const frameNow = () => (rolledBack ? options.afterRollback ?? { state: 'running' } : options.containerState ?? { state: 'running' })
    const docker: DockerApi = {
        ping: async () => true,
        listProjectContainers: async (): Promise<ContainerSummary[]> => ([
            { Id: `${'a'.repeat(12)}1`, State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
        ]),
        listAllContainers: async () => [],
        inspect: async (): Promise<ContainerInspect> => {
            const frame = frameNow()
            return {
                Id: 'a'.repeat(12), RestartCount: 0, Config: { Tty: false, Image: 'acme-web' },
                State: { Status: frame.state, StartedAt: '2026-09-21T00:00:00Z', ...(frame.health ? { Health: { Status: frame.health } } : {}) },
            }
        },
        logs: async () => { throw new Error('logs are not used by a deploy') },
        exec: async () => ({ exitCode: 0, stderr: '' }),
    }

    const runner: Runner = async (_command, args) => {
        composeRuns.push(args)
        const subcommand = args.includes('build') ? 'build' : args.includes('up') ? 'up' : 'down'
        calls.push(`compose ${subcommand}`)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(options.composeResults?.[subcommand] ?? {}) }
    }

    const deps: DeployDeps = {
        registry: () => registry,
        refreshRegistry: async () => { registry = parseRegistry(registryFiles.get(REGISTRY_PATH)!) },
        writer: new RegistryWriter(REGISTRY_PATH, registryFs),
        fetcher: {
            call: async request => {
                calls.push(`fetcher ${request.verb}`)
                fetchRequests.push(request)
                const canned = options.fetchReplies?.[request.verb]
                if (canned) return canned
                if (request.verb === 'tip') return { ok: true, commit: TIP }
                if (request.verb === 'log') {
                    return { ok: true, commits: [{ commit: TIP.slice(0, 7), subject: 'Make it faster', author: 'Koda', at: '2026-09-21T00:00:00Z' }] }
                }
                return { ok: true }
            },
        },
        docker,
        runner,
        fs,
        envFs,
        // A clock that only moves when something waits, so the health check's 60 second budget is spent
        // instantly here and the suite never sleeps for real.
        now: () => clock,
        sleep: async ms => { clock += ms },
        log: message => logs.push(message),
    }

    const project = () => registry.projects.get('acme')!
    const environment = () => project().environments.get('live')!
    return { deps, project, environment, calls, fetchRequests, composeRuns, logs, files, registryFiles, maintenance, exists }
}

const request = { trigger: 'poll' as const, actor: 'hostd' }

describe('currentTip', () => {
    it('moves the repository out of the tree once, so a swap can never take it with it', async () => {
        const context = setup()
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.deepEqual(result, { ok: true, commit: TIP })
        assert.ok(context.calls.includes('move /var/www/acme/.git /var/www/acme.git/.git'))
        assert.deepEqual(context.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main' })
    })

    it('leaves an already-moved repository alone', async () => {
        const context = setup({ existsPaths: ['/var/www/acme.git'] })
        await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(context.calls.some(call => call.startsWith('move')), false)
    })

    it('says so when there is no git repository at all', async () => {
        const context = setup({ existsPaths: [] })
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /no git repository/)
    })

    it('returns the problem when the fetch fails, and never reaches the tip', async () => {
        const context = setup({ fetchReplies: { fetch: { ok: false, code: 'failed', message: 'could not read from remote' } } })
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(result.ok, false)
        assert.equal(context.calls.includes('fetcher tip'), false)
    })
})

describe('runDeploy, before the swap', () => {
    it('refuses when the disk is nearly full, and touches nothing', async () => {
        const context = setup({ freeBytes: 1024 })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /free disk/)
        assert.deepEqual(context.calls, [])
    })

    it('checks the new commit out into a fresh tree beside the running one', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.deepEqual(context.fetchRequests.find(sent => sent.verb === 'checkout'), {
            verb: 'checkout', dir: '/var/www/acme.git', worktree: '/var/www/acme.next', commit: TIP,
        })
    })

    it('removes a tree left behind by an earlier deploy before checking out', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme.next'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const removed = context.calls.indexOf('rmdir /var/www/acme.next')
        const checkedOut = context.calls.indexOf('fetcher checkout')
        assert.ok(removed !== -1 && removed < checkedOut)
    })

    it('carries the env files into the new tree, and leaves the running copy alone', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.files.get('/var/www/acme.next/.env'), 'DATABASE_URL=postgres://live\n')
        assert.equal(context.files.get('/var/www/acme/.env'), 'DATABASE_URL=postgres://live\n')
    })

    it('fails the deploy when an env file cannot be carried, naming the path and never its contents', async () => {
        const context = setup()
        context.deps.envFs!.writeFile = async () => { throw new Error('read-only file system') }
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /\.env/)
        assert.equal(JSON.stringify(record).includes('postgres://live'), false)
        assert.equal(context.calls.includes('compose build'), false)
    })

    it('records the commit subject from the branch log', async () => {
        const context = setup()
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.subject, 'Make it faster')
    })

    it('builds in the new tree under the environment\'s own compose project name', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const build = context.composeRuns.find(argv => argv.includes('build'))!
        assert.deepEqual(build.slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme.next'])
    })

    it('never touches the running site when the checkout fails', async () => {
        const context = setup({ fetchReplies: { checkout: { ok: false, code: 'failed', message: 'no such commit' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /no such commit/)
        assert.equal(context.calls.some(call => call.startsWith('compose')), false)
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        assert.equal(context.calls.includes('maintenance on'), false)
    })

    it('never touches the running site when the build fails, and keeps the build output', async () => {
        const context = setup({ composeResults: { build: { exitCode: 1, stderr: 'npm ERR! missing module' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.output ?? '', /npm ERR! missing module/)
        assert.equal(context.calls.includes('compose down'), false)
        assert.equal(context.calls.includes('maintenance on'), false)
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        // The half-built tree is not left lying around for the next deploy to trip over.
        assert.ok(context.calls.includes('rmdir /var/www/acme.next'))
    })

    it('refuses an environment with no branch, rather than guessing one', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML.replace('        branch: main\n', '') })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /branch/)
        assert.deepEqual(context.calls, [])
    })

    it('refuses when one of its own tree names is a registered project folder', async () => {
        const context = setup({
            registryYaml: `${REGISTRY_YAML}
  squatter:
    client: cl_2
    name: Squatter
    dir: /var/www/acme.next
    upstream: 127.0.0.1:5099
    services:
      web: { role: site }
`,
        })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /squatter/)
        assert.deepEqual(context.calls, [])
    })
})

describe('runDeploy, the swap', () => {
    it('puts the maintenance flag up before the swap and takes it down after', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const on = context.calls.indexOf('maintenance on')
        const down = context.calls.indexOf('compose down')
        const off = context.calls.indexOf('maintenance off')
        assert.ok(on !== -1 && on < down && down < off)
        assert.equal(context.maintenance.size, 0)
    })

    it('takes the old copy down, moves the trees, and starts the new one', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const order = context.calls.filter(call => call.startsWith('compose ') || call.startsWith('move '))
        assert.deepEqual(order, [
            // The one-time relocation of the repository, which is why a swap can rename the tree at all.
            'move /var/www/acme/.git /var/www/acme.git/.git',
            'compose build',
            'compose down',
            'move /var/www/acme /var/www/acme.prev',
            'move /var/www/acme.next /var/www/acme',
            'compose up',
        ])
    })

    it('keeps only one previous copy', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme.prev'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const removed = context.calls.indexOf('rmdir /var/www/acme.prev')
        const moved = context.calls.indexOf('move /var/www/acme /var/www/acme.prev')
        assert.ok(removed !== -1 && removed < moved)
    })

    it('records the commit in the registry once it is healthy', async () => {
        const context = setup()
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok')
        assert.equal(record.commit, TIP)
        assert.equal(context.environment().deployed, TIP)
    })

    it('does not move anything when the old copy will not come down', async () => {
        const context = setup({ composeResults: { down: { exitCode: 1, stderr: 'permission denied' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        assert.equal(context.maintenance.size, 0)
    })
})

describe('runDeploy, when the new version is not healthy', () => {
    const unhealthy = { containerState: { state: 'running', health: 'unhealthy' } }

    it('swaps back by itself and records the deploy as rolled back', async () => {
        const context = setup(unhealthy)
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /unhealthy/)
        assert.deepEqual(context.calls.filter(call => call.startsWith('move ') && !call.includes('/.git')), [
            'move /var/www/acme /var/www/acme.prev',
            'move /var/www/acme.next /var/www/acme',
            'move /var/www/acme /var/www/acme.next',
            'move /var/www/acme.prev /var/www/acme',
        ])
        // The tree that failed is not kept: it is a checkout of a commit git still has.
        assert.ok(context.calls.lastIndexOf('rmdir /var/www/acme.next') > context.calls.indexOf('move /var/www/acme.prev /var/www/acme'))
    })

    it('leaves the site on the commit it started on', async () => {
        const context = setup(unhealthy)
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.environment().deployed, 'abc1234')
        assert.equal(context.calls.includes('registry-write'), false)
    })

    it('rolls back the same way when the new version will not start at all', async () => {
        const context = setup({ composeResults: { up: { exitCode: 1, stderr: 'port is already allocated' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.output ?? '', /port is already allocated/)
        assert.ok(context.calls.includes('move /var/www/acme.prev /var/www/acme'))
    })

    it('says so when the previous copy does not come back healthy either', async () => {
        const context = setup({ ...unhealthy, composeResults: { up: { exitCode: 1, stderr: 'no such image' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /the previous copy/)
        assert.equal(context.maintenance.size, 0)
    })

    it('takes the maintenance flag down even when the swap throws', async () => {
        const context = setup()
        context.deps.fs.move = async (from, to) => {
            context.calls.push(`move ${from} ${to}`)
            throw new Error('read-only file system')
        }
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /read-only file system/)
        assert.equal(context.maintenance.size, 0)
    })
})
