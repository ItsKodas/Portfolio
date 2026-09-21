import { describe, expect, it } from 'vitest'

import { writeSettings } from './settings'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown, headers?: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body, headers: init.headers as Record<string, string> })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('writeSettings', () => {
    it('puts the settings as JSON', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await writeSettings(config, admin, 'acme', { capabilities: ['lifecycle'], branches: { live: 'main' } }, fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/settings')
        expect(calls[0].method).toBe('PUT')
        expect(calls[0].headers?.['content-type']).toBe('application/json')
        expect(JSON.parse(calls[0].body as string)).toEqual({ capabilities: ['lifecycle'], branches: { live: 'main' } })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        const result = await writeSettings(config, admin, 'Not An Id', {}, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})
