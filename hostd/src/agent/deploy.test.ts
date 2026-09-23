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

// Every site on the dedi that hostd can deploy names an override beside the base file: a port that
// machine has free, a service that box does not run, an address to publish on. The registry is where the
// operator says so, and the repo deliberately does not carry it.
const REGISTRY_YAML_OVERRIDE = `
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
        compose: [ docker-compose.yml, docker-compose.override.yml ]
        branch: main
        domain: acme.com
        port: 5010
        deployed: abc1234
`

// Live already nested, test still flat: the state in which a test deploy moves beside live.
const REGISTRY_YAML_TEST = `
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
        dir: /var/www/acme/live
        composeName: acme
        branch: main
        port: 5010
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5011
`
const REGISTRY_YAML_NESTED = REGISTRY_YAML_TEST.replace('dir: /var/www/acme-test', 'dir: /var/www/acme/test')

type SetupOptions = {
    registryYaml?: string
    // DeployDeps.migrateLayout, off unless a test turns it on, exactly as the dependency itself defaults.
    migrateLayout?: boolean
    // Makes every registry write fail at its final rename, so a write returns a problem.
    registryWriteFails?: boolean
    fetchReplies?: Partial<Record<FetchRequest['verb'], FetchReply>>
    existsPaths?: string[]
    freeBytes?: number
    owners?: Record<string, { uid: number, gid: number, mode: number }>
    envTree?: Record<string, string>
    // Makes DeployFs.copyFile throw, for the compose carry's own failure path.
    copyFails?: boolean
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
    // By default a flat live as provisioning leaves it: a clone, with the compose file at its root.
    const exists = new Set(options.existsPaths ?? ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'])
    const files = new Map(Object.entries(options.envTree ?? { '/var/www/acme/.env': 'DATABASE_URL=postgres://live\n' }))

    const registryFiles = new Map<string, string>([[REGISTRY_PATH, yaml]])
    const registryFs: RegistryWriteFs = {
        readFile: async path => registryFiles.get(path) ?? Promise.reject(new Error('missing')),
        stat: async () => ({ mode: 0o664, uid: 1000, gid: 1000 }),
        writeFile: async (path, text) => { registryFiles.set(path, text) },
        chmod: async () => {},
        chown: async () => {},
        rename: async (from, to) => {
            if (options.registryWriteFails) throw new Error('read-only file system')
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
    const copyFails = options.copyFails ?? false
    // What /var/www/acme itself is owned by and moded as, before the deploy touches anything: uid 1000,
    // gid 1000, drwxrwxr-x, exactly the RUNBOOK's own description of a site directory on the dedi. A test
    // that wants a different owner (an operator who chose something else) can overwrite this map by id.
    // The migrating and nested live paths are there because a move into the nested layout reads their
    // ownership as the pattern for the folders it makes, and for the tree the next deploy checks out.
    const siteOwner = { uid: 1000, gid: 1000, mode: 0o775 }
    const owners = new Map<string, { uid: number, gid: number, mode: number }>(
        Object.entries(options.owners ?? { '/var/www/acme': siteOwner, '/var/www/acme.migrating': siteOwner, '/var/www/acme/live': siteOwner }),
    )
    const fs: DeployFs = {
        exists: async path => exists.has(path),
        mkdir: async dir => { calls.push(`mkdir ${dir}`); exists.add(dir) },
        rmdir: async dir => { calls.push(`rmdir ${dir}`); exists.delete(dir) },
        removeEmptyDir: async dir => {
            calls.push(`rmdir-empty ${dir}`)
            if ([...exists].some(path => path.startsWith(`${dir}/`))) throw new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}'`)
            exists.delete(dir)
        },
        copyFile: async (from, to) => { calls.push(`copy ${from} ${to}`); if (copyFails) throw new Error('read-only file system'); exists.add(to) },
        move: async (from, to) => {
            calls.push(`move ${from} ${to}`)
            if (from.endsWith('.prev') || from.includes('/prev/')) rolledBack = true
            // A rename takes everything under the folder with it, which is what lets a repository moved
            // from /var/www/acme.git to /var/www/acme/git still be found at /var/www/acme/git/.git.
            for (const path of [...exists]) {
                if (path !== from && !path.startsWith(`${from}/`)) continue
                exists.delete(path)
                exists.add(to + path.slice(from.length))
            }
            exists.add(to)
        },
        freeBytes: async () => options.freeBytes ?? MIN_FREE_BYTES * 2,
        setMaintenance: async key => { calls.push('maintenance on'); maintenance.add(key) },
        clearMaintenance: async key => { calls.push('maintenance off'); maintenance.delete(key) },
        owner: async path => {
            calls.push(`owner ${path}`)
            const found = owners.get(path)
            if (!found) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return found
        },
        own: async (dir, like) => { calls.push(`own ${dir} ${like.uid}:${like.gid} ${like.mode.toString(8)}`) },
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
        migrateLayout: options.migrateLayout,
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
        assert.deepEqual(context.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main', credential: null })
    })

    // The poller's own path. A project that clones with the right token and then polls with the wrong
    // one looks provisioned and silently never deploys again, which is the failure this test exists for.
    it("fetches the tip with the project's own credential", async () => {
        const context = setup()
        await currentTip({ ...context.project(), credential: 'acme' }, context.environment(), context.deps)
        assert.deepEqual(context.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main', credential: 'acme' })
    })

    it('fetches with null for a project that has no credential', async () => {
        const context = setup()
        await currentTip({ ...context.project(), credential: null }, context.environment(), context.deps)
        assert.deepEqual(context.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main', credential: null })
    })

    it('leaves an already-moved repository alone', async () => {
        const context = setup({ existsPaths: ['/var/www/acme.git/.git'] })
        await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(context.calls.some(call => call.startsWith('move')), false)
    })

    // mkdir, own and move are three steps, and an interruption anywhere between the first and the last
    // leaves <dir>.git sitting there with no repository inside it. Taking the directory's own existence
    // as proof it holds one is what turned that into a deploy that could never succeed again: every
    // later attempt skipped the move, handed git a directory that is not a repository, and failed in
    // under a second with "fatal: not a git repository (or any parent up to mount point /var)".
    it('finishes a move an earlier deploy left half done, rather than trusting the directory it made', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme.git'] })
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.deepEqual(result, { ok: true, commit: TIP })
        assert.ok(context.calls.includes('move /var/www/acme/.git /var/www/acme.git/.git'))
        // Already there, so it is not made again: mkdir on an existing directory throws EEXIST.
        assert.equal(context.calls.includes('mkdir /var/www/acme.git'), false)
    })

    it('names both places it looked when neither holds a repository, instead of leaving git to say it', async () => {
        const context = setup({ existsPaths: ['/var/www/acme.git'] })
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(result.ok, false)
        const problem = result.ok === false ? result.problem : ''
        assert.match(problem, /no git repository/)
        assert.ok(problem.includes('/var/www/acme.git'), problem)
        assert.equal(context.fetchRequests.length, 0)
    })

    it('gives the freshly made repository directory the site directory\'s ownership and mode, not root\'s', async () => {
        const context = setup()
        await currentTip(context.project(), context.environment(), context.deps)
        assert.ok(context.calls.includes('owner /var/www/acme'))
        const mkdirAt = context.calls.indexOf('mkdir /var/www/acme.git')
        const ownAt = context.calls.indexOf('own /var/www/acme.git 1000:1000 775')
        const moveAt = context.calls.indexOf('move /var/www/acme/.git /var/www/acme.git/.git')
        assert.ok(mkdirAt !== -1 && ownAt !== -1 && moveAt !== -1)
        // Owned and moded before the .git that was inside the operator's checkout moves into it, so
        // there is never a moment where the repository directory sits there root-only.
        assert.ok(mkdirAt < ownAt && ownAt < moveAt)
    })

    it('does not touch ownership again once the repository directory already exists', async () => {
        const context = setup({ existsPaths: ['/var/www/acme.git/.git'] })
        await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(context.calls.some(call => call.startsWith('own ') || call.startsWith('owner ')), false)
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
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next'] })
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

    // listEnvFiles deliberately lists an .example alongside the real file, so the portal can show the two
    // together, but envWriteProblem refuses to write one: a repo commits its .example, so writing it
    // would dirty a tracked file. A carry that reads the list and writes every entry therefore failed
    // every deploy of every repo that commits one, with ".env.example could not be written into the new
    // tree". There is nothing to carry in the first place: the checkout already has the committed copy,
    // and it belongs to the commit being deployed, unlike the one in the tree being replaced.
    it('leaves an .example to the checkout, which already has the copy that belongs with this commit', async () => {
        const context = setup({
            envTree: { '/var/www/acme/.env': 'DATABASE_URL=postgres://live\n', '/var/www/acme/.env.example': 'DATABASE_URL=\n' },
        })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        assert.equal(context.files.get('/var/www/acme.next/.env'), 'DATABASE_URL=postgres://live\n')
        assert.equal(context.files.has('/var/www/acme.next/.env.example'), false)
    })

    // A host-specific compose file is not in the repo (that is the whole point of one), so a fresh
    // checkout does not have it, and compose is handed `-f` pointing at a path that does not exist:
    // "open /var/www/acme.next/docker-compose.override.yml: no such file or directory", before it builds
    // anything. Carried for the same reason env files are, and by the same rule: only when the checkout
    // does not have its own.
    it('carries a registered compose file the checkout does not have', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML_OVERRIDE, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml'] })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        assert.ok(context.calls.includes('copy /var/www/acme/docker-compose.override.yml /var/www/acme.next/docker-compose.override.yml'),
            context.calls.join(', '))
    })

    it('leaves the checkout its own copy, which belongs with the commit going out', async () => {
        const context = setup({
            registryYaml: REGISTRY_YAML_OVERRIDE,
            existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml', '/var/www/acme.next/docker-compose.override.yml'],
        })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.calls.some(call => call.startsWith('copy ')), false, context.calls.join(', '))
    })

    // Before the own, so a file this process wrote as root does not stay root-owned in a tree the
    // operator has to be able to read; and before the build, which is what reads it.
    it('carries it before ownership is applied and before the build', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML_OVERRIDE, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const copied = context.calls.findIndex(call => call.startsWith('copy '))
        const owned = context.calls.findIndex(call => call.startsWith('own /var/www/acme.next'))
        const built = context.calls.indexOf('compose build')
        assert.ok(copied !== -1 && owned !== -1 && built !== -1, context.calls.join(', '))
        assert.ok(copied < owned && owned < built)
    })

    // Compose names the build file `Dockerfile` whenever a service does not name one itself, and the
    // legacy builder (the agent has no buildx, see the agent stage in hostd/Dockerfile) looks for exactly
    // that name, so a repo that commits `dockerfile` failed every build with "unable to evaluate symlinks
    // in Dockerfile path". The checkout gets a `Dockerfile` copy of it, beside the compose file.
    it('gives a lowercase dockerfile the name compose asks for, before ownership and the build', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml', '/var/www/acme.next/dockerfile'] })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const copied = context.calls.indexOf('copy /var/www/acme.next/dockerfile /var/www/acme.next/Dockerfile')
        const owned = context.calls.findIndex(call => call.startsWith('own /var/www/acme.next'))
        const built = context.calls.indexOf('compose build')
        assert.ok(copied !== -1 && owned !== -1 && built !== -1, context.calls.join(', '))
        assert.ok(copied < owned && owned < built)
    })

    it('leaves a checkout that has its own Dockerfile alone', async () => {
        const context = setup({
            existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml', '/var/www/acme.next/Dockerfile', '/var/www/acme.next/dockerfile'],
        })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.calls.some(call => call.startsWith('copy ')), false, context.calls.join(', '))
    })

    it('fails the deploy naming the file when it cannot be carried, and never builds', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML_OVERRIDE, copyFails: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.next/docker-compose.yml'] })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.ok((record.reason ?? '').includes('docker-compose.override.yml'), record.reason ?? '')
        assert.equal(context.calls.includes('compose build'), false)
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

    it('gives the checked-out tree the site directory\'s ownership and mode before it is built or swapped in', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const ownAt = context.calls.indexOf('own /var/www/acme.next 1000:1000 775')
        const carriedEnv = context.calls.indexOf('fetcher checkout')
        const build = context.calls.indexOf('compose build')
        assert.ok(ownAt !== -1)
        // After the checkout (which is what needs fixing) and before the build or the swap: the checkout
        // ran as root, in the fetcher, so everything in .next is root-owned until this runs, whatever
        // mode git itself left individual files at, and a build or a swap must never see that unfixed.
        assert.ok(carriedEnv < ownAt && ownAt < build)
    })

    it('fails the deploy, without building or swapping, if the checked-out tree cannot be made usable', async () => {
        const context = setup()
        context.deps.fs.own = async () => { throw new Error('operation not permitted') }
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /operation not permitted/)
        assert.equal(context.calls.includes('compose build'), false)
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
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
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml', '/var/www/acme.prev'] })
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

    // The swap renames <dir>.next to <dir>, and git goes on recording the worktree under the path it was
    // created at. Left that way, the live tree is one `git worktree prune` away from losing its
    // repository: prune sees a registered path that no longer exists and deletes the admin directory
    // <dir>/.git points at. Checked against real git before this was written.
    it('re-points git at the tree the swap moved, so a later prune cannot cut the live site loose', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.deepEqual(context.fetchRequests.at(-1), { verb: 'repair', dir: '/var/www/acme.git', worktree: '/var/www/acme' })
    })

    // Outside the maintenance window, so the site is already up and serving by the time this runs.
    it('repairs after the site is serving again, never inside the window it is not', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const off = context.calls.indexOf('maintenance off')
        const repaired = context.calls.lastIndexOf('fetcher repair')
        assert.ok(off !== -1 && repaired !== -1, context.calls.join(', '))
        assert.ok(off < repaired)
    })

    it('still counts the deploy a success when the record could not be tidied', async () => {
        const context = setup({ fetchReplies: { repair: { ok: false, code: 'failed', message: 'not a working tree' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok')
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
        // A rollback swaps .prev straight back into place; .prev already carries the ownership and mode
        // a live site has, untouched by any checkout, so there is nothing here for `own` to fix again.
        // Exactly two `own` calls happen in the whole deploy: once for the repository directory made the
        // first time (ensureRepo), once for the checked-out tree before the swap that then failed. The
        // rollback itself adds none.
        assert.equal(context.calls.filter(call => call.startsWith('own ')).length, 2)
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

describe('nested layout', () => {
    const manual = { trigger: 'manual' as const, actor: 'koda' }

    it('leaves a flat live alone while migration is switched off', async () => {
        const t = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.calls.includes('move /var/www/acme.next /var/www/acme'))
    })

    it('moves a flat live into the nested layout inside the window', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        const window = t.calls.slice(t.calls.indexOf('maintenance on'), t.calls.indexOf('maintenance off') + 1)
        assert.deepEqual(window.filter(call => call.startsWith('move') || call.startsWith('compose')), [
            'compose down',
            'move /var/www/acme /var/www/acme.migrating',
            'move /var/www/acme.migrating /var/www/acme/prev/live',
            'move /var/www/acme.next /var/www/acme/live',
            'move /var/www/acme.git /var/www/acme/git',
            'compose up',
        ])
        const live = t.deps.registry().projects.get('acme')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/acme/live')
        assert.equal(live.composeName, 'acme')
        assert.equal(live.deployed, TIP)
        const upArgs = t.composeRuns.at(-1)!
        assert.deepEqual(upArgs.slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme/live'])
    })

    it('puts the flat tree back and starts it when a move fails', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const move = t.deps.fs.move
        t.deps.fs.move = async (from, to) => { if (to === '/var/www/acme/live') throw new Error('EXDEV'); return move(from, to) }
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /moving to \/var\/www\/acme failed/)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme')
        assert.ok(t.calls.includes('move /var/www/acme.migrating /var/www/acme'))
        assert.equal(t.calls.filter(call => call === 'compose up').length, 1)
    })

    it('swaps back on nested paths when the migrated tree is unhealthy, and stays nested', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'], containerState: { state: 'exited' } })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.ok(t.calls.includes('move /var/www/acme/live /var/www/acme/next/live'))
        assert.ok(t.calls.includes('move /var/www/acme/prev/live /var/www/acme/live'))
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
    })

    // What the resume does before the deploy's own work starts: everything up to the first fetch.
    const resumeOf = (calls: string[]) => calls.slice(0, calls.indexOf('fetcher fetch'))
    const neverRemovesTheSite = (calls: string[]) => {
        for (const path of ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/prev', '/var/www/acme/prev/live']) {
            assert.equal(calls.includes(`rmdir ${path}`), false, `rmdir ${path}`)
        }
    }

    // The resume serves the old tree again, never the build the window was about to swap in, which no
    // health check has seen. The build is thrown away (it is never client data) and the deploy rebuilds.
    it('finishes a move interrupted in <site>.migrating, and serves the old tree rather than the build', async () => {
        const t = setup({ existsPaths: ['/var/www/acme.migrating', '/var/www/acme.migrating/docker-compose.yml', '/var/www/acme.next', '/var/www/acme.git', '/var/www/acme.git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const resume = resumeOf(t.calls)
        assert.deepEqual(resume.filter(call => call.startsWith('move') || call.startsWith('rmdir') || call.startsWith('compose')), [
            'move /var/www/acme.migrating /var/www/acme/prev/live',
            'move /var/www/acme.git /var/www/acme/git',
            'rmdir /var/www/acme.next',
            'move /var/www/acme/prev/live /var/www/acme/live',
            'compose up',
        ])
        neverRemovesTheSite(resume)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
        assert.ok(t.fetchRequests.some(request => request.verb === 'checkout' && request.worktree === '/var/www/acme/next/live'))
    })

    // A first deploy moved the repository out to <site>.git before its window, so the old tree at
    // prev/live has no .git, and the undo stopped with the build back at <site>.next.
    it('finishes a stopped undo whose build is still at <site>.next, and serves the old tree', async () => {
        const t = setup({
            existsPaths: [
                '/var/www/acme', '/var/www/acme/prev', '/var/www/acme/prev/live', '/var/www/acme/prev/live/docker-compose.yml',
                '/var/www/acme.next', '/var/www/acme.git', '/var/www/acme.git/.git',
            ],
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const resume = resumeOf(t.calls)
        assert.deepEqual(resume.filter(call => call.startsWith('move') || call.startsWith('rmdir') || call.startsWith('compose')), [
            'move /var/www/acme.git /var/www/acme/git',
            'rmdir /var/www/acme.next',
            'move /var/www/acme/prev/live /var/www/acme/live',
            'compose up',
        ])
        neverRemovesTheSite(resume)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
    })

    it('parks a build that already reached <site>/live in next/live, and serves the old tree', async () => {
        const t = setup({
            existsPaths: [
                '/var/www/acme', '/var/www/acme/prev', '/var/www/acme/prev/live', '/var/www/acme/prev/live/docker-compose.yml',
                '/var/www/acme/live', '/var/www/acme/live/docker-compose.yml', '/var/www/acme.git', '/var/www/acme.git/.git',
            ],
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const resume = resumeOf(t.calls)
        assert.deepEqual(resume.filter(call => /^(move|rmdir|mkdir|own |compose)/.test(call)), [
            'move /var/www/acme.git /var/www/acme/git',
            'mkdir /var/www/acme/next', 'own /var/www/acme/next 1000:1000 775',
            'move /var/www/acme/live /var/www/acme/next/live',
            'move /var/www/acme/prev/live /var/www/acme/live',
            'compose up',
        ])
        neverRemovesTheSite(resume)
    })

    it('removes a stale next/live before parking the build there', async () => {
        const t = setup({
            existsPaths: [
                '/var/www/acme', '/var/www/acme/prev', '/var/www/acme/prev/live', '/var/www/acme/prev/live/docker-compose.yml',
                '/var/www/acme/live', '/var/www/acme/next', '/var/www/acme/next/live', '/var/www/acme.next', '/var/www/acme.git', '/var/www/acme.git/.git',
            ],
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const resume = resumeOf(t.calls)
        assert.deepEqual(resume.filter(call => /^(move|rmdir|mkdir|compose)/.test(call)), [
            'move /var/www/acme.git /var/www/acme/git',
            'rmdir /var/www/acme/next/live',
            'move /var/www/acme/live /var/www/acme/next/live',
            'rmdir /var/www/acme.next',
            'move /var/www/acme/prev/live /var/www/acme/live',
            'compose up',
        ])
        neverRemovesTheSite(resume)
    })

    it('builds a waiting test from the shared repository, then moves it beside live', async () => {
        const t = setup({
            migrateLayout: true, registryYaml: REGISTRY_YAML_TEST,
            existsPaths: ['/var/www/acme', '/var/www/acme/git/.git', '/var/www/acme/live', '/var/www/acme-test', '/var/www/acme-test.git', '/var/www/acme-test.git/.git'],
            owners: { '/var/www/acme': { uid: 1000, gid: 1000, mode: 0o775 }, '/var/www/acme-test': { uid: 1000, gid: 1000, mode: 0o775 } },
            envTree: { '/var/www/acme-test/.env': 'X=1\n' },
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('test')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.fetchRequests.every(request => !('dir' in request) || request.dir === '/var/www/acme/git'))
        assert.ok(t.calls.includes('move /var/www/acme-test /var/www/acme/prev/test'))
        assert.ok(t.calls.includes('move /var/www/acme/next/test /var/www/acme/test'))
        const testEnv = t.deps.registry().projects.get('acme')!.environments.get('test')!
        assert.equal(testEnv.dir, '/var/www/acme/test')
        assert.equal(testEnv.composeName, 'acme-test')
        assert.ok(t.calls.indexOf('rmdir /var/www/acme-test.git') > t.calls.lastIndexOf('registry-write'))
    })

    it('deploys a nested environment through next/<env> and prev/<env>', async () => {
        const t = setup({
            registryYaml: REGISTRY_YAML_NESTED,
            existsPaths: ['/var/www/acme', '/var/www/acme/git/.git', '/var/www/acme/test'],
            owners: { '/var/www/acme': { uid: 1000, gid: 1000, mode: 0o775 }, '/var/www/acme/test': { uid: 1000, gid: 1000, mode: 0o775 } },
            envTree: { '/var/www/acme/test/.env': 'X=1\n' },
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('test')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.calls.includes('mkdir /var/www/acme/next'))
        assert.ok(t.calls.includes('move /var/www/acme/test /var/www/acme/prev/test'))
        assert.ok(t.calls.includes('move /var/www/acme/next/test /var/www/acme/test'))
    })

    // The state a failed set-layout, or a stop between the window and the write, leaves: the registry
    // says flat, and the repository is only in the nested layout. The poller has to find it there, or it
    // skips the site on every poll and the deploy that records the move is never started.
    it('polls a live that moved but was never recorded from the nested repository', async () => {
        const t = setup({ existsPaths: ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const result = await currentTip(project, project.environments.get('live')!, t.deps)
        assert.deepEqual(result, { ok: true, commit: TIP })
        assert.deepEqual(t.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme/git', branch: 'main', credential: null })
    })

    it('only records a move that finished on disk, with no flag of its own, then deploys nested', async () => {
        const t = setup({ existsPaths: ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        // One flag, the deploy's own window, and the move was recorded before it.
        assert.equal(t.calls.filter(call => call === 'maintenance on').length, 1)
        assert.ok(t.calls.indexOf('registry-write') < t.calls.indexOf('maintenance on'))
        assert.equal(t.calls.slice(0, t.calls.indexOf('maintenance on')).some(call => call.startsWith('move')), false)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
        assert.ok(t.calls.includes('move /var/www/acme/next/live /var/www/acme/live'))
    })

    // A stop between the window's last rename and its up leaves the site on disk as a finished move with
    // nothing running. The resume cannot tell that apart from a healthy move whose registry write failed,
    // so it always starts the nested tree, which changes nothing for one already running.
    it('starts a move that finished on disk once, where it now lives, before the deploy goes on', async () => {
        const t = setup({ existsPaths: ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const before = t.calls.slice(0, t.calls.indexOf('fetcher fetch'))
        assert.deepEqual(before.filter(call => call.startsWith('compose')), ['compose up'])
        assert.ok(before.indexOf('compose up') < before.indexOf('registry-write'))
        assert.deepEqual(t.composeRuns[0]!.slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme/live'])
        assert.ok(t.composeRuns[0]!.includes('--no-build'))
    })

    it('logs a resumed move that will not start, and deploys anyway', async () => {
        const t = setup({ existsPaths: ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git'], composeResults: { up: { exitCode: 1 } } })
        const project = t.deps.registry().projects.get('acme')!
        await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.ok(t.logs.some(line => line.includes('/var/www/acme/live did not start')))
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
        assert.ok(t.fetchRequests.some(request => request.verb === 'checkout'))
    })

    it('fails, without deploying, when the registry cannot record a resumed move', async () => {
        const t = setup({ registryWriteFails: true, existsPaths: ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /migrated, but the registry could not be updated/)
        assert.equal(t.fetchRequests.some(request => request.verb === 'checkout'), false)
        assert.equal(t.calls.includes('maintenance on'), false)
    })

    // Deploying it flat would rename a folder hostd cannot read to .prev, and the deploy after that would
    // delete it. So the deploy is refused, whether or not migration is on, and the operator looks.
    for (const migrateLayout of [true, false]) {
        it(`refuses to deploy a live folder that is neither layout, touching nothing (migration ${migrateLayout ? 'on' : 'off'})`, async () => {
            const t = setup({ migrateLayout, existsPaths: ['/var/www/acme/.git'] })
            const project = t.deps.registry().projects.get('acme')!
            const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
            assert.equal(record.outcome, 'failed')
            assert.match(record.reason ?? '', /\/var\/www\/acme is neither flat nor nested/)
            assert.equal(t.fetchRequests.length, 0)
            assert.equal(t.calls.some(call => call.startsWith('move') || call.startsWith('rmdir') || call.startsWith('compose')), false)
            assert.equal(t.calls.includes('maintenance on'), false)
            assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme')
        })
    }

    // A test whose undo stopped leaves its old tree at prev/test and nothing at either of its own places.
    it('refuses to deploy a test that is neither layout, leaving its old tree at prev/test', async () => {
        const t = setup({
            migrateLayout: true, registryYaml: REGISTRY_YAML_TEST,
            existsPaths: ['/var/www/acme', '/var/www/acme/git/.git', '/var/www/acme/live', '/var/www/acme/prev/test', '/var/www/acme-test.git/.git'],
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('test')!, manual, t.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /neither flat nor nested/)
        assert.equal(t.fetchRequests.length, 0)
        assert.equal(t.calls.some(call => call.startsWith('move') || call.startsWith('rmdir') || call.startsWith('compose')), false)
        assert.ok(t.exists.has('/var/www/acme/prev/test'))
    })

    it('says the registry could not record the move when set-layout fails after the window', async () => {
        const t = setup({ migrateLayout: true, registryWriteFails: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /deployed and moved to \/var\/www\/acme, but the registry could not be updated/)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.deployed, 'abc1234')
    })

    it('keeps a migrated rollback rolled back when set-layout fails, and says so', async () => {
        const t = setup({
            migrateLayout: true, registryWriteFails: true, containerState: { state: 'exited' },
            existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'],
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /rolled back to the previous copy; moved to \/var\/www\/acme, but the registry could not be updated/)
    })

    // Recursive removal of the folders the move made, after a move back out of them failed, would take
    // the site's own tree (at prev/live) with it. The undo stops instead, and the next deploy goes on.
    it('stops an undo it cannot finish, removes nothing, and the next deploy completes the move', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const move = t.deps.fs.move
        t.deps.fs.move = async (from, to) => {
            if (to === '/var/www/acme/live' || (from === '/var/www/acme/prev/live' && to === '/var/www/acme.migrating')) throw new Error('EXDEV')
            return move(from, to)
        }
        let project = t.deps.registry().projects.get('acme')!
        const first = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(first.outcome, 'failed')
        assert.match(first.reason ?? '', /moving to \/var\/www\/acme failed at .*; the undo did not finish either, so the next deploy completes the move/)
        assert.equal(t.calls.some(call => call === 'rmdir /var/www/acme' || call === 'rmdir /var/www/acme/prev' || call.startsWith('rmdir-empty')), false)
        assert.equal(t.calls.includes('compose up'), false)
        assert.equal(t.maintenance.size, 0)

        t.deps.fs.move = move
        project = t.deps.registry().projects.get('acme')!
        const second = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(second.outcome, 'ok', second.reason ?? '')
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
    })
})
