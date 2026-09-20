import { describe, expect, it } from 'vitest'

import { activeExpiry, cookieName, cookieOptions, hashSessionToken, isPending, isUsable, newSessionToken, pendingExpiry, shouldTouch } from './session'

const now = new Date('2026-09-20T10:00:00Z')
const minutes = (count: number) => new Date(now.getTime() + count * 60_000)

describe('the cookie', () => {
    // The __Secure- prefix is only honoured over HTTPS, so development would silently lose the cookie
    it('takes the __Secure- prefix only in production', () => {
        expect(cookieName(true)).toBe('__Secure-horizons-client')
        expect(cookieName(false)).toBe('horizons-client')
    })

    it('is HttpOnly and Lax', () => {
        // Lax, not Strict: an invite link arrives from a mail client as a top-level navigation, and Strict
        // would drop the cookie on that first hop
        expect(cookieOptions(true)).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
        expect(cookieOptions(false).secure).toBe(false)
    })
})

describe('tokens', () => {
    it('is 32 random bytes as base64url, so it is URL and cookie safe', () => {
        const token = newSessionToken()
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('does not repeat itself', () => {
        expect(new Set(Array.from({ length: 500 }, () => newSessionToken())).size).toBe(500)
    })

    // Only the hash is stored, so reading the table doesn't let anyone resume a session
    it('hashes to stable hex that is not the token', () => {
        const token = newSessionToken()
        expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/)
        expect(hashSessionToken(token)).toBe(hashSessionToken(token))
        expect(hashSessionToken(token)).not.toContain(token)
    })
})

describe('lifetimes', () => {
    it('gives a half-finished sign-in ten minutes', () => {
        expect(pendingExpiry(now)).toEqual(minutes(10))
    })

    it('gives a finished session 24 hours of idle time', () => {
        expect(activeExpiry(now, now)).toEqual(minutes(24 * 60))
    })

    // 7 days absolute wins once the session is old, however recently it was used. now + 24h would be
    // 2026-09-21T20:00:00Z, so this only passes if the earlier of the two limits is taken.
    it('caps at 7 days from when the session started', () => {
        const createdAt = new Date('2026-09-14T10:00:00Z')
        expect(activeExpiry(createdAt, new Date('2026-09-20T20:00:00Z'))).toEqual(new Date('2026-09-21T10:00:00Z'))
    })

    it('writes lastUsedAt at most every five minutes, so a page view costs no write', () => {
        expect(shouldTouch(minutes(-1), now)).toBe(false)
        expect(shouldTouch(minutes(-6), now)).toBe(true)
    })
})

describe('usability', () => {
    const pending = { mfaAt: null, expiresAt: minutes(5) }
    const done = { mfaAt: minutes(-10), expiresAt: minutes(60) }

    // The heart of mandatory 2FA: a session without mfaAt is not usable for anything
    it('treats a session without mfaAt as pending, never usable', () => {
        expect(isUsable(pending, now)).toBe(false)
        expect(isPending(pending, now)).toBe(true)
    })

    it('treats a session with mfaAt as usable', () => {
        expect(isUsable(done, now)).toBe(true)
        expect(isPending(done, now)).toBe(false)
    })

    it('treats an expired session as neither', () => {
        const expired = { mfaAt: minutes(-100), expiresAt: minutes(-1) }
        expect(isUsable(expired, now)).toBe(false)
        expect(isPending(expired, now)).toBe(false)
    })

    // The case the design depends on: an expired half-session must lose its claim on the second-factor
    // step. Without this fixture, dropping the expiry check from isPending breaks nothing in the suite,
    // because the other expired fixture has mfaAt set and is refused for a different reason.
    it('treats an expired half-session as neither usable nor pending', () => {
        const expiredPending = { mfaAt: null, expiresAt: minutes(-1) }
        expect(isUsable(expiredPending, now)).toBe(false)
        expect(isPending(expiredPending, now)).toBe(false)
    })
})
