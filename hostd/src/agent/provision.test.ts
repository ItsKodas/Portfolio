import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'

import { createProject, addEnvironment, removeProject, notPublishedProblem, type ProvisionDeps } from './provision.ts'
import { RegistryWriter, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { EnvFs } from './env-files.ts'
import { lifecycleArgv, type GuessedService, type Runner, type RunResult } from './compose.ts'
import type { ProvisionCreateArgs, ProvisionAddEnvironmentArgs } from '../shared/protocol.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'
import type { PortVerdict } from '../shared/ports.ts'
import type { PortOverrideResult } from './port-override.ts'

const REGISTRY_PATH = '/etc/hostd/projects.yaml'

const REGISTRY_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [provision, env]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
  other:
    client: cl_2
    name: Other
    repo: git@github.com:ItsKodas/other.git
    services:
      web: { role: site }
    environments:
      live:
        dir: /var/www/other
        branch: main
        domain: other.example.com
        port: 5011
`

// acme again, already in the nested layout: live under /var/www/acme/live, with the site's one shared
// repository at /var/www/acme/git beside it once created.
const NESTED_LIVE_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [provision, env]
    environments:
      live:
        dir: /var/www/acme/live
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
`

// A tiny in-memory env-file tree, keyed by full posix path to contents, enough to exercise the
// copy-and-rewrite step in addEnvironment without ever touching a real disk (env-files.test.ts uses the
// same approach for the same reason). No symlink support: that boundary is Task 5's own coverage.
function fakeEnvFs(tree: Record<string, string> = {}) {
    const files = new Map(Object.entries(tree))
    const fs: EnvFs = {
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
            const text = files.get(from)
            if (text === undefined) throw new Error(`ENOENT: no such file, rename '${from}'`)
            files.delete(from)
            files.set(to, text)
        },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return { size: Buffer.byteLength(text) }
        },
        async realpath(path) { return path },
    }
    return { fs, files }
}

type SetupOptions = {
    registryYaml?: string
    cloneResult?: FetchReply
    // Per verb, for the fetch, tip and checkout a nested test environment is made with; any verb not
    // named here answers like a successful clone.
    fetchResults?: Partial<Record<FetchRequest['verb'], FetchReply>>
    resolveResult?: { ok: true, services: Record<string, GuessedService>, published: number[] } | { ok: false, problem: string }
    portResult?: { ok: true, port: number } | { ok: false, problem: string }
    checkResult?: PortVerdict
    setPortResult?: { ok: true, previous: string | null } | { ok: false, problem: string }
    existsPaths?: string[]
    envTree?: Record<string, string>
    runnerResult?: Partial<RunResult>
    owners?: Record<string, { uid: number, gid: number, mode: number }>
    overrideResult?: PortOverrideResult
}

// Every dependency is a plain recorder, in the style the rest of hostd's tests use: no mocking library,
// just a factory that hands back both the fakes and the calls they made, so a test can assert on order
// and on what was never called, not only on the final reply.
function setup(options: SetupOptions = {}) {
    const yaml = options.registryYaml ?? REGISTRY_YAML
    const registry = parseRegistry(yaml)
    const calls: string[] = []
    const mkdirs: string[] = []
    const rmdirs: string[] = []
    const moves: string[] = []
    const cloneRequests: FetchRequest[] = []
    const fetchRequests: FetchRequest[] = []
    // Every disk-shaping step in order, with its paths: `mkdir <dir>`, `move <from> <to>`, `rmdir <dir>`,
    // and each fetcher call as `<verb> <dir>` (a checkout names its worktree instead). `calls` keeps only
    // the bare step names, which the ordering tests below compare whole.
    const steps: string[] = []
    const logs: string[] = []
    const runnerCalls: Array<{ command: string, args: string[] }> = []
    const resolveCalls: Array<{ expectedName: string, dir: string, composePaths: string[], collidesWith?: string }> = []
    const ownerPaths: string[] = []
    const ownCalls: Array<{ dir: string, like: { uid: number, gid: number, mode: number } }> = []
    const portEnvCalls: Array<{ dir: string, key: string, port: number }> = []
    const overrideCalls: Array<{ dir: string, composePaths: string[], portEnv: string }> = []

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
            calls.push('write')
        },
        unlink: async () => {},
    }
    const writer = new RegistryWriter(REGISTRY_PATH, registryFs)
    const exists = new Set(options.existsPaths ?? [])
    const { fs: envFs, files: envFsFiles } = fakeEnvFs(options.envTree ?? {})
    // What /var/www and an existing site directory under it are owned by and moded as before any of this
    // runs: uid 1000, gid 1000, drwxrwxr-x, the same fixture deploy.test.ts uses for a site directory on
    // the dedi. A test wanting a different owner (an operator who chose something else) overwrites the
    // map by path.
    const owners = new Map<string, { uid: number, gid: number, mode: number }>(
        Object.entries(options.owners ?? { '/var/www': { uid: 1000, gid: 1000, mode: 0o775 }, '/var/www/acme': { uid: 1000, gid: 1000, mode: 0o775 } }),
    )

    const deps: ProvisionDeps = {
        registry: () => registry,
        // Not tracked in calls: it is not a disk or registry side effect the ordering tests below care
        // about, only a precondition that the fixed registry above is already what a refresh would see.
        refreshRegistry: async () => {},
        writer,
        fetcher: {
            call: async request => {
                calls.push(request.verb)
                fetchRequests.push(request)
                if (request.verb === 'clone') cloneRequests.push(request)
                steps.push(`${request.verb} ${request.verb === 'checkout' ? request.worktree : 'dir' in request ? request.dir : ''}`)
                return options.fetchResults?.[request.verb] ?? options.cloneResult ?? { ok: true, commit: 'abc1234' }
            },
        },
        choosePort: async () => {
            calls.push('choosePort')
            return options.portResult ?? { ok: true, port: 5100 }
        },
        checkPort: async () => {
            calls.push('checkPort')
            return options.checkResult ?? { ok: true }
        },
        setPortEnv: async (environment, key, port) => {
            calls.push('setPortEnv')
            portEnvCalls.push({ dir: environment.dir, key, port })
            return options.setPortResult ?? { ok: true, previous: null }
        },
        portOverride: async (location, portEnv) => {
            calls.push('portOverride')
            overrideCalls.push({ dir: location.dir, composePaths: location.composePaths, portEnv })
            return options.overrideResult ?? { ok: true, composePaths: [...location.composePaths, posix.join(location.dir, 'hostd.ports.yml')], service: 'web', target: 3000 }
        },
        removePortOverride: async () => { calls.push('removePortOverride') },
        mkdir: async dir => { calls.push('mkdir'); mkdirs.push(dir); steps.push(`mkdir ${dir}`) },
        move: async (from, to) => { calls.push('move'); moves.push(`${from} ${to}`); steps.push(`move ${from} ${to}`) },
        rmdir: async dir => { calls.push('rmdir'); rmdirs.push(dir); steps.push(`rmdir ${dir}`) },
        exists: async dir => { calls.push('exists'); return exists.has(dir) },
        owner: async path => {
            calls.push('owner')
            ownerPaths.push(path)
            const found = owners.get(path)
            if (!found) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
            return found
        },
        own: async (dir, like) => { calls.push('own'); ownCalls.push({ dir, like }) },
        resolve: async (expectedName, dir, composePaths, collidesWith) => {
            calls.push('resolve')
            resolveCalls.push({ expectedName, dir, composePaths, collidesWith })
            return options.resolveResult ?? { ok: true, services: { web: { role: 'site' } }, published: [5100] }
        },
        runner: (async (command, args) => {
            runnerCalls.push({ command, args })
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...options.runnerResult }
        }) as Runner,
        log: message => logs.push(message),
    }

    return { deps, registry, calls, steps, mkdirs, moves, rmdirs, cloneRequests, fetchRequests, logs, registryFiles, envFs, envFsFiles, runnerCalls, resolveCalls, ownerPaths, ownCalls, portEnvCalls, overrideCalls }
}

