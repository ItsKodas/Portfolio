import { describe, expect, it } from 'vitest'

import { FREE_ATTEMPTS, IP_LIMIT, afterFailure, afterSuccess, ipWindowStart, isLocked, overIpLimit } from './limits'

const now = new Date('2026-09-20T10:00:00Z')
const minutesLater = (minutes: number) => new Date(now.getTime() + minutes * 60_000)

describe('overIpLimit', () => {
    it('allows attempts below the limit and refuses at it', () => {
        expect(overIpLimit(IP_LIMIT - 1)).toBe(false)
        expect(overIpLimit(IP_LIMIT)).toBe(true)
    })
})

describe('ipWindowStart', () => {
    it('looks back fifteen minutes', () => {
        expect(ipWindowStart(now)).toEqual(new Date('2026-09-20T09:45:00Z'))
    })
})

describe('isLocked', () => {
    it('is false when nothing is set', () => {
        expect(isLocked({ lockedUntil: null }, now)).toBe(false)
    })

    it('is true while the lock is in the future and false once it passes', () => {
        expect(isLocked({ lockedUntil: minutesLater(1) }, now)).toBe(true)
        expect(isLocked({ lockedUntil: minutesLater(-1) }, now)).toBe(false)
    })
})

describe('afterFailure', () => {
    // A typo is normal, and locking someone out on their second attempt would be hostile
    it('gives two free attempts before any lock', () => {
        expect(afterFailure({ failedSignIns: 0 }, now)).toEqual({ failedSignIns: 1, lockedUntil: null })
        expect(afterFailure({ failedSignIns: 1 }, now)).toEqual({ failedSignIns: 2, lockedUntil: null })
    })

    it('climbs 1, 5, 15 then 60 minutes', () => {
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS }, now).lockedUntil).toEqual(minutesLater(1))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 1 }, now).lockedUntil).toEqual(minutesLater(5))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 2 }, now).lockedUntil).toEqual(minutesLater(15))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 3 }, now).lockedUntil).toEqual(minutesLater(60))
    })

    it('stops at an hour rather than climbing forever', () => {
        expect(afterFailure({ failedSignIns: 50 }, now).lockedUntil).toEqual(minutesLater(60))
    })
})

describe('afterSuccess', () => {
    it('clears the count and the lock', () => {
        expect(afterSuccess()).toEqual({ failedSignIns: 0, lockedUntil: null })
    })
})
