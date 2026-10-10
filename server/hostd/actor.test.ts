import { describe, expect, it } from 'vitest'

import { callerForAdmin, callerForClient } from './actor'

describe('callerForAdmin', () => {
    it('is the literal admin, with the email for the audit log', () => {
        expect(callerForAdmin('koda@horizons.gg')).toEqual({ actor: 'admin', user: 'koda@horizons.gg' })
    })

    it('refuses an email hostd would reject as a user id', () => {
        expect(() => callerForAdmin('koda horizons.gg')).toThrow(/user id/i)
        expect(() => callerForAdmin('')).toThrow(/user id/i)
    })
})

describe('callerForClient', () => {
    it('names the client and the sites they have access to', () => {
        expect(callerForClient('cl_8F2K1ABC', ['acme-bakery'])).toEqual({ actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC', sites: ['acme-bakery'] })
    })

    // hostd refuses the whole header over one bad id, which would lock the client out of every site
    it('leaves out a site id hostd would never accept', () => {
        expect(callerForClient('cl_8F2K1ABC', ['acme-bakery', 'Not An Id', 'a,b']).sites).toEqual(['acme-bakery'])
    })

    it('refuses anything that is not one of our client ids', () => {
        // The header is the whole security seam: if a request could shape it, a client could become admin.
        expect(() => callerForClient('admin', [])).toThrow(/client id/i)
        expect(() => callerForClient('cl_8F2K1ABC extra', [])).toThrow(/client id/i)
        expect(() => callerForClient('', [])).toThrow(/client id/i)
    })
})
