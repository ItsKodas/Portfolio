import { describe, expect, it } from 'vitest'

import { callerFromSession, type SessionSources } from './session'

const ADMIN_EMAIL = 'koda@horizons.gg'

function sources(overrides: Partial<SessionSources> = {}): SessionSources {
    return {
        adminSession: async () => null,
        adminEmail: ADMIN_EMAIL,
        clientSession: async () => null,
        ...overrides,
    }
}

describe('callerFromSession', () => {
    it('turns the admin session into the admin caller, owning everything', async () => {
        const who = await callerFromSession(sources({
            adminSession: async () => ({ user: { email: ADMIN_EMAIL } }),
        }))
        expect(who).toEqual({ caller: { actor: 'admin', user: ADMIN_EMAIL }, clientId: null })
    })

    it('turns a client session into that client, and reports the id the relay checks ownership with', async () => {
        const who = await callerFromSession(sources({
            clientSession: async () => ({ client: { id: 'cl_8F2K1ABC' } }),
        }))
        expect(who).toEqual({
            caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' },
            clientId: 'cl_8F2K1ABC',
        })
    })

    it('is nobody when neither session is present', async () => {
        expect(await callerFromSession(sources())).toBeNull()
    })

    // A signed-in Google account that is not ADMIN_EMAIL must not become the operator. isAdminSession is the
    // same check the admin pages make, rather than a second one that only happens to agree with it.
    it('refuses a signed-in account that is not the admin', async () => {
        const who = await callerFromSession(sources({
            adminSession: async () => ({ user: { email: 'someone@gmail.com' } }),
        }))
        expect(who).toBeNull()
    })

    it('does not make an admin of anyone when ADMIN_EMAIL is unset', async () => {
        const who = await callerFromSession(sources({
            adminSession: async () => ({ user: { email: ADMIN_EMAIL } }),
            adminEmail: undefined,
        }))
        expect(who).toBeNull()
    })

    // The operator is checked first and answered first, so a client session is never even read for them.
    it('prefers the admin, and does not read the client session at all', async () => {
        let readClient = false
        const who = await callerFromSession(sources({
            adminSession: async () => ({ user: { email: ADMIN_EMAIL } }),
            clientSession: async () => {
                readClient = true
                return { client: { id: 'cl_8F2K1ABC' } }
            },
        }))
        expect(who?.caller.actor).toBe('admin')
        expect(readClient).toBe(false)
    })
})
