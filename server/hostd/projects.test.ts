import { describe, expect, it, vi } from 'vitest'

import { hasAccess, getEnvironmentStatus, getProject, lifecycle, LIFECYCLE_TIMEOUT_MS, listEnvironments, listProjects } from './projects'

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

describe('listEnvironments', () => {
    // The actions check an environment against the site's own list, and this is where it comes from:
    // GET /projects/:id carries the environments beside the services.
    it('answers the environments GET /projects/:id carries, aliases and all', async () => {
        const environments = [
            { name: 'live', branch: 'main', domain: 'acme.com', aliases: ['www.acme.com'], certificate: null, deployed: null },
            { name: 'uat1', branch: 'uat', domain: null, aliases: [], certificate: null, deployed: null },
        ]
        const { fetchImpl, calls } = fakeFetch({ ok: true, services: [], environments })
        expect(await listEnvironments(config, admin, 'acme-bakery', fetchImpl)).toEqual({ ok: true, value: environments })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery')
    })

    it('answers an empty list from a hostd that sends none', async () => {
        const { fetchImpl } = fakeFetch({ ok: true, services: [] })
        expect(await listEnvironments(config, admin, 'acme-bakery', fetchImpl)).toEqual({ ok: true, value: [] })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect((await listEnvironments(config, admin, '../x', fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})

describe('lifecycle', () => {
    it('posts the action to the project', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await lifecycle(config, admin, 'acme-bakery', 'restart', 'live', fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/restart')
        expect(calls[0].method).toBe('POST')
    })

    it('posts another environment\'s action under its name', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await lifecycle(config, admin, 'acme-bakery', 'stop', 'uat1', fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/uat1/stop')
    })

    // hostd answers once compose has finished, and a stop alone waits out a ten second grace period per
    // container. The default ten second timeout reported every such stop as hostd not answering, while
    // the site stopped regardless.
    it('waits as long as hostd itself may take, rather than the default ten seconds', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout')
        const { fetchImpl } = fakeFetch({ ok: true })
        await lifecycle(config, admin, 'acme-bakery', 'stop', 'live', fetchImpl)
        expect(timeout).toHaveBeenCalledWith(LIFECYCLE_TIMEOUT_MS)
        // Past hostd's own 150 second call timeout, so its answer, refusal or not, always arrives first
        expect(LIFECYCLE_TIMEOUT_MS).toBeGreaterThan(150_000)
        timeout.mockRestore()
    })

    it('refuses a project id hostd would not recognise', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        const result = await lifecycle(config, admin, '../../etc', 'restart', 'live', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})

describe('getEnvironmentStatus', () => {
    it('reads one environment\'s services', async () => {
        const services = [{ service: 'web', role: 'site', state: 'running', health: null, startedAt: null, restartCount: 0, image: null }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, services })
        expect(await getEnvironmentStatus(config, admin, 'acme-bakery', 'uat1', fetchImpl)).toEqual({ ok: true, value: services })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/uat1/status')
    })
})

describe('hasAccess', () => {
    const grants = [
        { clientId: 'cl_8F2K1ABC', projectId: 'acme-bakery', permissions: ['LOGS', 'LIFECYCLE'] as const },
        { clientId: 'cl_OTHER123', projectId: 'acme-bakery', permissions: [] as const },
    ]
    const findAccess = async (clientId: string, projectId: string) =>
        grants.find(g => g.clientId === clientId && g.projectId === projectId)?.permissions ?? null

    it('passes any client with access to the site when no permission is named', async () => {
        expect(await hasAccess('cl_8F2K1ABC', 'acme-bakery', findAccess)).toBe(true)
        // Two clients sharing one site, the second with nothing beyond the Overview
        expect(await hasAccess('cl_OTHER123', 'acme-bakery', findAccess)).toBe(true)
    })

    it('needs the named permission when there is one', async () => {
        expect(await hasAccess('cl_8F2K1ABC', 'acme-bakery', findAccess, 'LOGS')).toBe(true)
        expect(await hasAccess('cl_8F2K1ABC', 'acme-bakery', findAccess, 'DEPLOYS')).toBe(false)
        expect(await hasAccess('cl_OTHER123', 'acme-bakery', findAccess, 'LOGS')).toBe(false)
    })

    it('refuses a client with no access, before hostd is ever asked', async () => {
        expect(await hasAccess('cl_NOBODY12', 'acme-bakery', findAccess)).toBe(false)
        expect(await hasAccess('cl_8F2K1ABC', 'never-heard-of-it', findAccess)).toBe(false)
    })
})