const createArgs = (overrides: Partial<ProvisionCreateArgs> = {}): ProvisionCreateArgs => ({
    action: 'create',
    id: 'bakery',
    client: 'cl_2',
    name: 'Bakery',
    repo: 'git@github.com:ItsKodas/bakery.git',
    branch: 'main',
    domain: 'bakery.com',
    certificate: 'letsencrypt',
    ...overrides,
})

describe('createProject', () => {
    it('creates the folder, clones, reads the compose file, writes the registry, and reports needs-setup', async () => {
        const { deps, mkdirs, cloneRequests, registryFiles, resolveCalls } = setup()
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: true, project: { id: 'bakery', state: 'needs-setup' }, envFiles: [] })
        assert.deepEqual(mkdirs, ['/var/www/bakery', '/var/www/bakery/live', '/var/www/bakery/git'])
        assert.deepEqual(cloneRequests, [{ verb: 'clone', repo: 'git@github.com:ItsKodas/bakery.git', dir: '/var/www/bakery/live', branch: 'main', credential: null }])
        // The expected compose name is the project id, the default for a nested live, with no collision to
        // guard against: live has no other environment yet.
        assert.deepEqual(resolveCalls, [{ expectedName: 'bakery', dir: '/var/www/bakery/live', composePaths: ['/var/www/bakery/live/docker-compose.yml', '/var/www/bakery/live/hostd.ports.yml'], collidesWith: undefined }])

        const written = parseRegistry(registryFiles.get(REGISTRY_PATH)!)
        const bakery = written.projects.get('bakery')
        assert.ok(bakery)
        assert.equal(bakery.repo, 'git@github.com:ItsKodas/bakery.git')
        assert.equal(bakery.environments.get('live')?.domain, 'bakery.com')
        assert.equal(bakery.environments.get('live')?.port, 5100)
        assert.deepEqual(bakery.services, { web: { role: 'site' } })
    })

    it('creates into the folder the create named, resolving and registering every compose file it listed', async () => {
        const { deps, mkdirs, cloneRequests, registryFiles, resolveCalls } = setup()
        const reply = await createProject(createArgs({
            client: undefined, dir: 'bakery_site', compose: ['docker-compose.yml', 'docker-compose.prod.yml'],
            capabilities: ['lifecycle', 'logs', 'deploy'], websockets: true, flexibleSsl: true,
        }), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(mkdirs, ['/var/www/bakery_site', '/var/www/bakery_site/live', '/var/www/bakery_site/git'])
        assert.deepEqual(cloneRequests, [{ verb: 'clone', repo: 'git@github.com:ItsKodas/bakery.git', dir: '/var/www/bakery_site/live', branch: 'main', credential: null }])
        // The id, not the folder's name: a nested live runs under its project id, whatever its site
        // folder is called, so an unpinned compose file never resolves to the folder name here.
        assert.deepEqual(resolveCalls, [{
            expectedName: 'bakery', dir: '/var/www/bakery_site/live',
            composePaths: ['/var/www/bakery_site/live/docker-compose.yml', '/var/www/bakery_site/live/docker-compose.prod.yml', '/var/www/bakery_site/live/hostd.ports.yml'], collidesWith: undefined,
        }])

        const bakery = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')!
        assert.equal(bakery.client, null)
        assert.deepEqual([...bakery.capabilities], ['lifecycle', 'logs', 'deploy'])
        const live = bakery.environments.get('live')!
        assert.equal(live.dir, '/var/www/bakery_site/live')
        assert.equal(live.composeName, 'bakery')
        assert.deepEqual(live.composePaths, ['/var/www/bakery_site/live/docker-compose.yml', '/var/www/bakery_site/live/docker-compose.prod.yml', '/var/www/bakery_site/live/hostd.ports.yml'])
        assert.equal(live.websockets, true)
        assert.equal(live.flexibleSsl, true)
    })

    it('refuses a folder that already exists under the name the create gave, before touching anything', async () => {
        const { deps, mkdirs } = setup()
        const reply = await createProject(createArgs({ dir: 'taken' }), { ...deps, exists: async dir => dir === '/var/www/taken' })
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: '/var/www/taken already exists' })
        assert.deepEqual(mkdirs, [])
    })

    // A deleted environment's volumes still carry its compose name until the purge removes them, so a new
    // site running under that name would start on another client's data
    it('refuses an id that is the compose name of a deleted environment, before touching anything', async () => {
        const { deps, mkdirs, cloneRequests } = setup()
        const asked: string[] = []
        const reply = await createProject(createArgs(), {
            ...deps,
            composeNameDeleted: async name => { asked.push(name); return name === 'bakery' ? 'shop uat1' : null },
        })
        assert.deepEqual(reply, {
            ok: false, code: 'bad-request',
            message: 'bakery would run under the compose name bakery, which the deleted environment shop uat1 still holds with its volumes; restore it or wait for it to be purged',
        })
        assert.deepEqual(asked, ['bakery'])
        assert.deepEqual(mkdirs, [])
        assert.deepEqual(cloneRequests, [])
    })

    it('creates when no deleted environment holds the compose name', async () => {
        const { deps } = setup()
        const reply = await createProject(createArgs(), { ...deps, composeNameDeleted: async () => null })
        assert.equal(reply.ok, true)
    })

    it('clones a new project with the credential the create named', async () => {
        const { deps, cloneRequests } = setup()
        await createProject(createArgs({ credential: 'acme' }), deps)
        assert.deepEqual(cloneRequests, [{ verb: 'clone', repo: 'git@github.com:ItsKodas/bakery.git', dir: '/var/www/bakery/live', branch: 'main', credential: 'acme' }])
    })

    // The registry entry has to carry it too, or the first deploy after creation fetches with the
    // default token and fails on a repository the clone could read.
    it('writes the credential onto the new entry', async () => {
        const { deps, registryFiles } = setup()
        await createProject(createArgs({ credential: 'acme' }), deps)
        const bakery = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')
        assert.equal(bakery?.credential, 'acme')
    })

    it('writes a database service resolve guessed, not only site services', async () => {
        const { deps, registryFiles } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' }, db: { role: 'database', engine: 'postgres' } }, published: [5100] } })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, true)
        const bakery = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')
        assert.deepEqual(bakery?.services, { web: { role: 'site' }, db: { role: 'database', engine: 'postgres', dump: {} } })
    })

    it('does those in order, so nothing is registered before it exists on disk', async () => {
        const { deps, calls } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(calls, ['exists', 'choosePort', 'mkdir', 'mkdir', 'clone', 'mkdir', 'move', 'setPortEnv', 'portOverride', 'owner', 'own', 'resolve', 'write'])
    })

    it('writes the chosen port into .env under WEB_PORT before resolving', async () => {
        const { deps, portEnvCalls, calls } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(portEnvCalls, [{ dir: '/var/www/bakery/live', key: 'WEB_PORT', port: 5100 }])
        assert.ok(calls.indexOf('setPortEnv') < calls.indexOf('resolve'))
    })

    it('uses the port it was given, checked, instead of choosing one', async () => {
        const { deps, calls, portEnvCalls, registryFiles } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' } }, published: [5012] } })
        const reply = await createProject(createArgs({ port: 5012 }), deps)
        assert.equal(reply.ok, true)
        assert.ok(calls.includes('checkPort'))
        assert.ok(!calls.includes('choosePort'))
        assert.equal(portEnvCalls[0]?.port, 5012)
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')?.environments.get('live')?.port, 5012)
    })

    it('refuses a port the check refuses, before touching the disk', async () => {
        const { deps, calls } = setup({ checkResult: { ok: false, code: 'bad-request', problem: 'port 5004 is in use on the host' } })
        const reply = await createProject(createArgs({ port: 5004 }), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'port 5004 is in use on the host' })
        assert.ok(!calls.includes('mkdir'))
    })

    it('refuses as unavailable when the host could not be read', async () => {
        const { deps } = setup({ checkResult: { ok: false, code: 'unavailable', problem: 'could not read the host\'s ports: the probe timed out' } })
        const reply = await createProject(createArgs({ port: 5012 }), deps)
        assert.equal(reply.ok === false && reply.code, 'unavailable')
    })

    it('rolls back when no service publishes the port', async () => {
        const { deps, rmdirs, calls } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' } }, published: [3000] } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'invalid-project', message: notPublishedProblem('/var/www/bakery/live', 5100) })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.ok(!calls.includes('write'))
    })

    it('writes the override from the repo\'s own files after the port is in .env', async () => {
        const { deps, overrideCalls, calls, logs } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(overrideCalls, [{ dir: '/var/www/bakery/live', composePaths: ['/var/www/bakery/live/docker-compose.yml'], portEnv: 'WEB_PORT' }])
        assert.ok(calls.indexOf('setPortEnv') < calls.indexOf('portOverride'))
        assert.ok(calls.indexOf('portOverride') < calls.indexOf('own'))
        assert.ok(logs.includes('provision bakery: published 5100 to web:3000'), logs.join('\n'))
    })

    it('records the override as the last compose file', async () => {
        const { deps, registryFiles } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')?.environments.get('live')?.composePaths,
            ['/var/www/bakery/live/docker-compose.yml', '/var/www/bakery/live/hostd.ports.yml'])
    })

    it('rolls back when the override cannot be built', async () => {
        const problem = 'web does not say which port it listens on; add expose: ["3000"] (the port inside the container) to it in the compose file'
        const { deps, rmdirs, calls } = setup({ overrideResult: { ok: false, problem } })
        assert.deepEqual(await createProject(createArgs(), deps), { ok: false, code: 'invalid-project', message: problem })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.ok(!calls.includes('resolve'))
        assert.ok(!calls.includes('write'))
    })

    it('rolls back when .env cannot be written', async () => {
        const { deps, rmdirs } = setup({ setPortResult: { ok: false, problem: 'the env file could not be written: EACCES' } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'the env file could not be written: EACCES' })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
    })

    // The clone runs as root, in the fetcher, and the empty env files the step after it creates are
    // written as root here, so everything under /var/www/bakery (live, and the repository split out
    // beside it) belongs to root until this runs. A brand
    // new project has no sibling directory of its own to read an owner from, so the pattern is the
    // parent, /var/www itself: the folder this one is being created inside, which already belongs to
    // whoever the operator is. Read, never assumed, exactly as deploy.ts reads a site directory.
    it('gives the cloned tree the ownership and mode /var/www itself has, not root\'s', async () => {
        const { deps, ownerPaths, ownCalls } = setup()
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(ownerPaths, ['/var/www'])
        assert.deepEqual(ownCalls, [{ dir: '/var/www/bakery', like: { uid: 1000, gid: 1000, mode: 0o775 } }])
    })

    it('takes whatever ownership and mode /var/www actually has, rather than a fixed uid', async () => {
        const { deps, ownCalls } = setup({ owners: { '/var/www': { uid: 33, gid: 33, mode: 0o750 } } })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(ownCalls, [{ dir: '/var/www/bakery', like: { uid: 33, gid: 33, mode: 0o750 } }])
    })

    // Before resolve and before the registry write: a tree nothing but root can read is not a project the
    // operator can fill an env file in or start by hand, so registering it would record a site that looks
    // created and is not usable.
    it('owns the tree before it resolves the compose file or registers anything', async () => {
        const { deps, calls } = setup()
        await createProject(createArgs(), deps)
        assert.ok(calls.includes('own'))
        assert.ok(calls.indexOf('own') < calls.indexOf('resolve'))
        assert.ok(calls.indexOf('own') < calls.indexOf('write'))
    })

    it('removes the folder and writes nothing when the cloned tree cannot be given that ownership', async () => {
        const { deps, calls, rmdirs } = setup()
        deps.own = async () => { throw new Error('operation not permitted') }
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /operation not permitted/)
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.equal(calls.includes('write'), false)
    })

    // The store only reloads on its own 10 second timer, so a create issued right after another one could
    // otherwise see an id, domain or port that one just took as still free. Refreshing only inside
    // choosePort would not be enough: the id and domain checks run before it. This proves the refresh
    // actually happens before those checks, not merely that a refreshRegistry field exists: registry()
    // starts out clean, and only refreshRegistry flips it to a snapshot where "bakery" is already taken.
    it('refreshes the registry before checking id, domain and port, not only inside choosePort', async () => {
        const { deps } = setup()
        const claimed = parseRegistry(`${REGISTRY_YAML}  bakery:
    client: cl_9
    name: Someone Else
    repo: git@github.com:ItsKodas/someone-else.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/bakery, branch: main, domain: someone-else.com, port: 5099 }
`)
        let registry = parseRegistry(REGISTRY_YAML)
        const reply = await createProject(createArgs(), {
            ...deps,
            registry: () => registry,
            refreshRegistry: async () => { registry = claimed },
        })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.match(reply.ok === false ? reply.message : '', /bakery is already registered/)
    })

    it('removes the folder and writes nothing when the clone fails', async () => {
        const { deps, calls, rmdirs } = setup({ cloneResult: { ok: false, code: 'failed', message: 'git clone failed: authentication required' } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git clone failed: authentication required' })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes the folder and writes nothing when the compose file has no site service', async () => {
        const { deps: emptyDeps, rmdirs: emptyRmdirs, calls: emptyCalls } = setup({ resolveResult: { ok: true, services: {}, published: [] } })
        const empty = await createProject(createArgs(), emptyDeps)
        assert.equal(empty.ok, false)
        assert.equal(empty.ok === false && empty.code, 'invalid-project')
        assert.deepEqual(emptyRmdirs, ['/var/www/bakery'])
        assert.equal(emptyCalls.includes('write'), false)

        const { deps: failDeps, rmdirs: failRmdirs } = setup({ resolveResult: { ok: false, problem: 'docker compose config failed' } })
        const failed = await createProject(createArgs(), failDeps)
        assert.equal(failed.ok, false)
        assert.equal(failed.ok === false && failed.code, 'invalid-project')
        assert.deepEqual(failRmdirs, ['/var/www/bakery'])
    })

    it('removes the folder and writes nothing when the registry write fails', async () => {
        const { deps, rmdirs, calls } = setup()
        // The write step reads the registry file itself right before editing it; a failure there (the
        // disk having gone away, a permissions change) surfaces as an ordinary write failure, same as
        // any other reason applyChange might refuse.
        const brokenWriter = new RegistryWriter(REGISTRY_PATH, {
            readFile: async () => Promise.reject(new Error('the registry file is gone')),
            stat: async () => ({ mode: 0o664, uid: 1000, gid: 1000 }),
            writeFile: async () => {},
            chmod: async () => {},
            chown: async () => {},
            rename: async () => {},
            unlink: async () => {},
        })
        const reply = await createProject(createArgs(), { ...deps, writer: brokenWriter })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.deepEqual(calls, ['exists', 'choosePort', 'mkdir', 'mkdir', 'clone', 'mkdir', 'move', 'setPortEnv', 'portOverride', 'owner', 'own', 'resolve', 'rmdir'])
    })

    it('refuses an id that is taken, reserved or malformed, before touching the disk', async () => {
        for (const id of ['Bad_ID', 'acme', 'hostd']) {
            const { deps, calls } = setup()
            const reply = await createProject(createArgs({ id }), deps)
            assert.equal(reply.ok, false, id)
            assert.equal(reply.ok === false && reply.code, 'bad-request', id)
            assert.deepEqual(calls, [], id)
        }
    })

    // Must-exist, per the whole-branch review: the port check's registry side only ever sees
    // registry.projects, which excludes anything already invalid, and the host's listening ports only show
    // what is running, so a temporarily invalid entry whose containers are stopped is invisible to both.
    // Refusing outright while anything is invalid is the honest fix, named here rather than only in
    // ports.ts, since that is where provisioning as a whole is refused.
    it('refuses provisioning entirely while the registry has any invalid entry, naming it', async () => {
        const yaml = `${REGISTRY_YAML}  broken:\n    client: cl_9\n`
        const { deps, calls } = setup({ registryYaml: yaml })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'unavailable')
        assert.match(reply.ok === false ? reply.message : '', /broken/)
        assert.deepEqual(calls, [])
    })

    it('refuses when the folder already exists, before cloning', async () => {
        const { deps, calls } = setup({ existsPaths: ['/var/www/bakery'] })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.deepEqual(calls, ['exists'])
    })

    it('refuses when no port is free, before touching the disk', async () => {
        const { deps, calls } = setup({ portResult: { ok: false, problem: 'no free port 5000 to 5999' } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'unavailable', message: 'no free port 5000 to 5999' })
        assert.deepEqual(calls, ['exists', 'choosePort'])
    })

    it('refuses a domain another project already uses', async () => {
        const { deps, calls } = setup()
        const reply = await createProject(createArgs({ domain: 'other.example.com' }), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.deepEqual(calls, ['exists'])
    })

    // A throw is not a returned failure, but it must roll back exactly the same way: the fetcher's own
    // client throws FetcherUnavailableError on a timeout, a connection failure or an early close, and a
    // real mkdir/rmdir/resolve can throw too. Nothing here may assume a dependency can only fail by
    // returning `ok: false`.
    it('rolls back when the fetcher throws instead of returning a failure', async () => {
        const { deps, rmdirs, calls } = setup({
            registryYaml: REGISTRY_YAML,
        })
        const throwingFetcher: ProvisionDeps['fetcher'] = { call: async () => { throw new Error('the fetcher connection failed: socket reset') } }
        const reply = await createProject(createArgs(), { ...deps, fetcher: throwingFetcher })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.equal(calls.includes('write'), false)
    })

    it('rolls back when resolve throws instead of returning a failure', async () => {
        const { deps, rmdirs } = setup()
        const throwingResolve: ProvisionDeps['resolve'] = async () => { throw new Error('docker is not answering') }
        const reply = await createProject(createArgs(), { ...deps, resolve: throwingResolve })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
    })

    // Nothing of this call's making is on disk yet when mkdir itself is what fails: in particular an
    // EEXIST means the folder already belongs to something else, and removing it would delete contents
    // this call never created.
    it('does not attempt to remove the folder when mkdir itself throws', async () => {
        const { deps, rmdirs } = setup()
        const throwingMkdir: ProvisionDeps['mkdir'] = async () => { throw new Error('EEXIST: file already exists') }
        const reply = await createProject(createArgs(), { ...deps, mkdir: throwingMkdir })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, [])
    })

    // The single global provisioning lock in agent.ts is the primary defense against two overlapping
    // creates; this is the fallback inside provision.ts itself, for whatever reaches the write despite
    // that lock. `conflict: true` is registry-write.ts's own structural signal, not a message a test (or
    // a future reword of that message) could accidentally stop matching.
    it('does not remove its folder when the registry write fails with a structural conflict', async () => {
        const { deps, rmdirs } = setup()
        const conflictingWriter = { write: async () => ({ ok: false, problem: 'bakery already exists', conflict: true as const }) } as unknown as RegistryWriter
        const reply = await createProject(createArgs(), { ...deps, writer: conflictingWriter })
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'bakery already exists' })
        assert.deepEqual(rmdirs, [])
    })

    it('still removes its folder when the write fails for an unrelated reason, conflict or not in the message text', async () => {
        const { deps, rmdirs } = setup()
        // The wording alone must not be enough to suppress the rollback: only the structural conflict
        // flag does. A message that happens to contain "already exists" without the flag set still rolls
        // back, proving the check reads the flag, not the text.
        const lookalike = { write: async () => ({ ok: false, problem: 'a project named bakery already exists somewhere unrelated' }) } as unknown as RegistryWriter
        const reply = await createProject(createArgs(), { ...deps, writer: lookalike })
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
    })

    // The end-to-end version of the two tests above: a real RegistryWriter, backed by the in-memory fs
    // fake, actually refusing a real conflict, rather than a fake writer asserting the shape we expect it
    // to produce.
    it('does not roll back when a real RegistryWriter meets a genuine conflict at write time', async () => {
        const { deps, rmdirs, registryFiles } = setup()
        // Simulate a winner having registered "bakery" between this call's own pre-checks (which already
        // read the registry() snapshot, taken before this) and its own write: the file on disk now has an
        // entry this call's snapshot never saw, exactly the race the global lock in agent.ts exists to
        // prevent, exercised here directly against provision.ts's own fallback.
        const withBakery = `${REGISTRY_YAML}  bakery:
    client: cl_9
    name: Someone Else
    repo: git@github.com:ItsKodas/someone-else.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/bakery, branch: main, domain: someone-else.com, port: 5099 }
`
        registryFiles.set(REGISTRY_PATH, withBakery)
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /bakery already exists/)
        assert.deepEqual(rmdirs, [])
    })
})

