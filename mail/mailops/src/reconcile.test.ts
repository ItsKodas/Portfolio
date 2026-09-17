import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGED_COMMENT, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'
import { reconcile } from './reconcile.ts'

const desired: DesiredRecord[] = [
    { type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false },
    { type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10 },
]

function fakeApi(existing: CloudflareRecord[]) {
    const writes: string[] = []
    const api: DnsApi = {
        async list(name, type) {
            return existing.filter(r => r.name === name && r.type === type)
        },
        async create(record) { writes.push(`create ${record.type} ${record.name}`) },
        async update(record) { writes.push(`update ${record.type} ${record.name}`) },
    }
    return { api, writes }
}

describe('reconcile', () => {
    it('creates every record on an empty zone', async () => {
        const { api, writes } = fakeApi([])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.created, ['A mail.dev.horizons.gg', 'MX dev.horizons.gg'])
        assert.equal(writes.length, 2)
    })

    it('writes nothing on a second run', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false, comment: MANAGED_COMMENT },
            { id: '2', type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10, comment: MANAGED_COMMENT },
        ])
        const result = await reconcile(api, desired)
        assert.equal(writes.length, 0)
        assert.equal(result.unchanged.length, 2)
    })

    it('updates only the record that drifted when the IP changes', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '9.9.9.9', ttl: 60, proxied: false, comment: MANAGED_COMMENT },
            { id: '2', type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10, comment: MANAGED_COMMENT },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.updated, ['A mail.dev.horizons.gg'])
        assert.equal(writes.length, 1)
    })

    it('reports a conflict and writes nothing when an unstamped record is in the way', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '9.9.9.9', ttl: 300 },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.conflicts, ['A mail.dev.horizons.gg'])
        assert.equal(result.created.length, 1, 'the MX is still created')
        assert.ok(!writes.includes('update A mail.dev.horizons.gg'))
    })

    it('ignores an unstamped record of a different type at the same name', async () => {
        const { api } = fakeApi([
            { id: '1', type: 'TXT', name: 'mail.dev.horizons.gg', content: 'unrelated', ttl: 300 },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.conflicts, [])
        assert.equal(result.created.length, 2)
    })
})
