import { describe, expect, it } from 'vitest'

import { gatherHome } from './home'

const project = (id: string, state: string) => ({
    id,
    name: id,
    valid: true,
    services: [{ service: `${id}-web`, role: 'site' as const, state, health: null, startedAt: null, restartCount: null, image: null }],
})

function deps(over: Record<string, unknown> = {}) {
    return {
        who: async () => ({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }),
        config: () => ({ ok: true as const, value: { url: 'http://hostd-api:8080', token: 'a'.repeat(32) } }),
        listProjects: async () => ({ ok: true as const, value: [project('asot', 'exited'), project('pmpc', 'running')] }),
        getHealth: async () => ({ ok: true as const, value: { warnings: [], invalid: {}, system: null } }),
        ...over,
    }
}

describe('gatherHome', () => {
    it('reports the operator as the operator, with every site', async () => {
        const view = await gatherHome(deps())
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') expect(view.sites).toHaveLength(2)
    })

    it('says so when nobody is signed in, rather than pretending', async () => {
        const view = await gatherHome(deps({ who: async () => null }))
        expect(view.kind).toBe('anonymous')
    })

    it('still renders when hostd is unreachable, and says which part failed', async () => {
        // A portal that throws because one service is down is worse than one that tells you it is down
        const view = await gatherHome(deps({
            listProjects: async () => ({ ok: false as const, code: 'unavailable', message: 'hostd is not answering' }),
        }))
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') {
            expect(view.sites).toEqual([])
            expect(view.trouble).toMatch(/unavailable|not answering/i)
        }
    })

    it('still renders when hostd is not configured at all', async () => {
        const view = await gatherHome(deps({
            config: () => ({ ok: false as const, problems: ['HOSTD_API_TOKEN is not set'] }),
        }))
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') expect(view.trouble).toMatch(/HOSTD_API_TOKEN/)
    })

    it('never reports the machine to a client, because hostd refuses it anyway', async () => {
        const view = await gatherHome(deps({
            who: async () => ({ caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }),
        }))
        expect(view.kind).toBe('client')
        expect('health' in view).toBe(false)
    })
})
