import { describe, expect, it } from 'vitest'

import { hostdRequest } from './client'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const caller = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(status: number, body: unknown) {
    const calls: { url: string, headers: Record<string, string>, method?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, method: init.method })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('hostdRequest', () => {
    it('sends the token and both actor headers', async () => {
        const { fetchImpl, calls } = fakeFetch(200, { projects: [] })
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result).toEqual({ ok: true, value: { projects: [] } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects')
        expect(calls[0].headers.Authorization).toBe(`Bearer ${'a'.repeat(32)}`)
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
        expect(calls[0].headers['X-Hostd-User']).toBe('koda@horizons.gg')
    })

    it('returns a refusal rather than throwing', async () => {
        const { fetchImpl } = fakeFetch(403, { code: 'forbidden', message: 'project belongs to another client' })
        const result = await hostdRequest(config, caller, '/projects/acme', {}, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'forbidden', message: 'project belongs to another client' })
    })

    it('returns unavailable when hostd cannot be reached', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })

    it('returns unavailable when hostd answers with something that is not json', async () => {
        const fetchImpl = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('unavailable')
    })
})
