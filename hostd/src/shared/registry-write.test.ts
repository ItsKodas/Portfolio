import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { RegistryWriter, applyChange, type Change, type RegistryWriteFs } from './registry-write.ts'

const BASE = `reserved: [horizons.gg]
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
`

const addProject: Change = {
    kind: 'add-project',
    id: 'bakery',
    project: {
        client: 'cl_2', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git',
        services: { web: { role: 'site' } },
        environment: { name: 'live', dir: '/var/www/bakery', branch: 'main', domain: 'bakery.com', port: 5011, certificate: 'letsencrypt' },
    },
}

describe('applyChange', () => {
    it('adds a project that parses back with the fields it was given', () => {
        const result = applyChange(BASE, addProject)
        assert.ok(result.ok)
        const registry = parseRegistry(result.text)
        const bakery = registry.projects.get('bakery')!
        assert.equal(bakery.name, 'Bakery')
        assert.equal(bakery.environments.get('live')!.port, 5011)
        // and the project that was already there is untouched
        assert.equal(registry.projects.get('acme')!.environments.get('live')!.domain, 'acme.com')
    })

    it('keeps comments and unrelated formatting in the file', () => {
        const withComment = `# hand written note\n${BASE}`
        const result = applyChange(withComment, addProject)
        assert.ok(result.ok)
        assert.match(result.text, /# hand written note/)
    })

    it('adds an environment to an existing project', () => {
        const result = applyChange(BASE, {
            kind: 'add-environment', id: 'acme',
            environment: { name: 'test', dir: '/var/www/acme-test', branch: 'develop', domain: 'test.acme.com', port: 5110, certificate: 'letsencrypt' },
        })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('test')!.branch, 'develop')
    })

    it('records a deployed commit', () => {
        const result = applyChange(BASE, { kind: 'set-deployed', id: 'acme', environment: 'live', commit: '9a1b2c3' })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.deployed, '9a1b2c3')
    })

    it('removes a project and an environment', () => {
        const gone = applyChange(BASE, { kind: 'remove-project', id: 'acme' })
        assert.ok(gone.ok)
        assert.equal(parseRegistry(gone.text).projects.size, 0)
    })

    it('refuses a change that would produce a registry hostd would reject', () => {
        const clash = applyChange(BASE, { ...addProject, project: { ...addProject.project, environment: { ...addProject.project.environment, dir: '/var/www/acme' } } })
        assert.equal(clash.ok, false)
        assert.match(clash.ok === false ? clash.problem : '', /dir/)
    })

    it('refuses an id that already exists, and one that is reserved', () => {
        assert.equal(applyChange(BASE, { ...addProject, id: 'acme' }).ok, false)
        assert.equal(applyChange(BASE, { ...addProject, id: 'mail' }).ok, false)
    })

    it('refuses a change to a project that is not there', () => {
        assert.equal(applyChange(BASE, { kind: 'set-deployed', id: 'ghost', environment: 'live', commit: '9a1b2c3' }).ok, false)
    })
})

describe('RegistryWriter', () => {
    function fakeFs(initial: string) {
        const files = new Map<string, string>([['/etc/hostd/projects.yaml', initial]])
        const calls: string[] = []
        const fs: RegistryWriteFs = {
            readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
            writeFile: async (path, text) => { calls.push(`write ${path}`); files.set(path, text) },
            rename: async (from, to) => { calls.push(`rename ${from} -> ${to}`); files.set(to, files.get(from)!); files.delete(from) },
            unlink: async path => { calls.push(`unlink ${path}`); files.delete(path) },
        }
        return { fs, files, calls }
    }

    it('writes a temporary file beside the registry and renames it over the original', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        assert.deepEqual(await writer.write(addProject), { ok: true })
        assert.deepEqual(calls, ['write /etc/hostd/.projects.yaml.tmp', 'rename /etc/hostd/.projects.yaml.tmp -> /etc/hostd/projects.yaml'])
        assert.match(files.get('/etc/hostd/projects.yaml')!, /bakery/)
    })

    it('leaves the file untouched when the change is refused', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write({ ...addProject, id: 'acme' })
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.deepEqual(calls, [])
    })

    it('removes the temporary file when the rename fails, and reports the problem', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        fs.rename = async () => { throw new Error('read-only file system') }
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write(addProject)
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.ok(calls.includes('unlink /etc/hostd/.projects.yaml.tmp'))
    })

    it('serialises concurrent writes, so two additions both survive', async () => {
        const { fs, files } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const second: Change = { ...addProject, id: 'cafe', project: { ...addProject.project, name: 'Cafe', environment: { ...addProject.project.environment, dir: '/var/www/cafe', port: 5012 } } }
        const [a, b] = await Promise.all([writer.write(addProject), writer.write(second)])
        assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
        const registry = parseRegistry(files.get('/etc/hostd/projects.yaml')!)
        assert.deepEqual([...registry.projects.keys()].sort(), ['acme', 'bakery', 'cafe'])
    })
})
