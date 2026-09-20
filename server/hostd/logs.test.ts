import { describe, expect, it } from 'vitest'

import { openLogStream } from './logs'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(status: number, body = 'event: line\ndata: {}\n\n') {
    const calls: { url: string, headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> })
        return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('openLogStream', () => {
    it('builds the query hostd expects and sends the actor headers', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web', tail: 200, follow: true }, fetchImpl)
        expect(result.ok).toBe(true)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/logs?service=acme-web&tail=200&follow=1')
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
    })

    it('passes since through, which is how a reconnect picks up where it left off', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web', since: '2026-09-21T04:10:00Z' }, fetchImpl)
        expect(calls[0].url).toContain('since=2026-09-21T04%3A10%3A00Z')
    })

    it('leaves out what was not asked for', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/logs?service=acme-web')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openLogStream(config, admin, 'nope!', { service: 'acme-web' }, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })

    it('reports a refusal rather than handing back a broken stream', async () => {
        const { fetchImpl } = fakeFetch(503, JSON.stringify({ code: 'agent-unavailable', message: 'the agent is not answering' }))
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('agent-unavailable')
    })

    it('reports unavailable when hostd cannot be reached at all', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })
})
