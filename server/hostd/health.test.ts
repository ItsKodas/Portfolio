import { describe, expect, it } from 'vitest'

import { getHealth } from './health'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }
const client = { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }

const system = {
    memory: { totalBytes: 67_374_735_360, usedBytes: 21_474_836_480, availableBytes: 45_899_898_880 },
    cpu: { cores: 8, load1: 0.42, load5: 0.61, load15: 0.55 },
    disk: { path: '/var/www', totalBytes: 1_920_383_410_176, usedBytes: 412_316_860_416, freeBytes: 1_411_123_806_208 },
    problems: [],
}

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('getHealth', () => {
    it('asks hostd for the machine figures, and hands them back whole', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, warnings: [], invalid: {}, system })
        const result = await getHealth(config, admin, fetchImpl)
        expect(result).toEqual({ ok: true, value: { warnings: [], invalid: {}, system } })
        expect(calls[0].url).toBe('http://hostd-api:8080/health')
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
    })

    it('keeps the existing checks beside the figures', async () => {
        const invalid = { 'acme-bakery': 'compose.yml is unparseable' }
        const { fetchImpl } = fakeFetch({ ok: true, warnings: ['the registry was reloaded'], invalid, system })
        const result = await getHealth(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.warnings).toEqual(['the registry was reloaded'])
        expect(result.value.invalid).toEqual(invalid)
    })

    // A reading that could not be taken is null with its reason beside it, so one unreadable figure never
    // costs the other two. Nothing here may be assumed to be present.
    it('accepts a figure hostd could not read', async () => {
        const unread = { memory: null, cpu: null, disk: null, problems: ['the disk holding /var/www could not be read: ENOENT'] }
        const { fetchImpl } = fakeFetch({ ok: true, warnings: [], invalid: {}, system: unread })
        const result = await getHealth(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.system).toEqual(unread)
    })

    // This is admin only in hostd, so a client caller is refused. That has to arrive as a result the
    // caller can branch on, not as a thrown error a page would have to catch.
    it('returns the admin-only refusal rather than throwing', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'admin-only', message: 'only the admin can read hostd\'s health' }, 403)
        const result = await getHealth(config, client, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'admin-only', message: 'only the admin can read hostd\'s health' })
    })

    it('reports unavailable when hostd cannot be reached at all', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await getHealth(config, admin, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })
})
