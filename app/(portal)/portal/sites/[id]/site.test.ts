import { describe, expect, it } from 'vitest'

import { gatherSite } from './site'

const service = (state: string) => ({
    service: 'asot-web', role: 'site' as const, state,
    health: null, startedAt: null, restartCount: null, image: null,
})

function deps(over: Record<string, unknown> = {}) {
    return {
        who: async () => ({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }),
        config: () => ({ ok: true as const, value: { url: 'http://hostd-api:8080', token: 'a'.repeat(32) } }),
        listProjects: async () => ({ ok: true as const, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'logs'] }] }),
        getProject: async () => ({ ok: true as const, value: [service('running')] }),
        owns: async () => true,
        ...over,
    }
}

describe('gatherSite', () => {
    it('finds the site and its services', async () => {
        const view = await gatherSite(deps(), 'asot')
        expect(view.kind).toBe('site')
        if (view.kind === 'site') {
            expect(view.name).toBe('ASOT')
            expect(view.services).toHaveLength(1)
        }
    })

    it('sends nobody a page, so the caller can send them to sign in', async () => {
        const view = await gatherSite(deps({ who: async () => null }), 'asot')
        expect(view.kind).toBe('anonymous')
    })

    it('refuses a site this client does not own, before asking hostd for it', async () => {
        const view = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }),
            owns: async () => false,
            getProject: async () => { throw new Error('should not be asked') },
        }), 'asot')
        expect(view.kind).toBe('forbidden')
    })

    it('says not found when hostd has no such project, rather than showing an empty page', async () => {
        const view = await gatherSite(deps({ listProjects: async () => ({ ok: true as const, value: [] }) }), 'asot')
        expect(view.kind).toBe('missing')
    })

    it('still shows the site when its status could not be read', async () => {
        const view = await gatherSite(deps({
            getProject: async () => ({ ok: false as const, code: 'agent-unavailable', message: 'the agent is not answering' }),
        }), 'asot')
        expect(view.kind).toBe('site')
        if (view.kind === 'site') {
            expect(view.services).toEqual([])
            expect(view.trouble).toBeTruthy()
        }
    })

    it('tells a client nothing about which part of the machine failed', async () => {
        const view = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_X', user: 'cl_X' }, clientId: 'cl_X' }),
            getProject: async () => ({ ok: false as const, code: 'agent-unavailable', message: '/run/hostd/agent.sock is not answering' }),
        }), 'asot')
        if (view.kind === 'site') expect(view.trouble).not.toContain('/run/hostd')
    })

    it('carries whether the viewer is the operator, which decides the tabs', async () => {
        const view = await gatherSite(deps(), 'asot')
        if (view.kind === 'site') expect(view.isAdmin).toBe(true)
    })

    // Not in the plan. The dashboard already answers a missing setting by drawing itself and saying which
    // one, and this page has to do the same or a half-filled .env takes the site page down entirely.
    it('still shows the site when hostd is not configured at all', async () => {
        const view = await gatherSite(deps({
            config: () => ({ ok: false as const, problems: ['HOSTD_API_TOKEN is not set'] }),
        }), 'asot')
        expect(view.kind).toBe('site')
        if (view.kind === 'site') {
            expect(view.name).toBe('asot')
            expect(view.services).toEqual([])
            expect(view.trouble).toMatch(/HOSTD_API_TOKEN/)
        }
    })

    it('names no setting to a client when hostd is not configured', async () => {
        const view = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_X', user: 'cl_X' }, clientId: 'cl_X' }),
            config: () => ({ ok: false as const, problems: ['HOSTD_API_TOKEN is not set'] }),
        }), 'asot')
        if (view.kind === 'site') expect(view.trouble).not.toMatch(/HOSTD/)
    })

    // Which tabs are offered turns on these, so they have to survive the trip rather than be re-guessed
    it('carries the capabilities hostd listed for the project', async () => {
        const view = await gatherSite(deps(), 'asot')
        if (view.kind === 'site') expect(view.capabilities).toEqual(['lifecycle', 'logs'])
    })

    // The page draws the dashboard's nav, which is every site this caller may see. The listing is already
    // in hand by then, so carrying it costs nothing and asking hostd twice would.
    it('carries the sites the nav draws, which is only ever this caller own listing', async () => {
        const view = await gatherSite(deps({
            listProjects: async () => ({
                ok: true as const,
                value: [{ id: 'asot', name: 'ASOT', valid: true }, { id: 'pmpc', name: 'PMPC', valid: true }],
            }),
        }), 'asot')
        if (view.kind === 'site') expect(view.sites.map(site => site.id)).toEqual(['asot', 'pmpc'])
    })

    // A registry entry hostd itself could not parse is answered with an id and a reason and no name
    it('falls back to the id when the project has no name', async () => {
        const view = await gatherSite(deps({
            listProjects: async () => ({ ok: true as const, value: [{ id: 'asot', valid: false, reason: 'compose.yml is unparseable' }] }),
        }), 'asot')
        if (view.kind === 'site') expect(view.name).toBe('asot')
    })

    // The listing is already scoped to what this caller may see, so an id that is not in it is not theirs
    // and not there, and both have to read the same from outside.
    it('cannot be told apart from forbidden by what it fails to find', async () => {
        const missing = await gatherSite(deps({ listProjects: async () => ({ ok: true as const, value: [] }) }), 'asot')
        const forbidden = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_X', user: 'cl_X' }, clientId: 'cl_X' }),
            owns: async () => false,
        }), 'asot')
        expect(missing.kind === 'missing' || missing.kind === 'forbidden').toBe(true)
        expect(forbidden.kind === 'missing' || forbidden.kind === 'forbidden').toBe(true)
    })
})
