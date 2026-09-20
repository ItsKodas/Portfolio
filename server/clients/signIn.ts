// Signing a client in, in two steps. Dependencies are passed in so every rule below can be tested without a
// database, a clock or a relay, in the style of server/quotes/submit.ts.

import 'server-only'

import { normaliseRecoveryCode } from './ids'
import { afterFailure, ipWindowStart, isLocked, overIpLimit, type LockUpdate } from './limits'
import type { ClientRecord, SessionWithClient } from './repo'
import { activeExpiry, pendingExpiry } from './session'

// Deliberately vague, and deliberately the same for a wrong password, an unknown address, a suspended account
// and an account that has not finished setup. None of those may be distinguishable from outside.
export const GENERIC_ERROR = 'Those details are not right, or the account is not ready yet.'
export const TOO_MANY_ERROR = 'Too many attempts. Please try again in a few minutes.'
// Only ever shown to someone who already supplied the correct password, so it enumerates nothing
export const LOCKED_ERROR = 'This account is locked for a short while. Please try again later.'
export const CODE_ERROR = 'That code is not right. Check your authenticator app, or use a recovery code.'
export const REPLAYED_ERROR = 'That code has already been used. Wait for the next one.'

export type PasswordStepDeps = {
    findByEmail(email: string): Promise<ClientRecord | null>
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    recordFailure(id: string, update: LockUpdate): Promise<void>
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    burnTime(): Promise<void>
    rehash(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    createSession(clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<{ id: string }>
    newToken(): string
    hashToken(token: string): string
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export type PasswordStepResult =
    | { ok: true, next: 'code' | 'setup', token: string, expiresAt: Date }
    | { ok: false, error: string }

export async function passwordStep(
    input: { email: string, password: string, userAgent: string | null },
    deps: PasswordStepDeps,
): Promise<PasswordStepResult> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'

    // First, because hashing is the expensive path and this is the cheap one. The other order would make the
    // form a way to make the server allocate 134 MB per request.
    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { ok: false, error: TOO_MANY_ERROR }

    const client = await deps.findByEmail(input.email)

    // No account, or an account that never finished setup: burn the same work anyway, so the answer and the
    // timing are the same as a wrong password and the form can't be used to discover who the clients are.
    if (!client?.passwordHash) {
        await deps.burnTime()
        await deps.recordAttempt(ipHash)
        return { ok: false, error: GENERIC_ERROR }
    }

    const { ok, needsRehash } = await deps.verifyPassword(input.password, client.passwordHash)
    if (!ok) {
        await deps.recordAttempt(ipHash)
        await deps.recordFailure(client.id, afterFailure(client, now))
        return { ok: false, error: GENERIC_ERROR }
    }

    // Everything below here is only reachable with the correct password, so it can be specific without
    // telling a stranger anything.
    if (client.suspendedAt) return { ok: false, error: GENERIC_ERROR }
    if (isLocked(client, now)) return { ok: false, error: LOCKED_ERROR }

    // The cost parameters travel with the hash, so an upgrade costs the client nothing and happens silently
    if (needsRehash) {
        try {
            await deps.setPassword(client.id, await deps.rehash(input.password), now)
        } catch (error) {
            // A failed upgrade must never be a failed sign-in
            deps.log(`Rehashing the password for ${client.id} failed`, error)
        }
    }

    const token = deps.newToken()
    const expiresAt = pendingExpiry(now)
    // mfaAt stays null: this creates a session that can reach the second factor and nothing else
    await deps.createSession(client.id, deps.hashToken(token), expiresAt, input.userAgent)
    return { ok: true, next: client.totpConfirmedAt ? 'code' : 'setup', token, expiresAt }
}

export type CodeStepDeps = {
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    recordFailure(id: string, update: LockUpdate): Promise<void>
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    unusedRecoveryCodes(clientId: string): Promise<{ id: string, codeHash: string }[]>
    recoveryCodeMatches(normalised: string, storedHash: string): boolean
    useRecoveryCode(id: string, now: Date): Promise<void>
    completeMfa(sessionId: string, mfaAt: Date, expiresAt: Date): Promise<void>
    recordSuccess(id: string, now: Date): Promise<void>
    prune(clientId: string, now: Date): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export async function codeStep(
    input: { session: SessionWithClient, code: string },
    deps: CodeStepDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'
    const { session } = input
    const client = session.client

    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { ok: false, error: TOO_MANY_ERROR }

    const finish = async () => {
        await deps.completeMfa(session.id, now, activeExpiry(session.createdAt, now))
        await deps.recordSuccess(client.id, now)
        // Lazily, here, because a successful sign-in is the only moment those tables grow
        await deps.prune(client.id, now)
        return { ok: true } as const
    }

    const fail = async (error: string) => {
        await deps.recordAttempt(ipHash)
        await deps.recordFailure(client.id, afterFailure(client, now))
        return { ok: false, error } as const
    }

    if (client.totpSecret) {
        let secret: Buffer
        try {
            secret = deps.decryptSecret(client.totpSecret)
        } catch (error) {
            // The key is wrong or the row was tampered with. Refuse: never fall through to treating the client
            // as having no second factor.
            deps.log(`The stored TOTP secret for ${client.id} could not be read`, error)
            return { ok: false, error: CODE_ERROR }
        }

        const step = deps.verifyTotp(secret, input.code, now)
        if (step !== null) {
            // The unique key refuses a replay, so there is no window between checking and recording
            if (!await deps.recordTotpUse(client.id, step)) return { ok: false, error: REPLAYED_ERROR }
            return finish()
        }
    }

    // One box takes both, so fall back to reading it as a recovery code
    const normalised = normaliseRecoveryCode(input.code)
    if (normalised.length > 0) {
        for (const candidate of await deps.unusedRecoveryCodes(client.id)) {
            if (deps.recoveryCodeMatches(normalised, candidate.codeHash)) {
                await deps.useRecoveryCode(candidate.id, now)
                return finish()
            }
        }
    }

    return fail(CODE_ERROR)
}
