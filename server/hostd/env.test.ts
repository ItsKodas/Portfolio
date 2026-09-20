import { describe, expect, it } from 'vitest'

import { listEnvFiles, readEnvFile, writeEnvFile } from './env'

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

describe('listEnvFiles', () => {
    it('asks for the environment the caller named, and unwraps the list', async () => {
        const files = [{ path: '.env', example: '.env.example', bytes: 412 }, { path: 'worker/.env', example: null, bytes: 96 }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, files })
        const result = await listEnvFiles(config, admin, 'acme-bakery', 'test', fetchImpl)
        expect(result).toEqual({ ok: true, value: files })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/test/env')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, files: [] })
        const result = await listEnvFiles(config, admin, '../etc', 'live', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})

describe('readEnvFile', () => {
    it('puts the file path after the environment, and returns the text itself', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, text: 'NODE_ENV=production\n' })
        const result = await readEnvFile(config, admin, 'acme-bakery', 'live', 'worker/.env', fetchImpl)
        expect(result).toEqual({ ok: true, value: 'NODE_ENV=production\n' })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/live/env/worker/.env')
    })

    it('refuses a path that climbs out of the environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, text: '' })
        for (const path of ['../.env', 'a/../../b', '/etc/passwd', 'a\\b']) {
            const result = await readEnvFile(config, admin, 'acme-bakery', 'live', path, fetchImpl)
            expect(result, path).toEqual({ ok: false, code: 'bad-request', message: 'not a file inside this environment' })
        }
        expect(calls).toHaveLength(0)
    })
})

describe('writeEnvFile', () => {
    it('sends the contents as JSON under text, which is the only key hostd accepts', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: '.env was written' })
        await writeEnvFile(config, admin, 'acme-bakery', 'live', '.env', 'NODE_ENV=production\n', fetchImpl)
        expect(calls[0].method).toBe('PUT')
        expect(calls[0].headers?.['content-type']).toBe('application/json')
        expect(JSON.parse(calls[0].body as string)).toEqual({ text: 'NODE_ENV=production\n' })
    })

    it('refuses the same paths a read refuses', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: '' })
        const result = await writeEnvFile(config, admin, 'acme-bakery', 'live', '../.env', 'X=1', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'bad-request', message: 'not a file inside this environment' })
        expect(calls).toHaveLength(0)
    })
})
