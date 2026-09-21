import { describe, expect, it } from 'vitest'

import { assertOwned, getProject, lifecycle, listProjects } from './projects'

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
        expect(calls[0].url).toBe('http://hostd-api:8080/projects?status=1')
    })

    // The whole point of the flag: one request for the dashboard instead of one more per site.
    it('carries each project status back, so the dashboard needs no second request', async () => {
        const services = [{ service: 'acme-web', role: 'site', state: 'running', health: 'healthy', startedAt: '2026-09-21T04:00:00Z', restartCount: 0, image: 'acme:latest' }]
        const { fetchImpl } = fakeFetch({ projects: [{ id: 'acme-bakery', name: 'Acme Bakery', valid: true, capabilities: ['logs'], status: { ok: true, services } }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value[0].status).toEqual({ ok: true, services })
        expect(result.value[0].capabilities).toEqual(['logs'])
    })

    // A project hostd could not read carries its refusal in place of its services rather than taking the
    // whole list down, so a caller has to handle both arms.
    it('keeps a project whose status hostd could not read', async () => {
        const status = { ok: false, code: 'invalid-project', message: 'acme-bakery is invalid: compose.yml is unparseable' }
        const { fetchImpl } = fakeFetch({ projects: [{ id: 'acme-bakery', valid: false, reason: 'compose.yml is unparseable', status }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value[0].status).toEqual(status)
        // An entry the registry itself could not parse has no name, which is why name is optional
        expect(result.value[0].name).toBeUndefined()
    })

    it('tolerates a project with no status at all', async () => {
        const { fetchImpl } = fakeFetch({ projects: [{ id: 'acme-bakery', name: 'Acme Bakery', valid: true }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value[0].status).toBeUndefined()
    })

    it('carries a project\'s repo back for the operator', async () => {
        const { fetchImpl } = fakeFetch({ projects: [{ id: 'acme', name: 'Acme', valid: true, repo: 'git@github.com:ItsKodas/acme.git', environments: [] }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value[0].repo).toBe('git@github.com:ItsKodas/acme.git')
    })
})

describe('getProject', () => {
    it('returns the services hostd actually answers with', async () => {
        // GET /projects/:id answers StatusReply, which is services and nothing else. It was typed as a
        // whole Project, so name and valid could never have been read from it.
        const services = [{ service: 'asot-web', role: 'site', state: 'running', health: null, startedAt: null, restartCount: null, image: null }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, services })
        const result = await getProject(config, admin, 'asot', fetchImpl)
        expect(result).toEqual({ ok: true, value: services })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/asot')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, services: [] })
        expect(await getProject(config, admin, 'nope!', fetchImpl)).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
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
