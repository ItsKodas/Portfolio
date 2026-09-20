import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createProject, addEnvironment, removeProject, type ProvisionDeps } from './provision.ts'
import { RegistryWriter, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { EnvFs } from './env-files.ts'
import { lifecycleArgv, type GuessedService, type Runner, type RunResult } from './compose.ts'
import type { ProvisionCreateArgs, ProvisionAddEnvironmentArgs } from '../shared/protocol.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

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
    resolveResult?: { ok: true, services: Record<string, GuessedService> } | { ok: false, problem: string }
    portResult?: { ok: true, port: number } | { ok: false, problem: string }
    existsPaths?: string[]
    envTree?: Record<string, string>
    runnerResult?: Partial<RunResult>
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
    const cloneRequests: FetchRequest[] = []
    const logs: string[] = []
    const runnerCalls: Array<{ command: string, args: string[] }> = []

    const registryFiles = new Map<string, string>([[REGISTRY_PATH, yaml]])
    const registryFs: RegistryWriteFs = {
        readFile: async path => registryFiles.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { registryFiles.set(path, text) },
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

    const deps: ProvisionDeps = {
        registry: () => registry,
        // Not tracked in calls: it is not a disk or registry side effect the ordering tests below care
        // about, only a precondition that the fixed registry above is already what a refresh would see.
        refreshRegistry: async () => {},
        writer,
        fetcher: {
            call: async request => {
                calls.push('clone')
                cloneRequests.push(request)
                return options.cloneResult ?? { ok: true, commit: 'abc1234' }
            },
        },
        choosePort: async () => {
            calls.push('choosePort')
            return options.portResult ?? { ok: true, port: 5100 }
        },
        mkdir: async dir => { calls.push('mkdir'); mkdirs.push(dir) },
        rmdir: async dir => { calls.push('rmdir'); rmdirs.push(dir) },
        exists: async dir => { calls.push('exists'); return exists.has(dir) },
        resolve: async () => {
            calls.push('resolve')
            return options.resolveResult ?? { ok: true, services: { web: { role: 'site' } } }
        },
        runner: (async (command, args) => {
            runnerCalls.push({ command, args })
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...options.runnerResult }
        }) as Runner,
        log: message => logs.push(message),
    }

    return { deps, registry, calls, mkdirs, rmdirs, cloneRequests, logs, registryFiles, envFs, envFsFiles, runnerCalls }
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
        const { deps, mkdirs, cloneRequests, registryFiles } = setup()
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: true, project: { id: 'bakery', state: 'needs-setup' }, envFiles: [] })
        assert.deepEqual(mkdirs, ['/var/www/bakery'])
        assert.deepEqual(cloneRequests, [{ verb: 'clone', repo: 'git@github.com:ItsKodas/bakery.git', dir: '/var/www/bakery', branch: 'main' }])

        const written = parseRegistry(registryFiles.get(REGISTRY_PATH)!)
        const bakery = written.projects.get('bakery')
        assert.ok(bakery)
        assert.equal(bakery.repo, 'git@github.com:ItsKodas/bakery.git')
        assert.equal(bakery.environments.get('live')?.domain, 'bakery.com')
        assert.equal(bakery.environments.get('live')?.port, 5100)
        assert.deepEqual(bakery.services, { web: { role: 'site' } })
    })

    it('writes a database service resolve guessed, not only site services', async () => {
        const { deps, registryFiles } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' }, db: { role: 'database', engine: 'postgres' } } } })
        const reply = await createProject(createArgs(), deps)
        assert.equal(reply.ok, true)
        const bakery = parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')
        assert.deepEqual(bakery?.services, { web: { role: 'site' }, db: { role: 'database', engine: 'postgres', dump: {} } })
    })

    it('does those in order, so nothing is registered before it exists on disk', async () => {
        const { deps, calls } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(calls, ['exists', 'choosePort', 'mkdir', 'clone', 'resolve', 'write'])
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
        const { deps: emptyDeps, rmdirs: emptyRmdirs, calls: emptyCalls } = setup({ resolveResult: { ok: true, services: {} } })
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
            writeFile: async () => {},
            rename: async () => {},
            unlink: async () => {},
        })
        const reply = await createProject(createArgs(), { ...deps, writer: brokenWriter })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.deepEqual(calls, ['exists', 'choosePort', 'mkdir', 'clone', 'resolve', 'rmdir'])
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

    // Must-exist, per the whole-branch review: takenPorts only ever sees registry.projects, which
    // excludes anything already invalid, and Docker's own published ports only see running containers, so
    // a temporarily invalid entry whose containers are stopped is invisible to both. Refusing outright
    // while anything is invalid is the honest fix, named here rather than only in ports.ts, since that is
    // where provisioning as a whole is refused.
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

