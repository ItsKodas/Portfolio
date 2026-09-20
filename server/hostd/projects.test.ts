import { describe, expect, it } from 'vitest'

import { assertOwned, lifecycle, listProjects } from './projects'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown) {
    const calls: { url: string, method?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('listProjects', () => {
    it('asks hostd for the projects this caller can see', async () => {
        const { fetchImpl, calls } = fakeFetch({ projects: [{ id: 'acme-bakery', name: 'Acme Bakery', valid: true }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value[0].id).toBe('acme-bakery')
        expect(calls[0].url).toBe('http://hostd-api:8080/projects')
    })
})

describe('lifecycle', () => {
    it('posts the action to the project', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await lifecycle(config, admin, 'acme-bakery', 'restart', fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/restart')
        expect(calls[0].method).toBe('POST')
    })

    it('refuses a project id hostd would not recognise', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        const result = await lifecycle(config, admin, '../../etc', 'restart', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})

describe('assertOwned', () => {
    const sites = [{ projectId: 'acme-bakery', clientId: 'cl_8F2K1ABC' }]
    const findSite = async (projectId: string) => sites.find(s => s.projectId === projectId) ?? null

    it('passes when the site belongs to this client', async () => {
        expect(await assertOwned('cl_8F2K1ABC', 'acme-bakery', findSite)).toBe(true)
    })

    it('refuses a site belonging to another client, before hostd is ever asked', async () => {
        expect(await assertOwned('cl_OTHER123', 'acme-bakery', findSite)).toBe(false)
    })

    it('refuses a project the portal has no site row for', async () => {
        expect(await assertOwned('cl_8F2K1ABC', 'never-heard-of-it', findSite)).toBe(false)
    })
})
