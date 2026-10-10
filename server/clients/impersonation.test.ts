import { describe, expect, it } from 'vitest'

import { IMPERSONATION_MS, readImpersonation, recordImpersonation, signImpersonation } from './impersonation'

const KEY = 'a-test-secret-that-is-long-enough'
const ADMIN = 'koda@horizons.gg'
const NOW = new Date('2026-10-10T04:00:00Z')
const LATER = new Date(NOW.getTime() + IMPERSONATION_MS)

describe('the view-as cookie', () => {
    it('reads back the client it was made for, for the admin it was made for', () => {
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        expect(readImpersonation(value, ADMIN, KEY, NOW)).toBe('cl_8F2K1ABC')
        // The address is compared the way the admin check compares it
        expect(readImpersonation(value, ' Koda@Horizons.gg ', KEY, NOW)).toBe('cl_8F2K1ABC')
    })

    // The point of signing it: a browser cannot edit the id to look through somebody else
    it('refuses a cookie whose client id was changed', () => {
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        const edited = value.replace('cl_8F2K1ABC', 'cl_9G3M2DEF')
        expect(readImpersonation(edited, ADMIN, KEY, NOW)).toBeNull()
    })

    it('refuses a cookie whose expiry was pushed back', () => {
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        const [id, , mac] = value.split('.')
        expect(readImpersonation(`${id}.${LATER.getTime() + 1}.${mac}`, ADMIN, KEY, NOW)).toBeNull()
    })

    it('refuses a cookie made for another admin, or under another key', () => {
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        expect(readImpersonation(value, 'someone@gmail.com', KEY, NOW)).toBeNull()
        expect(readImpersonation(value, ADMIN, 'another-key', NOW)).toBeNull()
    })

    it('runs out', () => {
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        expect(readImpersonation(value, ADMIN, KEY, LATER)).toBeNull()
    })

    it('is nobody for no cookie, a malformed one, or no key', () => {
        expect(readImpersonation(undefined, ADMIN, KEY, NOW)).toBeNull()
        expect(readImpersonation('', ADMIN, KEY, NOW)).toBeNull()
        expect(readImpersonation('cl_8F2K1ABC', ADMIN, KEY, NOW)).toBeNull()
        expect(readImpersonation('nope.123.abc', ADMIN, KEY, NOW)).toBeNull()
        const value = signImpersonation('cl_8F2K1ABC', ADMIN, LATER, KEY)
        expect(readImpersonation(value, ADMIN, '', NOW)).toBeNull()
    })

    it('will not sign something that is not one of our client ids, or without a key', () => {
        expect(() => signImpersonation('admin', ADMIN, LATER, KEY)).toThrow()
        expect(() => signImpersonation('cl_8F2K1ABC', ADMIN, LATER, '')).toThrow()
    })
})

describe('recordImpersonation', () => {
    it('names the operator, the client and what happened', () => {
        const lines: string[] = []
        recordImpersonation({ kind: 'start', admin: ADMIN, clientId: 'cl_8F2K1ABC', at: NOW }, line => lines.push(line))
        recordImpersonation({ kind: 'stop', admin: ADMIN, clientId: 'cl_8F2K1ABC', at: NOW }, line => lines.push(line))
        expect(lines).toEqual([
            `[admin] ${ADMIN} started viewing as client cl_8F2K1ABC at 2026-10-10T04:00:00.000Z`,
            `[admin] ${ADMIN} stopped viewing as client cl_8F2K1ABC at 2026-10-10T04:00:00.000Z`,
        ])
    })
})