// acme nested, with a test environment already beside live: what a site that added test before
// environments could take any name looks like.
const NESTED_WITH_TEST_YAML = `${NESTED_LIVE_YAML}      test:
        dir: /var/www/acme/test
        branch: develop
        domain: test.acme.com
        port: 5110
        certificate: letsencrypt
`

describe('addEnvironment', () => {
    const project = (yaml = NESTED_LIVE_YAML): ProjectEntry => parseRegistry(yaml).projects.get('acme')!
    const args = (overrides: Partial<ProvisionAddEnvironmentArgs> = {}): ProvisionAddEnvironmentArgs => ({
        action: 'add-environment', environment: 'uat1', branch: 'develop', domain: 'uat1.acme.com', certificate: 'letsencrypt',
        ...overrides,
    })
    // A nested site with its shared repository in place, which every add needs
    const nested = (options: SetupOptions = {}) => setup({ registryYaml: NESTED_LIVE_YAML, existsPaths: ['/var/www/acme/git/.git'], ...options })

    it('adds uat1 to a nested site as a worktree of the shared repository, with its own compose name, env files and port', async () => {
        const { deps, steps, fetchRequests, resolveCalls, portEnvCalls, overrideCalls, registryFiles, envFs, envFsFiles } = nested({
            portResult: { ok: true, port: 5200 },
            resolveResult: { ok: true, services: { web: { role: 'site' } }, published: [5200] },
            envTree: { '/var/www/acme/live/.env': 'SITE_URL=https://acme.com\nDATABASE_URL=postgres://user:pw@db:5432/acme\n' },
        })
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.deepEqual(fetchRequests, [
            { verb: 'fetch', dir: '/var/www/acme/git', branch: 'develop', credential: null },
            { verb: 'tip', dir: '/var/www/acme/git', branch: 'develop' },
            { verb: 'checkout', dir: '/var/www/acme/git', worktree: '/var/www/acme/uat1', commit: 'abc1234' },
        ])
        assert.deepEqual(steps, ['fetch /var/www/acme/git', 'tip /var/www/acme/git', 'checkout /var/www/acme/uat1'])
        assert.equal(envFsFiles.get('/var/www/acme/uat1/.env'), 'SITE_URL=https://uat1.acme.com\nDATABASE_URL=postgres://user:pw@db:5432/acme-uat1\n')
        assert.deepEqual(portEnvCalls, [{ dir: '/var/www/acme/uat1', key: 'WEB_PORT', port: 5200 }])
        assert.deepEqual(overrideCalls, [{ dir: '/var/www/acme/uat1', composePaths: ['/var/www/acme/uat1/docker-compose.yml'], portEnv: 'WEB_PORT' }])
        assert.deepEqual(resolveCalls, [{
            expectedName: 'acme-uat1', dir: '/var/www/acme/uat1', composePaths: ['/var/www/acme/uat1/docker-compose.yml', '/var/www/acme/uat1/hostd.ports.yml'], collidesWith: 'acme',
        }])

        const uat1 = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('acme')!.environments.get('uat1')!
        assert.equal(uat1.dir, '/var/www/acme/uat1')
        assert.equal(uat1.composeName, 'acme-uat1')
        assert.equal(uat1.port, 5200)
        assert.equal(uat1.domain, 'uat1.acme.com')
        assert.equal(uat1.branch, 'develop')
        assert.deepEqual(uat1.composePaths, ['/var/www/acme/uat1/docker-compose.yml', '/var/www/acme/uat1/hostd.ports.yml'])
        assert.doesNotMatch(registryFiles.get(REGISTRY_PATH)!, /composeName/)
    })

    it('adds a second environment beside an existing test one', async () => {
        const { deps, registryFiles } = nested({ registryYaml: NESTED_WITH_TEST_YAML })
        const reply = await addEnvironment(project(NESTED_WITH_TEST_YAML), args({ environment: 'uat2', domain: 'uat2.acme.com' }), deps)
        assert.equal(reply.ok, true)
        const environments = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('acme')!.environments
        assert.deepEqual([...environments.keys()], ['live', 'test', 'uat2'])
        assert.equal(environments.get('uat2')?.dir, '/var/www/acme/uat2')
        assert.equal(environments.get('uat2')?.composeName, 'acme-uat2')
    })

    it('refuses a name the project already has, before touching anything', async () => {
        const { deps, calls } = nested({ registryYaml: NESTED_WITH_TEST_YAML })
        const reply = await addEnvironment(project(NESTED_WITH_TEST_YAML), args({ environment: 'test' }), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'acme already has a test environment' })
        assert.deepEqual(calls, [])
    })

    it('refuses live, and a reserved or invalid name, before touching anything', async () => {
        const { deps, calls } = nested()
        assert.deepEqual(await addEnvironment(project(), args({ environment: 'live' }), deps), { ok: false, code: 'bad-request', message: 'live cannot be added' })
        for (const environment of ['git', 'next', 'prev', 'environments', 'backups', 'uat-1', 'UAT1']) {
            assert.deepEqual(
                await addEnvironment(project(), args({ environment }), deps),
                { ok: false, code: 'bad-request', message: 'environment must be an environment name' },
                environment,
            )
        }
        assert.deepEqual(calls, [])
    })

    it('refuses a flat live, pointing at the deploy that nests it', async () => {
        const { deps, calls } = setup()
        const reply = await addEnvironment(project(REGISTRY_YAML), args(), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'deploy live once so it moves into the nested layout, then add environments' })
        assert.deepEqual(calls, [])
    })

    it('refuses a name whose deleted environment the purge has not removed yet, and asks only about this project and name', async () => {
        const asked: string[] = []
        const { deps, calls } = nested()
        const reply = await addEnvironment(project(), args(), {
            ...deps,
            deletedWithin: async (id, environment) => { asked.push(`${id} ${environment}`); return true },
        })
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'uat1 was deleted and is still kept for a restore; restore it or wait for it to be purged' })
        assert.deepEqual(asked, ['acme uat1'])
        assert.deepEqual(calls, [])
    })

    // Another project's deleted environment, a flat one whose folder was /var/www/acme-uat1 say, can hold
    // the same compose name: deletedWithin only knows about this project's own names
    it('refuses a name whose compose name a deleted environment of another project still holds', async () => {
        const asked: string[] = []
        const { deps, calls } = nested()
        const reply = await addEnvironment(project(), args(), {
            ...deps,
            deletedWithin: async () => false,
            composeNameDeleted: async name => { asked.push(name); return 'other test' },
        })
        assert.deepEqual(reply, {
            ok: false, code: 'bad-request',
            message: 'acme uat1 would run under the compose name acme-uat1, which the deleted environment other test still holds with its volumes; restore it or wait for it to be purged',
        })
        assert.deepEqual(asked, ['acme-uat1'])
        assert.deepEqual(calls, [])
    })

    it('goes ahead when the deleted-name check answers false', async () => {
        const { deps } = nested()
        const reply = await addEnvironment(project(), args(), { ...deps, deletedWithin: async () => false })
        assert.equal(reply.ok, true)
    })

    it('refuses a domain another environment of the same project already has', async () => {
        const { deps, calls } = nested({ registryYaml: NESTED_WITH_TEST_YAML })
        const reply = await addEnvironment(project(NESTED_WITH_TEST_YAML), args({ domain: 'test.acme.com' }), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'test.acme.com is already used by another project or environment' })
        assert.equal(calls.includes('choosePort'), false)
    })

    it('refreshes the registry before checking the domain, not only inside choosePort', async () => {
        const { deps } = nested()
        const claimed = parseRegistry(`${NESTED_LIVE_YAML}  widget:
    client: cl_9
    name: Widget
    repo: git@github.com:ItsKodas/widget.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/widget, branch: main, domain: uat1.acme.com, port: 5099 }
`)
        let registry = parseRegistry(NESTED_LIVE_YAML)
        const reply = await addEnvironment(project(), args(), {
            ...deps,
            registry: () => registry,
            refreshRegistry: async () => { registry = claimed },
        })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.match(reply.ok === false ? reply.message : '', /uat1\.acme\.com is already used by another project or environment/)
    })

    it('refuses provisioning entirely while the registry has any invalid entry, naming it', async () => {
        const yaml = `${NESTED_LIVE_YAML}  broken:\n    client: cl_9\n`
        const { deps, calls } = nested({ registryYaml: yaml })
        const reply = await addEnvironment(project(yaml), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'unavailable')
        assert.match(reply.ok === false ? reply.message : '', /broken/)
        // The folder and repository checks already ran, but choosePort never does
        assert.deepEqual(calls, ['exists', 'exists'])
    })

    // Project ids may hold a hyphen, so another project's own compose name can be exactly <id>-<name>.
    // The registry write refuses it too, but only after a full checkout: this refuses it before any of it.
    it('refuses a compose name another project already runs under, naming both, before any disk work', async () => {
        const yaml = `${NESTED_LIVE_YAML}  acme-uat1:
    client: cl_9
    name: Acme UAT
    repo: git@github.com:ItsKodas/acme-uat1.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme-uat1/live, branch: main, port: 5099 }
`
        const { deps, calls, fetchRequests } = nested({ registryYaml: yaml })
        const reply = await addEnvironment(project(yaml), args(), deps)
        assert.deepEqual(reply, {
            ok: false, code: 'bad-request',
            message: 'acme uat1 would run under the compose name acme-uat1, which acme-uat1 live already uses',
        })
        assert.equal(calls.includes('choosePort'), false)
        assert.equal(calls.includes('mkdir'), false)
        assert.deepEqual(fetchRequests, [])
    })

    // The copy carries live's WEB_PORT across, so writing the new environment's own port first would be
    // overwritten by live's and it would start on live's port
    it('writes the port into .env after the live env files are copied across', async () => {
        const { deps, envFs, envFsFiles } = nested({ envTree: { '/var/www/acme/live/.env': 'WEB_PORT=5010\n' } })
        let copiedFirst: string | undefined
        deps.setPortEnv = async (environment, key, port) => {
            copiedFirst = envFsFiles.get(`${environment.dir}/.env`)
            envFsFiles.set(`${environment.dir}/.env`, `${key}=${port}\n`)
            return { ok: true, previous: copiedFirst ?? null }
        }
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.equal(copiedFirst, 'WEB_PORT=5010\n')
        assert.equal(envFsFiles.get('/var/www/acme/uat1/.env'), 'WEB_PORT=5100\n')
    })

    // The env files copied out of live are written by this process, as root, so they are part of what
    // needs owning: owning before the copy would leave every one of them root-only.
    it('owns the tree after the env files are copied across, and before it registers anything', async () => {
        const { deps, calls, envFs, envFsFiles, ownerPaths, ownCalls } = nested({ envTree: { '/var/www/acme/live/.env': 'DATABASE_URL=postgres://db/acme\n' } })
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.equal(envFsFiles.has('/var/www/acme/uat1/.env'), true)
        assert.ok(calls.indexOf('checkout') < calls.indexOf('own'))
        assert.ok(calls.indexOf('own') < calls.indexOf('write'))
        // Patterned on the site folder, and applied to the new environment's own tree only
        assert.deepEqual(ownerPaths, ['/var/www/acme'])
        assert.deepEqual(ownCalls, [{ dir: '/var/www/acme/uat1', like: { uid: 1000, gid: 1000, mode: 0o775 } }])
    })

    it('removes only its own folder and writes nothing when the tree cannot be given that ownership', async () => {
        const { deps, calls, rmdirs } = nested()
        deps.own = async () => { throw new Error('operation not permitted') }
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /operation not permitted/)
        assert.deepEqual(rmdirs, ['/var/www/acme/uat1'])
        assert.equal(calls.includes('write'), false)
    })

    // listEnvFiles lists an .example on purpose, envWriteProblem refuses to write one, and the checkout
    // has already put the repo's own committed copy in place.
    it('leaves an .example to the checkout, rather than reporting one it was never going to copy', async () => {
        const { deps, envFs, envFsFiles } = nested({
            envTree: { '/var/www/acme/live/.env': 'A=1\n', '/var/www/acme/live/.env.example': 'A=\n' },
        })
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.equal(envFsFiles.get('/var/www/acme/uat1/.env'), 'A=1\n')
        assert.equal(envFsFiles.has('/var/www/acme/uat1/.env.example'), false)
    })

    it('points only the site URL and database at the new environment, leaving values that merely contain the id', async () => {
        const { deps, envFs, envFsFiles } = nested({
            envTree: {
                '/var/www/acme/live/.env': [
                    'SITE_URL=https://acme.com',
                    'DATABASE_URL=postgres://user:pw@db:5432/acme',
                    // None of these name a database, and none of them may be touched even though every
                    // one of them contains the project id as a plain substring.
                    'S3_BUCKET=acme-assets',
                    'GITHUB_REPO=ItsKodas/acme',
                    'SMTP_USER=noreply@acme.com',
                    'OTHER=unrelated-value',
                    '',
                ].join('\n'),
            },
        })
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.ok(reply.ok && 'envFiles' in reply && reply.envFiles.some(file => file.path === '.env'))
        assert.equal(envFsFiles.get('/var/www/acme/uat1/.env'), [
            'SITE_URL=https://uat1.acme.com',
            'DATABASE_URL=postgres://user:pw@db:5432/acme-uat1',
            'S3_BUCKET=acme-assets',
            'GITHUB_REPO=ItsKodas/acme',
            'SMTP_USER=noreply@acme.com',
            'OTHER=unrelated-value',
            '',
        ].join('\n'))
    })

    it('refuses and rolls back when an env file fails to copy, naming it in the refusal', async () => {
        const { deps, rmdirs, envFs } = nested({ envTree: { '/var/www/acme/live/.env': 'A=1' } })
        const flakyEnvFs: EnvFs = { ...envFs, writeFile: async () => { throw new Error('disk full') } }
        const reply = await addEnvironment(project(), args(), deps, flakyEnvFs)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /\.env/)
        assert.deepEqual(rmdirs, ['/var/www/acme/uat1'])
    })

    it('removes its folder and writes nothing when the compose file has no services', async () => {
        const { deps, rmdirs, calls } = nested({ resolveResult: { ok: true, services: {}, published: [] } })
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(rmdirs, ['/var/www/acme/uat1'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes its folder when the registry write fails for an unrelated reason', async () => {
        const { deps, rmdirs } = nested()
        const otherFailure = { write: async () => ({ ok: false, problem: 'the registry could not be written: disk full' }) } as unknown as RegistryWriter
        const reply = await addEnvironment(project(), args(), { ...deps, writer: otherFailure })
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/acme/uat1'])
    })

    // A real RegistryWriter refusing a genuine conflict: a winner added uat1 between this call's
    // pre-checks and its own write, so the folder may be the winner's and is left alone.
    it('does not roll back when a real RegistryWriter meets a genuine conflict at write time', async () => {
        const { deps, rmdirs, registryFiles } = nested()
        registryFiles.set(REGISTRY_PATH, `${NESTED_LIVE_YAML}      uat1:\n        dir: /var/www/acme/uat1\n        branch: develop\n        port: 5099\n`)
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /acme already has a uat1 environment/)
        assert.deepEqual(rmdirs, [])
    })
})

