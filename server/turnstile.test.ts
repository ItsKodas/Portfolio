import { describe, expect, it } from 'vitest'

import { SITEVERIFY_URL, verifyTurnstile } from './turnstile'

function fakeFetch(status: number, body: unknown) {
    const calls: { url: string, body: URLSearchParams }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as URLSearchParams })
        return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('verifyTurnstile', () => {
    it('sends the secret, the token and the visitor\'s IP to Cloudflare', async () => {
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        expect(await verifyTurnstile('token', '203.0.113.9', 'secret', fetchImpl)).toBe(true)
        expect(calls[0].url).toBe(SITEVERIFY_URL)
        expect(Object.fromEntries(calls[0].body)).toEqual({ secret: 'secret', response: 'token', remoteip: '203.0.113.9' })
    })

    it('leaves the IP out when it is unknown', async () => {
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        await verifyTurnstile('token', 'unknown', 'secret', fetchImpl)
        expect(calls[0].body.has('remoteip')).toBe(false)
    })

    it('fails when Cloudflare says so, answers with an error, or there is no token', async () => {
        expect(await verifyTurnstile('token', 'unknown', 'secret', fakeFetch(200, { success: false }).fetchImpl)).toBe(false)
        expect(await verifyTurnstile('token', 'unknown', 'secret', fakeFetch(500, {}).fetchImpl)).toBe(false)
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        expect(await verifyTurnstile('', 'unknown', 'secret', fetchImpl)).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
