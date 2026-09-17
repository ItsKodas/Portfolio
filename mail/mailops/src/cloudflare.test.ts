import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    MANAGED_COMMENT, isManaged, matches, createCloudflareApi, UnmanagedRecordError,
    type CloudflareRecord,
} from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'

const managed: CloudflareRecord = {
    id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4',
    ttl: 60, proxied: false, comment: MANAGED_COMMENT,
}

const desired: DesiredRecord = {
    type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false,
}

describe('isManaged', () => {
    it('accepts a record carrying our comment', () => {
        assert.equal(isManaged(managed), true)
    })

    it('rejects a record with no comment', () => {
        assert.equal(isManaged({ ...managed, comment: undefined }), false)
    })

    it('rejects a record with someone else comment', () => {
        assert.equal(isManaged({ ...managed, comment: 'the website' }), false)
    })
})

describe('matches', () => {
    it('is true when content, ttl and proxied all agree', () => {
        assert.equal(matches(managed, desired), true)
    })

    it('is false when the IP has changed', () => {
        assert.equal(matches({ ...managed, content: '9.9.9.9' }, desired), false)
    })

    it('is false when proxied has drifted on', () => {
        assert.equal(matches({ ...managed, proxied: true }, desired), false)
    })

    it('compares MX priority', () => {
        const mx: DesiredRecord = { type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10 }
        const existing: CloudflareRecord = { id: '2', type: 'MX', name: mx.name, content: mx.content, ttl: 300, priority: 20, comment: MANAGED_COMMENT }
        assert.equal(matches(existing, mx), false)
        assert.equal(matches({ ...existing, priority: 10 }, mx), true)
    })
})

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
    const calls: { url: string, init?: RequestInit }[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        calls.push({ url: href, init })
        return new Response(JSON.stringify({ success: true, errors: [], result: handler(href, init) }), {
            status: 200, headers: { 'content-type': 'application/json' },
        })
    }) as unknown as typeof fetch
    return { impl, calls }
}

describe('createCloudflareApi', () => {
    it('stamps every created record with the managed comment', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        await createCloudflareApi('token', 'zone', impl).create(desired)
        const body = JSON.parse(String(calls[0]?.init?.body))
        assert.equal(body.comment, MANAGED_COMMENT)
        assert.equal(body.proxied, false)
    })

    // A POST where a PATCH belongs would create a duplicate record in the live zone every cycle,
    // and every other assertion in this file would stay green while it happened.
    it('creates with POST to the collection', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        await createCloudflareApi('token', 'zone', impl).create(desired)
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.init?.method, 'POST')
        assert.match(String(calls[0]?.url), /dns_records$/)
    })

    it('refuses to update a record it did not create', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        const api = createCloudflareApi('token', 'zone', impl)
        await assert.rejects(
            () => api.update({ ...managed, comment: undefined }, { ...desired, content: '9.9.9.9' }),
            UnmanagedRecordError,
        )
        assert.equal(calls.length, 0, 'no request should be sent')
    })

    it('updates a record it does own', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        await createCloudflareApi('token', 'zone', impl).update(managed, { ...desired, content: '9.9.9.9' })
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.init?.method, 'PATCH')
        assert.match(String(calls[0]?.url), /dns_records\/1$/)
    })

    it('sends the token as a bearer credential', async () => {
        const { impl, calls } = stubFetch(() => [])
        await createCloudflareApi('token', 'zone', impl).list('mail.dev.horizons.gg', 'A')
        const headers = calls[0]?.init?.headers as Record<string, string>
        assert.equal(headers.Authorization, 'Bearer token')
    })

    it('throws when Cloudflare reports failure', async () => {
        const impl = (async () => new Response(
            JSON.stringify({ success: false, errors: [{ message: 'bad token' }], result: null }),
            { status: 403, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch
        await assert.rejects(() => createCloudflareApi('token', 'zone', impl).list('x', 'A'), /bad token/)
    })
})
