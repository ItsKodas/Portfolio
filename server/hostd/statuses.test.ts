import { describe, expect, it, vi } from 'vitest'

import type { Project, ServiceStatus } from './projects'
import { FALLBACK_CAP, fillStatuses } from './statuses'

const service = (state: string): ServiceStatus => ({
    service: 'web',
    role: 'site',
    state,
    health: null,
    startedAt: null,
    restartCount: null,
    image: null,
})

const project = (over: Partial<Project> = {}): Project => ({ id: 'pmpc-group', name: 'PMPC Group', valid: true, ...over })

describe('filling in a listing that said nothing about the containers', () => {
    it('asks per project when the listing carried no status at all', async () => {
        // What a hostd older than the status flag answers: it ignores the parameter and gives the cheap
        // listing, so the portal has five sites and nothing to say about any of them.
        const read = vi.fn().mockResolvedValue({ ok: true, value: [service('running')] })

        const filled = await fillStatuses([project({ id: 'a' }), project({ id: 'b' })], read)

        expect(read.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
        expect(filled[0].status).toEqual({ ok: true, services: [service('running')] })
        expect(filled[1].status).toEqual({ ok: true, services: [service('running')] })
    })

    it('asks nothing when hostd already answered', async () => {
        // The whole point of status=1 is that this costs one request. A current hostd must not be asked
        // five more times for what it just sent.
        const read = vi.fn()

        const listed = [project({ status: { ok: true, services: [] } })]
        const filled = await fillStatuses(listed, read)

        expect(read).not.toHaveBeenCalled()
        expect(filled).toBe(listed)
    })

    it('asks again about a project the batch read refused', async () => {
        // The batch lists every container on the machine and groups them; a single read asks Docker about
        // one project. They are different questions and the second can be answered when the first was not.
        const read = vi.fn().mockResolvedValue({ ok: true, value: [service('running')] })
        const refused = project({ status: { ok: false, code: 'failed', message: 'the agent returned no status' } })

        const filled = await fillStatuses([refused], read)

        expect(read).toHaveBeenCalledWith('pmpc-group')
        expect(filled[0].status).toEqual({ ok: true, services: [service('running')] })
    })

    it('keeps the reason when the second ask is refused too', async () => {
        // A reason beside the row is the one thing a listing that says nothing never gave us
        const read = vi.fn().mockResolvedValue({ ok: false, code: 'agent-unavailable', message: 'the agent is not answering' })

        const filled = await fillStatuses([project()], read)

        expect(filled[0].status).toEqual({ ok: false, code: 'agent-unavailable', message: 'the agent is not answering' })
    })

    it('has something to say even when the refusal did not', async () => {
        const read = vi.fn().mockResolvedValue({ ok: false })

        const filled = await fillStatuses([project()], read)

        expect(filled[0].status).toEqual({ ok: false, code: 'failed', message: 'hostd did not answer' })
    })

    it('leaves an entry hostd could not parse alone', async () => {
        // It has no containers to ask about, and the read would only come back with the refusal the
        // entry is already carrying.
        const read = vi.fn()

        const filled = await fillStatuses([project({ valid: false, reason: 'dir is not under /var/www' })], read)

        expect(read).not.toHaveBeenCalled()
        expect(filled[0].status).toBeUndefined()
    })

    it('reads the bare services a single project read answers with', async () => {
        const read = vi.fn()

        await fillStatuses([project({ services: [service('running')] })], read)

        expect(read).not.toHaveBeenCalled()
    })

    it('stops at the cap, because this is one request per project', async () => {
        const read = vi.fn().mockResolvedValue({ ok: true, value: [] })
        const many = Array.from({ length: FALLBACK_CAP + 5 }, (_, n) => project({ id: `site-${n}` }))

        const filled = await fillStatuses(many, read)

        expect(read).toHaveBeenCalledTimes(FALLBACK_CAP)
        // The ones past it are left as they were rather than guessed at, so they still read as unknown
        expect(filled[FALLBACK_CAP].status).toBeUndefined()
    })
})
