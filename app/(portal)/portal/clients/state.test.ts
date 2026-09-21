import { describe, expect, it } from 'vitest'

import { clientState } from './state'

const now = new Date('2026-09-20T10:00:00Z')
const base = { passwordHash: null, totpConfirmedAt: null, suspendedAt: null, lockedUntil: null }

describe('clientState', () => {
    it('reads invited when there is no password yet', () => {
        expect(clientState(base, now)).toBe('Invited')
    })

    it('reads setup incomplete when the password is set but the authenticator is not', () => {
        expect(clientState({ ...base, passwordHash: 'x' }, now)).toBe('Setup incomplete')
    })

    it('reads active once both are done', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now }, now)).toBe('Active')
    })

    // Suspension is the answer whatever else is true, because it is the one that stops everything
    it('reads suspended ahead of anything else', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, suspendedAt: now, lockedUntil: new Date('2026-09-20T10:05:00Z') }, now))
            .toBe('Suspended')
    })

    it('reads locked only while the lock is in the future', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, lockedUntil: new Date('2026-09-20T10:05:00Z') }, now)).toBe('Locked')
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, lockedUntil: new Date('2026-09-20T09:55:00Z') }, now)).toBe('Active')
    })
})
