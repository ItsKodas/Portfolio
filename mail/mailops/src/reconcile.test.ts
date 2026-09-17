import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGED_COMMENT, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'
import { reconcile, createWriteTracker, MAX_CONSECUTIVE_UPDATES } from './reconcile.ts'

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

describe('reconcile does not trust the API side filter', () => {
    // A `list` that ignores its arguments entirely, which is the shape the failure would take if the
    // server-side name filter ever loosened to a suffix or substring match. Our SPF record
    // (dev.horizons.gg TXT) is a suffix of our DMARC record (_dmarc.dev.horizons.gg TXT), so a loosened
    // filter could hand back DMARC when SPF was asked for, and PATCH it with SPF content.
    function sloppyApi(existing: CloudflareRecord[]) {
        const writes: { op: string, id?: string, name: string, content: string }[] = []
        const api: DnsApi = {
            async list() { return existing },
            async create(record) { writes.push({ op: 'create', name: record.name, content: record.content }) },
            async update(record, want) { writes.push({ op: 'update', id: record.id, name: record.name, content: want.content }) },
        }
        return { api, writes }
    }

    const spf: DesiredRecord[] = [
        { type: 'TXT', name: 'dev.horizons.gg', content: 'v=spf1 a:mail.dev.horizons.gg ~all', ttl: 300 },
    ]

    it('never writes to a managed record the API returned at a different name', async () => {
        const dmarc: CloudflareRecord = {
            id: 'dmarc', type: 'TXT', name: '_dmarc.dev.horizons.gg',
            content: 'v=DMARC1; p=none; rua=mailto:me@example.com', ttl: 300, comment: MANAGED_COMMENT,
        }
        const { api, writes } = sloppyApi([dmarc])
        const result = await reconcile(api, spf)

        assert.equal(writes.filter(w => w.id === 'dmarc').length, 0, 'the DMARC record must not be touched')
        assert.deepEqual(result.updated, [])
        // With nothing genuinely at dev.horizons.gg TXT, the SPF record is created instead.
        assert.deepEqual(result.created, ['TXT dev.horizons.gg'])
        assert.deepEqual(writes, [{ op: 'create', name: 'dev.horizons.gg', content: spf[0]!.content }])
    })

    it('does not report a conflict because of a record at another name', async () => {
        const unrelated: CloudflareRecord = {
            id: 'site', type: 'A', name: 'horizons.gg', content: '203.0.113.1', ttl: 300,
        }
        const { api, writes } = sloppyApi([unrelated])
        const result = await reconcile(api, spf)
        assert.deepEqual(result.conflicts, [])
        assert.deepEqual(result.created, ['TXT dev.horizons.gg'])
        assert.equal(writes.filter(w => w.id === 'site').length, 0)
    })
})

describe('reconcile convergence guard', () => {
    // A record that never agrees no matter what is written to it: exactly the shape of the chunked-TXT
    // bug, and of any future normalisation surprise.
    function neverConverges() {
        const stored: CloudflareRecord = {
            id: '9', type: 'TXT', name: 'mail._domainkey.dev.horizons.gg',
            content: 'stale, and it stays stale', ttl: 300, comment: MANAGED_COMMENT,
        }
        let updates = 0
        const api: DnsApi = {
            async list() { return [stored] },
            async create() { assert.fail('should never create') },
            async update() { updates += 1 },
        }
        return { api, updates: () => updates }
    }

    const want: DesiredRecord[] = [
        { type: 'TXT', name: 'mail._domainkey.dev.horizons.gg', content: 'v=DKIM1; p=abc', ttl: 300 },
    ]

    it('stops writing after the limit and reports the loop instead', async () => {
        const { api, updates } = neverConverges()
        const tracker = createWriteTracker()

        for (let cycle = 0; cycle < MAX_CONSECUTIVE_UPDATES; cycle++) {
            const result = await reconcile(api, want, tracker)
            assert.deepEqual(result.updated, ['TXT mail._domainkey.dev.horizons.gg'], `cycle ${cycle}`)
            assert.deepEqual(result.loops, [], `cycle ${cycle}`)
        }
        assert.equal(updates(), MAX_CONSECUTIVE_UPDATES)

        for (let cycle = 0; cycle < 5; cycle++) {
            const result = await reconcile(api, want, tracker)
            assert.deepEqual(result.updated, [])
            assert.deepEqual(result.loops, ['TXT mail._domainkey.dev.horizons.gg'])
        }
        assert.equal(updates(), MAX_CONSECUTIVE_UPDATES, 'not one further write after the guard trips')
    })

    it('resets and writes again when the desired content genuinely changes', async () => {
        const { api, updates } = neverConverges()
        const tracker = createWriteTracker()
        for (let cycle = 0; cycle < MAX_CONSECUTIVE_UPDATES + 2; cycle++) await reconcile(api, want, tracker)
        assert.equal(updates(), MAX_CONSECUTIVE_UPDATES)

        const rotated = [{ ...want[0]!, content: 'v=DKIM1; p=xyz' }]
        const result = await reconcile(api, rotated, tracker)
        assert.deepEqual(result.updated, ['TXT mail._domainkey.dev.horizons.gg'])
        assert.deepEqual(result.loops, [])
        assert.equal(updates(), MAX_CONSECUTIVE_UPDATES + 1)
    })

    it('clears the counter once a record converges, so ordinary drift is never throttled', async () => {
        const stored: CloudflareRecord = {
            id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '9.9.9.9', ttl: 60, proxied: false, comment: MANAGED_COMMENT,
        }
        let updates = 0
        const api: DnsApi = {
            async list() { return [stored] },
            async create() { assert.fail('should never create') },
            async update(_existing, wanted) { updates += 1; stored.content = wanted.content },
        }
        const tracker = createWriteTracker()
        const a = [desired[0]!]

        // Six IP rotations in a row, each one a real change that does converge.
        for (let cycle = 0; cycle < 6; cycle++) {
            stored.content = `10.0.0.${cycle}`
            const result = await reconcile(api, a, tracker)
            assert.deepEqual(result.updated, ['A mail.dev.horizons.gg'], `cycle ${cycle}`)
            assert.deepEqual(result.loops, [], `cycle ${cycle}`)
            // The next cycle sees the write landed, which is what resets the counter.
            assert.deepEqual((await reconcile(api, a, tracker)).unchanged, ['A mail.dev.horizons.gg'])
        }
        assert.equal(updates, 6)
    })
})
