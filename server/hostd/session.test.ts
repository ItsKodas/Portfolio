import { describe, expect, it } from 'vitest'

import { callerFromSession, type SessionSources } from './session'

const ADMIN_EMAIL = 'koda@horizons.gg'

function sources(overrides: Partial<SessionSources> = {}): SessionSources {
    return {
        adminSession: async () => null,
        adminEmail: ADMIN_EMAIL,
        clientSession: async () => null,
        clientSites: async () => [],
        impersonating: async () => null,
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

    it('turns a client session into that client, with their sites, and reports the id the relay checks access with', async () => {
        const who = await callerFromSession(sources({
            clientSession: async () => ({ client: { id: 'cl_8F2K1ABC' } }),
            clientSites: async clientId => (clientId === 'cl_8F2K1ABC' ? ['acme-bakery', 'shared-shop'] : []),
        }))
        expect(who).toEqual({
            caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC', sites: ['acme-bakery', 'shared-shop'] },
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

    describe('viewing as a client', () => {
        const admin = { adminSession: async () => ({ user: { email: ADMIN_EMAIL } }) }

        // Everything the portal and hostd check is the client's: their id, so the page reads their grants,
        // and their sites, so hostd holds their line. Only the audit user is the operator.
        it('makes the operator that client, and keeps the operator as the one asking', async () => {
            const who = await callerFromSession(sources({
                ...admin,
                impersonating: async email => (email === ADMIN_EMAIL ? { id: 'cl_8F2K1ABC', name: 'Acme Bakery' } : null),
                clientSites: async clientId => (clientId === 'cl_8F2K1ABC' ? ['acme-bakery'] : ['someone-else']),
            }))
            expect(who).toEqual({
                caller: { actor: 'client:cl_8F2K1ABC', user: ADMIN_EMAIL, sites: ['acme-bakery'] },
                clientId: 'cl_8F2K1ABC',
                impersonatedBy: ADMIN_EMAIL,
                clientName: 'Acme Bakery',
            })
        })

        // The cookie is a choice the operator made, not a session: without the operator it is nobody
        it('is never asked without the admin session', async () => {
            let asked = false
            const who = await callerFromSession(sources({
                impersonating: async () => {
                    asked = true
                    return { id: 'cl_8F2K1ABC', name: 'Acme Bakery' }
                },
            }))
            expect(who).toBeNull()
            expect(asked).toBe(false)
        })

        it('is never asked for a signed-in account that is not the admin', async () => {
            let asked = false
            await callerFromSession(sources({
                adminSession: async () => ({ user: { email: 'someone@gmail.com' } }),
                impersonating: async () => {
                    asked = true
                    return { id: 'cl_8F2K1ABC', name: 'Acme Bakery' }
                },
            }))
            expect(asked).toBe(false)
        })

        it('leaves the operator as themselves when they are not viewing as anyone', async () => {
            const who = await callerFromSession(sources(admin))
            expect(who).toEqual({ caller: { actor: 'admin', user: ADMIN_EMAIL }, clientId: null })
        })
    })
})
