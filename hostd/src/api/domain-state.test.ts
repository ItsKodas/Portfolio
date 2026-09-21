import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { DomainStore, domainKey, newRecord, type DomainRecord } from './domain-state.ts'

const NOW = '2026-09-21T00:00:00.000Z'

function store() {
    const files = new Map<string, string>()
    const fs = {
        async readFile(path: string) {
            const text = files.get(path)
            if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return text
        },
        async writeFile(path: string, text: string) { files.set(path, text) },
        async rename(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from) },
        async mkdir() {},
    }
    return { store: new DomainStore('/state/domains.json', fs), files }
}

const REGISTRY = `
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com, aliases: [www.acme.com] }
`

describe('DomainStore', () => {
    it('starts empty when there is no file yet', async () => {
        const { store: s } = store()
        await s.load()
        assert.deepEqual(s.all(), [])
    })

    it('keeps a record across a reload, which is what makes a restart resume', async () => {
        const { store: s, files } = store()
        await s.load()
        await s.put({ ...newRecord('acme', 'live', 'acme.com', true, NOW), state: 'active', attempts: 4 })
        const second = new DomainStore('/state/domains.json', {
            async readFile(path: string) { return files.get(path)! },
            async writeFile() {}, async rename() {}, async mkdir() {},
        })
        await second.load()
        assert.equal(second.get(domainKey('acme', 'live', 'acme.com'))?.state, 'active')
        assert.equal(second.get(domainKey('acme', 'live', 'acme.com'))?.attempts, 4)
    })

    it('writes by rename, so a crash mid-write cannot leave a half file', async () => {
        const { store: s, files } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'acme.com', true, NOW))
        assert.equal(files.has('/state/domains.json'), true)
        assert.equal([...files.keys()].some(key => key.endsWith('.tmp')), false)
    })

    it('returns one environment\'s records with the primary first', async () => {
        const { store: s } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'www.acme.com', false, NOW))
        await s.put(newRecord('acme', 'live', 'acme.com', true, NOW))
        assert.deepEqual(s.forEnvironment('acme', 'live').map(r => r.hostname), ['acme.com', 'www.acme.com'])
    })
})

describe('reconcile', () => {
    it('creates an unmanaged record for a hostname the registry has and the store does not', async () => {
        const { store: s } = store()
        await s.load()
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        const record = s.get(domainKey('acme', 'live', 'acme.com'))
        assert.equal(record?.state, 'unmanaged')
        assert.equal(record?.primary, true)
    })

    it('leaves an existing record\'s state alone, so a reload never restarts verification', async () => {
        const { store: s } = store()
        await s.load()
        await s.put({ ...newRecord('acme', 'live', 'acme.com', true, NOW), state: 'active', attempts: 9 })
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        assert.equal(s.get(domainKey('acme', 'live', 'acme.com'))?.state, 'active')
        assert.equal(s.get(domainKey('acme', 'live', 'acme.com'))?.attempts, 9)
    })

    it('drops a record for a hostname the registry no longer names', async () => {
        const { store: s } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'gone.acme.com', false, NOW))
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        assert.equal(s.get(domainKey('acme', 'live', 'gone.acme.com')), undefined)
    })

    it('ignores a project without the domains capability', async () => {
        const { store: s } = store()
        await s.load()
        await s.reconcile(parseRegistry(REGISTRY.replace('[domains]', '[lifecycle]')), NOW)
        assert.deepEqual(s.all(), [])
    })
})
