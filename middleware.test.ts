import { describe, expect, it } from 'vitest'

import { hasPortalSession } from './middleware'

describe('hasPortalSession', () => {
    it('lets a client through on their own cookie', () => {
        expect(hasPortalSession(['horizons-client'])).toBe(true)
    })

    it('lets the operator through on an Auth.js session cookie', () => {
        // The operator has no client cookie and never will. Without this they are bounced to the client
        // sign-in from their own portal.
        expect(hasPortalSession(['authjs.session-token'])).toBe(true)
    })

    it('accepts the secure names used in production', () => {
        expect(hasPortalSession(['__Secure-horizons-client'])).toBe(true)
        expect(hasPortalSession(['__Secure-authjs.session-token'])).toBe(true)
    })

    it('refuses someone carrying neither', () => {
        expect(hasPortalSession([])).toBe(false)
        expect(hasPortalSession(['some-other-cookie'])).toBe(false)
    })
})
