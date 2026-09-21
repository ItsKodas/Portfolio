import { describe, expect, it } from 'vitest'

import { STATE_TONES, clientState, type ClientState } from './state'

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

describe('STATE_TONES', () => {
    // A state with no tone is a chip that still says what it says, so the mapping being total matters more
    // than any one entry in it: a state added later without a tone would silently paint itself neutral.
    it('has an entry for every state, so none falls through', () => {
        const states: ClientState[] = ['Invited', 'Setup incomplete', 'Suspended', 'Locked', 'Active']
        for (const state of states) expect(Object.keys(STATE_TONES)).toContain(state)
    })

    it('keeps what each state meant when it was a MUI colour', () => {
        expect(STATE_TONES.Active).toBe('good')
        expect(STATE_TONES.Suspended).toBe('crit')
        expect(STATE_TONES.Locked).toBe('warn')
        expect(STATE_TONES['Setup incomplete']).toBe('warn')
        // MUI's `info`, which has no tone in ui/Chip and is not a problem
        expect(STATE_TONES.Invited).toBeUndefined()
    })
})