describe('nested sites', () => {
    const nestedProject = (): ProjectEntry => parseRegistry(NESTED_LIVE_YAML).projects.get('acme')!
    const testArgs = (overrides: Partial<ProvisionAddEnvironmentArgs> = {}): ProvisionAddEnvironmentArgs => ({
        action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: 'letsencrypt',
        ...overrides,
    })
    const withRepository = { registryYaml: NESTED_LIVE_YAML, existsPaths: ['/var/www/acme/git/.git'] }

    it('creates a new site nested, with its repository split out beside live', async () => {
        const { deps, steps, registryFiles, logs } = setup()
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(steps, [
            'mkdir /var/www/bakery',
            'mkdir /var/www/bakery/live',
            'clone /var/www/bakery/live',
            'mkdir /var/www/bakery/git',
            'move /var/www/bakery/live/.git /var/www/bakery/git/.git',
        ])
        assert.ok(logs.includes('provision bakery: moved the git repository to /var/www/bakery/git'))
        const live = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/bakery/live')
        assert.equal(live.composeName, 'bakery')
        // The default is written as no key at all, so the entry reads the same as a hand-written one.
        assert.doesNotMatch(registryFiles.get(REGISTRY_PATH)!, /composeName/)
    })

    it('removes the whole site folder when a create fails', async () => {
        const { deps, steps, rmdirs, calls } = setup({ cloneResult: { ok: false, code: 'failed', message: 'git clone failed' } })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.deepEqual(steps, ['mkdir /var/www/bakery', 'mkdir /var/www/bakery/live', 'clone /var/www/bakery/live', 'rmdir /var/www/bakery'])
        assert.equal(calls.includes('write'), false)
    })

    // The site folder is this call's own by then, so it goes; live never came to exist.
    it('removes the site folder when live cannot be made inside it', async () => {
        const { deps, rmdirs, calls } = setup()
        const mkdir = deps.mkdir
        deps.mkdir = async dir => {
            if (dir.endsWith('/live')) throw new Error('EACCES: permission denied')
            await mkdir(dir)
        }
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /EACCES/)
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.equal(calls.includes('clone'), false)
    })

    it('removes the site folder and registers nothing when the repository cannot be moved out of live', async () => {
        const { deps, rmdirs, calls } = setup()
        deps.move = async () => { throw new Error('EXDEV: cross-device link not permitted') }
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /EXDEV/)
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.equal(calls.includes('write'), false)
    })

    it('adds test to a nested site as a worktree of the shared repository', async () => {
        const { deps, steps, calls, fetchRequests, registryFiles, resolveCalls, ownerPaths, ownCalls } = setup(withRepository)
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.equal(reply.ok, true)
        assert.equal(calls.some(call => call === 'clone' || call === 'mkdir'), false)
        assert.deepEqual(fetchRequests, [
            { verb: 'fetch', dir: '/var/www/acme/git', branch: 'develop', credential: null },
            { verb: 'tip', dir: '/var/www/acme/git', branch: 'develop' },
            { verb: 'checkout', dir: '/var/www/acme/git', worktree: '/var/www/acme/test', commit: 'abc1234' },
        ])
        assert.deepEqual(steps, ['fetch /var/www/acme/git', 'tip /var/www/acme/git', 'checkout /var/www/acme/test'])
        assert.deepEqual(resolveCalls, [{
            expectedName: 'acme-test', dir: '/var/www/acme/test', composePaths: ['/var/www/acme/test/docker-compose.yml', '/var/www/acme/test/hostd.ports.yml'], collidesWith: 'acme',
        }])
        // Patterned on the site folder both environments live in, and applied to test's own tree only.
        assert.deepEqual(ownerPaths, ['/var/www/acme'])
        assert.deepEqual(ownCalls, [{ dir: '/var/www/acme/test', like: { uid: 1000, gid: 1000, mode: 0o775 } }])
        const test = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('acme')!.environments.get('test')!
        assert.equal(test.dir, '/var/www/acme/test')
        assert.equal(test.composeName, 'acme-test')
        assert.doesNotMatch(registryFiles.get(REGISTRY_PATH)!, /composeName/)
    })

    it('fetches the test branch with the credential the project already has', async () => {
        const { deps, fetchRequests } = setup(withRepository)
        await addEnvironment({ ...nestedProject(), credential: 'acme' }, testArgs(), deps)
        assert.deepEqual(fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme/git', branch: 'develop', credential: 'acme' })
    })

    it('copies live env files into the nested test worktree', async () => {
        const { deps, envFs, envFsFiles } = setup({ ...withRepository, envTree: { '/var/www/acme/live/.env': 'DATABASE_URL=postgres://db/acme\n' } })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.equal(envFsFiles.get('/var/www/acme/test/.env'), 'DATABASE_URL=postgres://db/acme-test\n')
    })

    it('refuses to add test to a nested site with no shared repository', async () => {
        const { deps, calls } = setup({ registryYaml: NESTED_LIVE_YAML, existsPaths: [] })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'unavailable', message: '/var/www/acme/git has no repository to add test from' })
        assert.deepEqual(calls, ['exists', 'exists'])
    })

    it('refuses when the nested test folder already exists, before touching anything', async () => {
        const { deps, calls } = setup({ registryYaml: NESTED_LIVE_YAML, existsPaths: ['/var/www/acme/git/.git', '/var/www/acme/test'] })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: '/var/www/acme/test already exists' })
        assert.deepEqual(calls, ['exists'])
    })

    // Nothing is on disk before the checkout: a failed fetch or tip has nothing to roll back, and the
    // site folder, live's and the repository's as much as test's, is never this call's to remove.
    for (const verb of ['fetch', 'tip'] as const) {
        it(`refuses and removes nothing when the ${verb} fails`, async () => {
            const { deps, rmdirs, calls } = setup({ ...withRepository, fetchResults: { [verb]: { ok: false, code: 'failed', message: `git ${verb} failed` } } })
            const reply = await addEnvironment(nestedProject(), testArgs(), deps)
            assert.deepEqual(reply, { ok: false, code: 'failed', message: `git ${verb} failed` })
            assert.deepEqual(rmdirs, [])
            assert.equal(calls.includes('checkout'), false)
            assert.equal(calls.includes('write'), false)
        })
    }

    it('refuses when the tip names no commit', async () => {
        const { deps, rmdirs, calls } = setup({ ...withRepository, fetchResults: { tip: { ok: true } } })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /no commit for develop/)
        assert.deepEqual(rmdirs, [])
        assert.equal(calls.includes('checkout'), false)
    })

    it('removes only the test worktree when the checkout fails', async () => {
        const { deps, rmdirs, calls } = setup({ ...withRepository, fetchResults: { checkout: { ok: false, code: 'failed', message: 'git worktree add failed' } } })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git worktree add failed' })
        assert.deepEqual(rmdirs, ['/var/www/acme/test'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes only the test worktree, never the site, when a later step fails', async () => {
        const { deps, rmdirs, calls } = setup({ ...withRepository, resolveResult: { ok: false, problem: 'docker compose config failed' } })
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/acme/test'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes nothing when the fetcher throws before the checkout', async () => {
        const { deps, rmdirs } = setup(withRepository)
        deps.fetcher = { call: async () => { throw new Error('the fetcher connection failed: socket reset') } }
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, [])
    })

    it('removes the test worktree when the fetcher throws during the checkout', async () => {
        const { deps, rmdirs } = setup(withRepository)
        const call = deps.fetcher.call
        deps.fetcher = {
            call: async request => {
                if (request.verb === 'checkout') throw new Error('the fetcher did not answer within 330 seconds')
                return call(request)
            },
        }
        const reply = await addEnvironment(nestedProject(), testArgs(), deps)
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/acme/test'])
    })
})