describe('addEnvironment', () => {
    const project = (yaml = REGISTRY_YAML): ProjectEntry => parseRegistry(yaml).projects.get('acme')!
    const args = (overrides: Partial<ProvisionAddEnvironmentArgs> = {}): ProvisionAddEnvironmentArgs => ({
        action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: 'letsencrypt',
        ...overrides,
    })

    it('names the test environment folder <id>-test and gives it its own port', async () => {
        const { deps, mkdirs, cloneRequests, registryFiles } = setup({ portResult: { ok: true, port: 5200 } })
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(mkdirs, ['/var/www/acme-test'])
        assert.deepEqual(cloneRequests, [{ verb: 'clone', repo: 'git@github.com:ItsKodas/acme.git', dir: '/var/www/acme-test', branch: 'develop' }])

        const written = parseRegistry(registryFiles.get(REGISTRY_PATH)!)
        const test = written.projects.get('acme')!.environments.get('test')
        assert.equal(test?.dir, '/var/www/acme-test')
        assert.equal(test?.port, 5200)
        assert.equal(test?.domain, 'test.acme.com')
    })

    it('copies live env files into a new test environment, pointing the site URL and database at test', async () => {
        const { deps, envFs, envFsFiles } = setup({
            envTree: {
                '/var/www/acme/.env': [
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

        const copied = envFsFiles.get('/var/www/acme-test/.env')
        assert.equal(copied, [
            'SITE_URL=https://test.acme.com',
            'DATABASE_URL=postgres://user:pw@db:5432/acme-test',
            'S3_BUCKET=acme-assets',
            'GITHUB_REPO=ItsKodas/acme',
            'SMTP_USER=noreply@acme.com',
            'OTHER=unrelated-value',
            '',
        ].join('\n'))
    })

    it('refuses and rolls back when an env file fails to copy, naming it in the refusal', async () => {
        const { deps, rmdirs, envFs } = setup({ envTree: { '/var/www/acme/.env': 'A=1' } })
        const flakyEnvFs: EnvFs = { ...envFs, writeFile: async () => { throw new Error('disk full') } }
        const reply = await addEnvironment(project(), args(), deps, flakyEnvFs)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /\.env/)
        assert.deepEqual(rmdirs, ['/var/www/acme-test'])
    })

    it('removes the folder and writes nothing when the clone fails', async () => {
        const { deps, rmdirs, calls } = setup({ cloneResult: { ok: false, code: 'failed', message: 'git clone failed: authentication required' } })
        const reply = await addEnvironment(project(), args(), deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git clone failed: authentication required' })
        assert.deepEqual(rmdirs, ['/var/www/acme-test'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes the folder and writes nothing when the compose file has no site service', async () => {
        const { deps, rmdirs, calls } = setup({ resolveResult: { ok: true, services: {} } })
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(rmdirs, ['/var/www/acme-test'])
        assert.equal(calls.includes('write'), false)
    })

    it('removes the folder and writes nothing when the registry write fails for an unrelated reason', async () => {
        const { deps, rmdirs } = setup()
        const otherFailure = { write: async () => ({ ok: false, problem: 'the registry could not be written: disk full' }) } as unknown as RegistryWriter
        const reply = await addEnvironment(project(), args(), { ...deps, writer: otherFailure })
        assert.equal(reply.ok, false)
        assert.deepEqual(rmdirs, ['/var/www/acme-test'])
    })

    it('does not remove its folder when the write fails with a structural conflict', async () => {
        const { deps, rmdirs } = setup()
        const conflictingWriter = { write: async () => ({ ok: false, problem: 'acme already has a test environment', conflict: true as const }) } as unknown as RegistryWriter
        const reply = await addEnvironment(project(), args(), { ...deps, writer: conflictingWriter })
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'acme already has a test environment' })
        assert.deepEqual(rmdirs, [])
    })

    // The end-to-end version: a real RegistryWriter (backed by the in-memory fs fake) refusing a genuine
    // conflict, rather than a fake writer asserting the shape we expect it to produce.
    it('does not roll back when a real RegistryWriter meets a genuine conflict at write time', async () => {
        const withTest = REGISTRY_YAML.replace(
            '      live:\n        dir: /var/www/acme\n        branch: main\n        domain: acme.com\n        port: 5010\n        certificate: letsencrypt\n',
            '      live:\n        dir: /var/www/acme\n        branch: main\n        domain: acme.com\n        port: 5010\n        certificate: letsencrypt\n'
            + '      test:\n        dir: /var/www/acme-test\n        branch: develop\n        domain: someone-else.acme.com\n        port: 5099\n',
        )
        const { deps, rmdirs, registryFiles } = setup()
        // Simulate a winner having added the test environment between this call's own pre-checks (which
        // already read the registry() snapshot, taken before this) and its own write.
        registryFiles.set(REGISTRY_PATH, withTest)
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /acme already has a test environment/)
        assert.deepEqual(rmdirs, [])
    })

    it('rolls back when the fetcher throws instead of returning a failure', async () => {
        const { deps, rmdirs } = setup()
        const throwingFetcher: ProvisionDeps['fetcher'] = { call: async () => { throw new Error('the fetcher connection failed: socket reset') } }
        const reply = await addEnvironment(project(), args(), { ...deps, fetcher: throwingFetcher })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(rmdirs, ['/var/www/acme-test'])
    })

    it('refreshes the registry before checking the domain, not only inside choosePort', async () => {
        const { deps } = setup()
        const claimed = parseRegistry(`${REGISTRY_YAML}  widget:
    client: cl_9
    name: Widget
    repo: git@github.com:ItsKodas/widget.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/widget, branch: main, domain: test.acme.com, port: 5099 }
`)
        let registry = parseRegistry(REGISTRY_YAML)
        const reply = await addEnvironment(project(), args(), {
            ...deps,
            registry: () => registry,
            refreshRegistry: async () => { registry = claimed },
        })
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.match(reply.ok === false ? reply.message : '', /test\.acme\.com is already used by another project/)
    })

    it('refuses provisioning entirely while the registry has any invalid entry, naming it', async () => {
        const yaml = `${REGISTRY_YAML}  broken:\n    client: cl_9\n`
        const { deps, calls } = setup({ registryYaml: yaml })
        const reply = await addEnvironment(project(yaml), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'unavailable')
        assert.match(reply.ok === false ? reply.message : '', /broken/)
        // exists() already ran (addEnvironment checks the folder before refreshing the registry), but
        // choosePort never does: the refusal lands before it.
        assert.deepEqual(calls, ['exists'])
    })

    it('refuses a second test environment', async () => {
        const yaml = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: [provision, env]
    environments:
      live: { dir: /var/www/acme, branch: main, domain: acme.com, port: 5010, certificate: letsencrypt }
      test: { dir: /var/www/acme-test, branch: develop, domain: test.acme.com, port: 5110, certificate: letsencrypt }
`
        const { deps, calls } = setup({ registryYaml: yaml })
        const reply = await addEnvironment(project(yaml), args(), deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.deepEqual(calls, [])
    })
})

describe('removeProject', () => {
    // Must-exist, per the whole-branch review: deleting a project used to only unregister it, leaving its
    // containers running with nothing left in the registry able to stop them (every lifecycle verb then
    // answers unknown-project). Removing the whole project must stop it first, the same stop a lifecycle
    // call would run.
    it('stops the project before unregistering it, and deletes no files', async () => {
        const { deps, rmdirs, registryFiles, runnerCalls } = setup()
        const reply = await removeProject(project(), null, deps)
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
        const reply = await removeProject(project(), null, deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /could not stop acme/)
        assert.equal(runnerCalls.length, 1)
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.has('acme'), true)
    })

    // Removing only the test environment must never run a stop through this path: runLifecycle's argv is
    // always built from the project's own (live) dir and compose path, so asking it to stop here would
    // stop live's containers while claiming to remove test, exactly the mistake there is no per-environment
    // lifecycle yet to safely avoid (see RUNBOOK.md).
    it('does not attempt to stop anything when only the test environment is removed', async () => {
        const yaml = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: [provision, env]
    environments:
      live: { dir: /var/www/acme, branch: main, domain: acme.com, port: 5010, certificate: letsencrypt }
      test: { dir: /var/www/acme-test, branch: develop, domain: test.acme.com, port: 5110, certificate: letsencrypt }
`
        const { deps, runnerCalls, registryFiles } = setup({ registryYaml: yaml })
        const reply = await removeProject(parseRegistry(yaml).projects.get('acme')!, 'test', deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(runnerCalls, [])
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('acme')!.environments.has('test'), false)
    })

    it('refuses to remove the live environment on its own', async () => {
        const { deps, rmdirs, registryFiles, runnerCalls } = setup()
        const reply = await removeProject(project(), 'live', deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.message.includes('live environment cannot be removed on its own'), true)
        assert.deepEqual(rmdirs, [])
        assert.deepEqual(runnerCalls, [])
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

        const acme = parseRegistry(REGISTRY_YAML).projects.get('acme')!
        const secret = 'DB_PASSWORD=super-secret-value'
        const { deps, logs, envFs } = setup({ envTree: { '/var/www/acme/.env': secret } })
        const args: ProvisionAddEnvironmentArgs = { action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: 'letsencrypt' }
        await addEnvironment(acme, args, deps, envFs)
        assert.ok(logs.length > 0)
        assert.ok(logs.every(line => !line.includes('super-secret-value')))
    })
})
