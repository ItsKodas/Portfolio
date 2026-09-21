import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { verifyHostname, translateFailure, newToken, TOKEN_HEADER } from './verify.ts'
import { DOMAIN_TOKEN } from '../shared/protocol.ts'

const answering = (status: number, token: string | null): typeof fetch =>
    (async () => new Response(null, {
        status,
        headers: token === null ? {} : { [TOKEN_HEADER]: token },
    })) as unknown as typeof fetch

const throwing = (error: unknown): typeof fetch => (async () => { throw error }) as unknown as typeof fetch

describe('newToken', () => {
    it('is lowercase hex, and long enough not to be guessed', () => {
        assert.match(newToken(), /^[0-9a-f]{32}$/)
    })

    it('is different every time', () => {
        assert.notEqual(newToken(), newToken())
    })

    it('satisfies the DOMAIN_TOKEN pattern the agent validates tokens against, so they never drift apart', () => {
        assert.match(newToken(), DOMAIN_TOKEN)
    })
})

describe('verifyHostname', () => {
    it('passes when the token comes back in the header', async () => {
        const result = await verifyHostname(answering(204, 'abc123'), 'acme.com', 'abc123', 'https', true)
        assert.deepEqual(result, { ok: true })
    })

    it('fails when the header carries a different token, which means the name points elsewhere', async () => {
        const result = await verifyHostname(answering(204, 'someone-else'), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.client : '', /points somewhere else/)
    })

    // Missing, not merely wrong: something answered, so the name reaches a server, but not this
    // environment's vhost. The design's table maps wrong OR missing to the same sentence, and this is
    // the half that actually happens, including the 301 the runbook's alias-ordering row describes.
    it('fails when there is no header at all, which also means the name points elsewhere', async () => {
        const result = await verifyHostname(answering(200, null), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.client : '', /points somewhere else/)
    })

    it('does not verify a matching token carried on a 500, since the header is not proof by itself', async () => {
        const result = await verifyHostname(answering(500, 'abc123'), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
    })

    it('does not verify a matching token carried on a 302, since the header is not proof by itself', async () => {
        const result = await verifyHostname(answering(302, 'abc123'), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
    })

    it('asks for the token path on the scheme it was given', async () => {
        const seen: string[] = []
        const recording = (async (url: string) => {
            seen.push(url)
            return new Response(null, { status: 204, headers: { [TOKEN_HEADER]: 'abc123' } })
        }) as unknown as typeof fetch
        await verifyHostname(recording, 'acme.com', 'abc123', 'http', false)
        assert.equal(seen[0], 'http://acme.com/.well-known/hostd/abc123')
    })

    it('never follows a redirect, because a redirect proves nothing about this vhost', async () => {
        const seen: RequestInit[] = []
        const recording = (async (_url: string, init: RequestInit) => {
            seen.push(init)
            return new Response(null, { status: 204, headers: { [TOKEN_HEADER]: 'abc123' } })
        }) as unknown as typeof fetch
        await verifyHostname(recording, 'acme.com', 'abc123', 'https', true)
        assert.equal(seen[0]!.redirect, 'manual')
    })
})

describe('translateFailure', () => {
    it('reads a DNS failure as no record yet', () => {
        const { client } = translateFailure(Object.assign(new Error('getaddrinfo ENOTFOUND acme.com'), { code: 'ENOTFOUND' }), true)
        assert.match(client, /No record exists yet/)
    })

    it('reads a TLS failure on a proxied domain as a proxy that is switched off', () => {
        const { client } = translateFailure(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), true)
        assert.match(client, /not proxied/)
    })

    it('never tells an unproxied domain to turn a proxy on', () => {
        const { client } = translateFailure(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), false)
        assert.doesNotMatch(client, /proxied/)
    })

    it('keeps the raw error as the reason, for the operator, and never puts it in the client line', () => {
        const { reason, client } = translateFailure(new Error('connect ECONNREFUSED 10.0.0.1:443'), true)
        assert.match(reason, /ECONNREFUSED/)
        assert.doesNotMatch(client, /10\.0\.0\.1/)
    })
})