describe('removeProject', () => {
    // Must-exist, per the whole-branch review: deleting a project used to only unregister it, leaving its
    // containers running with nothing left in the registry able to stop them (every lifecycle verb then
    // answers unknown-project). Removing the whole project must stop it first, the same stop a lifecycle
    // call would run.
    it('stops the project before unregistering it, and deletes no files', async () => {
        const { deps, rmdirs, registryFiles, runnerCalls } = setup()
        const reply = await removeProject(project(), deps)
        assert.equal(reply.ok, true)
        assert.ok(reply.ok && 'output' in reply && reply.output.includes('/var/www/acme'))
        assert.ok(reply.ok && 'output' in reply && reply.output.includes('stopped'))
        assert.deepEqual(rmdirs, [])
        assert.deepEqual(runnerCalls, [{ command: 'docker', args: lifecycleArgv(project(), 'stop') }])

        const written = parseRegistry(registryFiles.get(REGISTRY_PATH)!)
        assert.equal(written.projects.has('acme'), false)
    })

    // A failed stop must refuse, not unregister anyway: unregistering a project that is still running
    // would leave nothing in the registry able to stop it. An operator can retry the removal, or stop the
    // project by hand and then remove it.
    it('refuses and leaves the registry untouched when the stop fails', async () => {
        const { deps, registryFiles, runnerCalls } = setup({ runnerResult: { exitCode: 1, stderr: 'no such image' } })
        const reply = await removeProject(project(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /could not stop acme/)
        assert.equal(runnerCalls.length, 1)
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.has('acme'), true)
    })

    function project(): ProjectEntry {
        return parseRegistry(REGISTRY_YAML).projects.get('acme')!
    }
})

