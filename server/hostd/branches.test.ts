import { describe, expect, it } from 'vitest'

import { listBranches } from './branches'

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

describe('listBranches', () => {
    it('reads the branch list hostd answers', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, branches: ['main', 'develop'] })
        const result = await listBranches(config, admin, 'acme', fetchImpl)

        expect(result).toEqual({ ok: true, value: ['main', 'develop'] })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/branches')
        expect(calls[0].method).toBeUndefined()
    })

    it('passes hostd\'s own refusal through, in hostd\'s own words', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'bad-request', message: 'acme has no repo to list branches from' }, 400)
        const result = await listBranches(config, admin, 'acme', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'bad-request', message: 'acme has no repo to list branches from' })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, branches: [] })
        const result = await listBranches(config, admin, 'Not An Id', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})
