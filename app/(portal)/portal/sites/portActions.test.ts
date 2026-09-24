import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const checkPort = vi.fn()

vi.mock('@/server/hostd/config', () => ({ readHostd: () => ({ url: 'http://hostd', token: 't' }) }))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/ports', () => ({ checkPort: (...args: unknown[]) => checkPort(...args) }))

const { checkPortAction } = await import('./portActions')

beforeEach(() => {
    vi.clearAllMocks()
    callerFromSession.mockResolvedValue({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null })
    checkPort.mockResolvedValue({ ok: true, value: { suggested: 5014, problem: null } })
})

describe('checkPortAction', () => {
    it('checks a port for a named environment beside live', async () => {
        expect(await checkPortAction(5014, { project: 'acme', environment: 'uat1' }))
            .toEqual({ ok: true, suggested: 5014, problem: null })
        expect(checkPort).toHaveBeenCalledWith(expect.anything(), expect.anything(), { port: 5014, own: { project: 'acme', environment: 'uat1' } })
    })

    it('refuses an environment that is not a valid name, before the session is read', async () => {
        for (const environment of ['uat-1', 'next', 'Live']) {
            expect(await checkPortAction(5014, { project: 'acme', environment }))
                .toEqual({ ok: false, error: 'That is not something this form can do.' })
        }
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(checkPort).not.toHaveBeenCalled()
    })
})
