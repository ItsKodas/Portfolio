import { describe, expect, it } from 'vitest'

import { forAdmin, forClient } from './errors'

describe('forClient', () => {
    it('says what happened without naming anything on the server', () => {
        expect(forClient('unavailable')).toBe('This is temporarily unavailable. Nothing has changed, and it is being looked at.')
        expect(forClient('forbidden')).toBe('You do not have access to this.')
        expect(forClient('busy')).toBe('Something else is already running on your site. Try again in a moment.')
    })

    it('falls back without echoing an unknown code', () => {
        expect(forClient('some-new-code-hostd-invented')).toBe('Something went wrong. Koda has been told.')
    })

    it('never leaks a path, a project id or a service name', () => {
        // hostd's own messages name these; the client's version must not.
        const leaky = ['/var/www/acme-bakery', 'acme-bakery', 'acme-web']
        for (const code of ['unavailable', 'forbidden', 'busy', 'unknown']) {
            for (const secret of leaky) expect(forClient(code)).not.toContain(secret)
        }
    })
})

describe('forAdmin', () => {
    it('keeps the words hostd used, because the admin is the operator', () => {
        expect(forAdmin('invalid', 'storage media is not a directory')).toBe('invalid: storage media is not a directory')
    })
})
