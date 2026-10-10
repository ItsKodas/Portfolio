import { describe, expect, it } from 'vitest'

import { holdingContactOf } from './holdingContact'

const client = (over: Partial<Parameters<typeof holdingContactOf>[0][number]> = {}) => ({
    publicName: 'Acme Bakery', publicEmail: 'hello@acme.com', publicPhone: null, publicContactListed: true, ...over,
})

describe('holdingContactOf', () => {
    it('answers the first listed client, in the order they were given the site', () => {
        expect(holdingContactOf([client({ publicName: 'First' }), client({ publicName: 'Second' })]))
            .toEqual({ name: 'First', email: 'hello@acme.com', phone: null })
    })

    // Listing is the operator's call: details a client filled in are never shown until then
    it('skips a client who is not listed, or who left no way to reach them', () => {
        expect(holdingContactOf([
            client({ publicName: 'Unlisted', publicContactListed: false }),
            client({ publicName: 'Unreachable', publicEmail: null, publicPhone: null }),
            client({ publicName: 'Listed', publicEmail: null, publicPhone: '+61 400 000 000' }),
        ])).toEqual({ name: 'Listed', email: null, phone: '+61 400 000 000' })
    })

    it('answers none when nobody on the site is listed, so the site shows no contact', () => {
        expect(holdingContactOf([client({ publicContactListed: false })])).toBeNull()
        expect(holdingContactOf([])).toBeNull()
    })
})
