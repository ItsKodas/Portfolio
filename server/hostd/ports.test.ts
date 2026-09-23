import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkPort, setPort } from './ports'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

afterEach(() => vi.restoreAllMocks())

describe('checkPort', () => {
    it('asks for a suggestion alone', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, suggested: 5012, problem: null })
        const result = await checkPort(config, admin, {}, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/ports')
        expect(result).toEqual({ ok: true, value: { suggested: 5012, problem: null } })
    })

    // The first probe after an agent restart looks up the agent's own image as well, which can take
    // most of 25 seconds: the client's usual 10 would report a free port as unreadable
    it('waits 30 seconds for an answer', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout')
        const { fetchImpl } = fakeFetch({ ok: true, suggested: 5012, problem: null })
        await checkPort(config, admin, { port: 5004 }, fetchImpl)
        expect(timeout).toHaveBeenCalledWith(30_000)
    })

    it('asks about a port for one environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, suggested: 5012, problem: 'port 5004 is in use on the host' })
        await checkPort(config, admin, { port: 5004, own: { project: 'acme', environment: 'live' } }, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/ports?port=5004&project=acme&environment=live')
    })
})

describe('setPort', () => {
    it('puts the port for one environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: 'acme live now uses port 5012' })
        const result = await setPort(config, admin, 'acme', 'live', 5012, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/live/port')
        expect(calls[0].method).toBe('PUT')
        expect(JSON.parse(calls[0].body as string)).toEqual({ port: 5012 })
        expect(result).toEqual({ ok: true, value: { output: 'acme live now uses port 5012' } })
    })

    it('refuses a port outside 5000 to 65535 before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect(await setPort(config, admin, 'acme', 'live', 3000, fetchImpl))
            .toEqual({ ok: false, code: 'bad-request', message: 'Use a port from 5000 to 65535.' })
        expect(calls).toHaveLength(0)
    })

    it('refuses a malformed id before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect((await setPort(config, admin, '../x', 'live', 5012, fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
