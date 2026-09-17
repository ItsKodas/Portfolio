import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    MANAGED_COMMENT, isManaged, matches, normaliseTxtContent, createCloudflareApi, UnmanagedRecordError,
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

// A realistic 2048-bit DKIM record. The public key half of an RSA-2048 SubjectPublicKeyInfo is 392
// base64 characters, which puts the whole value near 430 and well over the 255-character limit on a
// single DNS string.
const DKIM_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'Qk9wZXJhdGlvbmFsRGtpbUtleUJhc2U2NA'.repeat(10) + 'IDAQAB'
const DKIM_VALUE = `v=DKIM1; h=sha256; k=rsa; p=${DKIM_KEY}`

// How Cloudflare hands a long TXT value back: DNS splits it into 255-character strings and the API
// returns them space separated and individually quoted, not concatenated.
function asCloudflareChunks(value: string): string {
    const chunks: string[] = []
    for (let i = 0; i < value.length; i += 255) chunks.push(`"${value.slice(i, i + 255)}"`)
    return chunks.join(' ')
}

describe('normaliseTxtContent', () => {
    it('round-trips a long DKIM value through Cloudflare chunked form', () => {
        assert.ok(DKIM_VALUE.length > 255, 'the fixture must actually be long enough to be split')
        const chunked = asCloudflareChunks(DKIM_VALUE)
        assert.ok(chunked.includes('" "'), 'the fixture must actually arrive as multiple chunks')
        assert.equal(normaliseTxtContent(chunked), DKIM_VALUE)
    })

    it('strips the quotes from a single quoted string', () => {
        assert.equal(normaliseTxtContent('"v=spf1 a:mail.dev.horizons.gg ~all"'), 'v=spf1 a:mail.dev.horizons.gg ~all')
    })

    it('leaves an unquoted value exactly as it is', () => {
        assert.equal(normaliseTxtContent('v=spf1 a:mail.dev.horizons.gg ~all'), 'v=spf1 a:mail.dev.horizons.gg ~all')
    })

    it('collapses the whitespace between chunks rather than preserving it', () => {
        assert.equal(normaliseTxtContent('"one"   "two"'), 'onetwo')
        assert.equal(normaliseTxtContent('"one" "two"'), 'onetwo')
    })

    it('does not mangle a value that merely contains a quote', () => {
        assert.equal(normaliseTxtContent('he said "hi"there'), 'he said "hi"there')
    })
})

describe('matches for TXT records', () => {
    const want: DesiredRecord = { type: 'TXT', name: 'mail._domainkey.dev.horizons.gg', content: DKIM_VALUE, ttl: 300 }
    const asReturned: CloudflareRecord = {
        id: '3', type: 'TXT', name: want.name, content: asCloudflareChunks(DKIM_VALUE), ttl: 300, comment: MANAGED_COMMENT,
    }

    it('agrees with the chunked form Cloudflare returns, so the record converges', () => {
        assert.equal(matches(asReturned, want), true)
    })

    it('still disagrees when the key genuinely changed', () => {
        assert.equal(matches(asReturned, { ...want, content: `${DKIM_VALUE}x` }), false)
    })

    it('compares a non-TXT record literally, quotes and all', () => {
        assert.equal(matches({ ...managed, content: '"1.2.3.4"' }, desired), false)
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

    it('carries an abort signal on every request', async () => {
        const { impl, calls } = stubFetch(() => [])
        const api = createCloudflareApi('token', 'zone', impl)
        await api.list('mail.dev.horizons.gg', 'A')
        await api.create(desired)
        await api.update(managed, { ...desired, content: '9.9.9.9' })
        assert.equal(calls.length, 3)
        for (const call of calls) {
            assert.ok(call.init?.signal, `no AbortSignal on ${call.url}`)
            assert.equal(call.init.signal.aborted, false)
        }
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
