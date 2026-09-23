import { describe, expect, it } from 'vitest'

import { removeProject } from './remove'

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

describe('removeProject', () => {
    it('sends a DELETE with the name typed back', async () => {
        const output = 'bakery was stopped and unregistered; /var/www/bakery was left in place, along with its volumes and databases'
        const { fetchImpl, calls } = fakeFetch({ ok: true, output })
        expect(await removeProject(config, admin, 'bakery', 'Bakery', fetchImpl)).toEqual({ ok: true, value: { ok: true, output } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/bakery')
        expect(calls[0].method).toBe('DELETE')
        expect(JSON.parse(calls[0].body as string)).toEqual({ name: 'Bakery' })
    })

    it('carries hostd\'s refusal through', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'bad-request', message: 'name must match the project name to confirm deletion' }, 400)
        expect(await removeProject(config, admin, 'bakery', 'Bakry', fetchImpl))
            .toEqual({ ok: false, code: 'bad-request', message: 'name must match the project name to confirm deletion' })
    })

    it('refuses an id hostd would not take, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        expect((await removeProject(config, admin, '../x', 'X', fetchImpl)).ok).toBe(false)
        expect(calls).toEqual([])
    })
})
