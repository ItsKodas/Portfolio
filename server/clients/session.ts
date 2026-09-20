// What a client session is, as arithmetic and constants. No database and no next/* imports, so the rules can
// be read in one place and tested without either.

import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

// A sign-in that stops after the password. Long enough to find a phone, short enough to be worthless if left.
export const PENDING_SESSION_MS = 10 * 60 * 1000
export const IDLE_MS = 24 * 60 * 60 * 1000
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
export const TOUCH_AFTER_MS = 5 * 60 * 1000

// The __Secure- prefix requires HTTPS, so development would silently lose a cookie that carried it
export const cookieName = (secure: boolean) => (secure ? '__Secure-horizons-client' : 'horizons-client')

export const cookieOptions = (secure: boolean) => ({
    httpOnly: true,
    secure,
    // Lax, not Strict: invite and reset links arrive from a mail client as a top-level navigation, and Strict
    // would drop the cookie on that first hop.
    sameSite: 'lax' as const,
    path: '/',
})

export const newSessionToken = (random: (bytes: number) => Buffer = randomBytes) => random(32).toString('base64url')

// Only the hash is stored, so reading the table doesn't let anyone resume a session
export const hashSessionToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const pendingExpiry = (now: Date) => new Date(now.getTime() + PENDING_SESSION_MS)

// Idle or absolute, whichever runs out first
export const activeExpiry = (createdAt: Date, now: Date) =>
    new Date(Math.min(now.getTime() + IDLE_MS, createdAt.getTime() + ABSOLUTE_MS))

export const shouldTouch = (lastUsedAt: Date, now: Date) => now.getTime() - lastUsedAt.getTime() > TOUCH_AFTER_MS

type SessionState = { mfaAt: Date | null, expiresAt: Date }

export const isExpired = (session: SessionState, now: Date) => session.expiresAt.getTime() <= now.getTime()

// A session is usable only once the second factor is done. Only three code paths write mfaAt, and each is
// reached only after a verified TOTP code, a verified recovery code, or completed enrolment. That is what
// makes mandatory 2FA a property of the data rather than a check somebody can forget to write.
export const isUsable = (session: SessionState, now: Date) => !!session.mfaAt && !isExpired(session, now)

export const isPending = (session: SessionState, now: Date) => !session.mfaAt && !isExpired(session, now)
