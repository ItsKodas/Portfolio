import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createProject, addEnvironment, removeProject, type ProvisionDeps } from './provision.ts'
import { RegistryWriter, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { EnvFs } from './env-files.ts'
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
    resolveResult?: { ok: true, services: Record<string, { role: 'site' }> } | { ok: false, problem: string }
    portResult?: { ok: true, port: number } | { ok: false, problem: string }
    existsPaths?: string[]
    envTree?: Record<string, string>
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
        log: message => logs.push(message),
    }

    return { deps, registry, calls, mkdirs, rmdirs, cloneRequests, logs, registryFiles, envFs, envFsFiles }
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

    it('does those in order, so nothing is registered before it exists on disk', async () => {
        const { deps, calls } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(calls, ['exists', 'choosePort', 'mkdir', 'clone', 'resolve', 'write'])
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
                '/var/www/acme/.env': 'SITE_URL=https://acme.com\nDATABASE_URL=postgres://user:pw@db:5432/acme\nOTHER=unrelated-value\n',
            },
        })
        const reply = await addEnvironment(project(), args(), deps, envFs)
        assert.equal(reply.ok, true)
        assert.ok(reply.ok && 'envFiles' in reply && reply.envFiles.some(file => file.path === '.env'))

        const copied = envFsFiles.get('/var/www/acme-test/.env')
        assert.equal(copied, 'SITE_URL=https://test.acme.com\nDATABASE_URL=postgres://user:pw@db:5432/acme-test\nOTHER=unrelated-value\n')
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
    it('removing a project unregisters it and deletes no files', async () => {
        const { deps, rmdirs, registryFiles } = setup()
        const reply = await removeProject(project(), null, deps)
        assert.equal(reply.ok, true)
        assert.ok(reply.ok && 'output' in reply && reply.output.includes('/var/www/acme'))
        assert.deepEqual(rmdirs, [])

        const written = parseRegistry(registryFiles.get(REGISTRY_PATH)!)
        assert.equal(written.projects.has('acme'), false)
    })

    it('refuses to remove the live environment on its own', async () => {
        const { deps, rmdirs, registryFiles } = setup()
        const reply = await removeProject(project(), 'live', deps)
        assert.equal(reply.ok, false)
        assert.equal(reply.ok === false && reply.message.includes('live environment cannot be removed on its own'), true)
        assert.deepEqual(rmdirs, [])
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.has('acme'), true)
    })

    function project(): ProjectEntry {
        return parseRegistry(REGISTRY_YAML).projects.get('acme')!
    }
})

describe('secrecy', () => {
    it('never puts repo credentials or an env value into a log line', async () => {
        const { deps: createDeps, logs: createLogs } = setup({
            cloneResult: {
                ok: false, code: 'failed',
                message: 'fatal: authentication failed for https://x-access-token:ghp_SECRETTOKEN@github.com/acme/site.git',
            },
        })
        await createProject(createArgs(), createDeps)
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
