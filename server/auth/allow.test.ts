import { describe, expect, it } from 'vitest'

import { isAdminSession, isAllowedAdmin } from './allow'

const ADMIN = 'koda@horizons.gg'

describe('isAllowedAdmin', () => {
    it('allows the admin account once Google has verified it, ignoring case and spaces', () => {
        expect(isAllowedAdmin({ email: 'koda@horizons.gg', email_verified: true }, ADMIN)).toBe(true)
        expect(isAllowedAdmin({ email: ' Koda@Horizons.gg ', email_verified: true }, ' KODA@horizons.gg')).toBe(true)
    })

    it('refuses any other account', () => {
        expect(isAllowedAdmin({ email: 'someone@gmail.com', email_verified: true }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: 'koda@horizons.gg.evil.com', email_verified: true }, ADMIN)).toBe(false)
    })

    it('refuses the right address when Google has not verified it', () => {
        expect(isAllowedAdmin({ email: ADMIN, email_verified: false }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: ADMIN }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: ADMIN, email_verified: 'true' }, ADMIN)).toBe(false)
    })

    it('refuses everyone when ADMIN_EMAIL is not set', () => {
        expect(isAllowedAdmin({ email: ADMIN, email_verified: true }, undefined)).toBe(false)
        expect(isAllowedAdmin({ email: '', email_verified: true }, '')).toBe(false)
    })

    it('refuses a missing profile', () => {
        expect(isAllowedAdmin(undefined, ADMIN)).toBe(false)
    })
})

describe('isAdminSession', () => {
    it('accepts a session for the admin address only', () => {
        expect(isAdminSession({ user: { email: 'KODA@horizons.gg' } }, ADMIN)).toBe(true)
        expect(isAdminSession({ user: { email: 'someone@gmail.com' } }, ADMIN)).toBe(false)
    })

    it('refuses no session, a session without an email, and an unset ADMIN_EMAIL', () => {
        expect(isAdminSession(null, ADMIN)).toBe(false)
        expect(isAdminSession({ user: {} }, ADMIN)).toBe(false)
        expect(isAdminSession({ user: { email: ADMIN } }, undefined)).toBe(false)
    })
})
