// How hard someone may try. Pure arithmetic over counts and timestamps, so the rules are readable in one place
// and testable without a database.

import 'server-only'

// Across sign-in, the second factor and reset requests, per IP
export const IP_LIMIT = 10
export const IP_WINDOW_MS = 15 * 60 * 1000

// A typo is normal, so the first two failures cost nothing. After that the wait climbs and stops at an hour:
// long enough to make grinding pointless, short enough that a real client isn't locked out for the day.
export const FREE_ATTEMPTS = 2
export const LOCK_LADDER_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export const overIpLimit = (recentAttempts: number) => recentAttempts >= IP_LIMIT

export const ipWindowStart = (now: Date) => new Date(now.getTime() - IP_WINDOW_MS)

export const isLocked = (client: { lockedUntil: Date | null }, now: Date) =>
    !!client.lockedUntil && client.lockedUntil.getTime() > now.getTime()

export type LockUpdate = { failedSignIns: number, lockedUntil: Date | null }

export function afterFailure(client: { failedSignIns: number }, now: Date): LockUpdate {
    const failedSignIns = client.failedSignIns + 1
    const rung = failedSignIns - FREE_ATTEMPTS
    if (rung < 1) return { failedSignIns, lockedUntil: null }
    const wait = LOCK_LADDER_MS[Math.min(rung, LOCK_LADDER_MS.length) - 1]
    return { failedSignIns, lockedUntil: new Date(now.getTime() + wait) }
}

export const afterSuccess = (): LockUpdate => ({ failedSignIns: 0, lockedUntil: null })