describe('secrecy', () => {
    it('never puts repo credentials or an env value into a log line', async () => {
        // A fetcher failure's message is deliberately passed through into the refusal reply, not
        // redacted here: git.ts's own redact() already strips a userinfo section and a bare token from
        // Git's stderr before the fetcher ever answers, so what reaches provision.ts is already safe to
        // hand to the caller. This is what the log lines must never do regardless: even an already-safe
        // fetcher message is not logged verbatim, on the principle that provision.ts's own log calls carry
        // only ids, paths and fixed words, never a value from anywhere else.
        const fetcherMessage = 'fatal: authentication failed for https://x-access-token:ghp_SECRETTOKEN@github.com/acme/site.git'
        const { deps: createDeps, logs: createLogs } = setup({
            cloneResult: { ok: false, code: 'failed', message: fetcherMessage },
        })
        const reply = await createProject(createArgs(), createDeps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: fetcherMessage })
        assert.ok(createLogs.length > 0)
        assert.ok(createLogs.every(line => !line.includes('ghp_SECRETTOKEN')))

        const acme = parseRegistry(NESTED_LIVE_YAML).projects.get('acme')!
        const secret = 'DB_PASSWORD=super-secret-value'
        const { deps, logs, envFs } = setup({ registryYaml: NESTED_LIVE_YAML, existsPaths: ['/var/www/acme/git/.git'], envTree: { '/var/www/acme/live/.env': secret } })
        const args: ProvisionAddEnvironmentArgs = { action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: 'letsencrypt' }
        await addEnvironment(acme, args, deps, envFs)
        assert.ok(logs.length > 0)
        assert.ok(logs.every(line => !line.includes('super-secret-value')))
    })
})
