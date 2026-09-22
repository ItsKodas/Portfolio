import { describe, expect, it } from 'vitest'

import { listCredentials } from './credentials'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('listCredentials', () => {
    it("reads the machine's credential names, not a project's", async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, credentials: ['acme', 'northwind'] })
        const result = await listCredentials(config, admin, fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/credentials')
        expect(result).toEqual({ ok: true, value: ['acme', 'northwind'] })
    })

    it("carries hostd's own refusal along rather than throwing", async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'admin-only', message: 'only the admin can read the credential list' }, 403)
        const result = await listCredentials(config, admin, fetchImpl)

        expect(result).toEqual({ ok: false, code: 'admin-only', message: 'only the admin can read the credential list' })
    })
})
