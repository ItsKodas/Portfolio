import { describe, expect, it } from 'vitest'

import { openDeployStream } from './deployWatch'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(status: number, body = 'event: step\ndata: {}\n\n') {
    const calls: { url: string, headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> })
        return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('openDeployStream', () => {
    it('asks hostd for the environment on the deploy path, with the caller headers', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openDeployStream(config, admin, 'acme-bakery', 'live', fetchImpl)
        expect(result.ok).toBe(true)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/live/deploy')
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
    })

    it('refuses a project id that is not one, without asking hostd', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openDeployStream(config, admin, '../etc', 'live', fetchImpl)
        expect(result.ok).toBe(false)
        expect(calls).toHaveLength(0)
    })

    it('refuses an environment that is not live or test, without asking hostd', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openDeployStream(config, admin, 'acme-bakery', 'staging' as never, fetchImpl)
        expect(result.ok).toBe(false)
        expect(calls).toHaveLength(0)
    })

    it('reports a refusal rather than handing back a broken stream', async () => {
        const { fetchImpl } = fakeFetch(503, JSON.stringify({ code: 'agent-unavailable', message: 'the agent is not answering' }))
        const result = await openDeployStream(config, admin, 'acme-bakery', 'live', fetchImpl)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('agent-unavailable')
    })

    it('reports unavailable when hostd cannot be reached at all', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await openDeployStream(config, admin, 'acme-bakery', 'live', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })
})
