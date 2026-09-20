// Forgetting and resetting a password. The request side reveals nothing about who exists; the completion side
// still demands a second factor, so a compromised mailbox on its own is not enough to take an account.

import 'server-only'

import type { ClientTokenPurpose } from '../generated/prisma/client'
import { normaliseRecoveryCode } from './ids'
import { afterFailure, ipWindowStart, isLocked, overIpLimit, type LockUpdate } from './limits'
import type { ClientRecord } from './repo'
import { LINK_ERROR, RESET_TTL_MS, tokenProblem } from './setup'
// Imported rather than restated, so the reset page and the sign-in page cannot drift apart on the wording a
// throttled or locked person sees
import { LOCKED_ERROR, TOO_MANY_ERROR } from './signIn'

// Said whether or not the address matched anything
export const RESET_SENT_MESSAGE = 'If that address has an account, a reset link is on its way. It is valid for one hour.'

const CODE_REQUIRED = 'Enter the code from your authenticator app, or a recovery code.'

export const issueToken = (deps: { newToken(): string, hashToken(token: string): string }) => {
    const token = deps.newToken()
    return { token, tokenHash: deps.hashToken(token) }
}

export type RequestResetDeps = {
    findByEmail(email: string): Promise<ClientRecord | null>
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    invalidateTokens(clientId: string, purpose: 'PASSWORD_RESET', now: Date): Promise<void>
    createToken(clientId: string, purpose: 'PASSWORD_RESET', tokenHash: string, expiresAt: Date): Promise<void>
    newToken(): string
    hashToken(token: string): string
    sendLater(task: () => Promise<void>): void
    sendReset(client: ClientRecord, token: string): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export async function requestReset(input: { email: string }, deps: RequestResetDeps): Promise<{ message: string }> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'

    // Counted whether or not it matched: a request that finds nothing is not a failure the person can see, and
    // must still be bounded, or this becomes a way to send mail at someone else's expense
    await deps.recordAttempt(ipHash)
    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { message: RESET_SENT_MESSAGE }

    const client = await deps.findByEmail(input.email)
    if (client && !client.suspendedAt) {
        await deps.invalidateTokens(client.id, 'PASSWORD_RESET', now)
        const { token, tokenHash } = issueToken(deps)
        await deps.createToken(client.id, 'PASSWORD_RESET', tokenHash, new Date(now.getTime() + RESET_TTL_MS))
        // Handed to after(): sending inline would make a request for a real address measurably slower than one
        // for an address that doesn't exist, which would undo the point of the identical answer
        deps.sendLater(async () => {
            try {
                await deps.sendReset(client, token)
            } catch (error) {
                deps.log(`Sending the reset email for ${client.id} failed`, error)
            }
        })
    }

    return { message: RESET_SENT_MESSAGE }
}

export type CompleteResetDeps = {
    tokenByHash(tokenHash: string): Promise<({ id: string, purpose: ClientTokenPurpose, usedAt: Date | null, expiresAt: Date, client: ClientRecord }) | null>
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    recordFailure(id: string, update: LockUpdate): Promise<void>
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    unusedRecoveryCodes(clientId: string): Promise<{ id: string, codeHash: string }[]>
    recoveryCodeMatches(normalised: string, storedHash: string): boolean
    useRecoveryCode(id: string, now: Date): Promise<void>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    useToken(id: string, now: Date): Promise<void>
    deleteSessionsFor(clientId: string): Promise<void>
    clearLock(id: string): Promise<void>
    sendLater(task: () => Promise<void>): void
    sendChanged(client: ClientRecord): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export async function completeReset(
    input: { tokenHash: string, password: string, code: string },
    deps: CompleteResetDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'

    // First, before anything is looked up. A wrong code here is otherwise free to the person guessing: the
    // hashing only runs once the code is accepted, and the link is only spent on success, so it stays live for
    // its full hour. Without this the second factor the page demands has no bound at all.
    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { ok: false, error: TOO_MANY_ERROR }

    const token = await deps.tokenByHash(input.tokenHash)
    // The purpose check is what stops a reset token being spent at the invite endpoint: an invite needs no
    // second factor, so a reset token accepted there would let a compromised mailbox alone change a password.
    const problem = tokenProblem(token, 'PASSWORD_RESET', now)
    if (problem || !token) return { ok: false, error: problem ?? LINK_ERROR }

    const client = token.client

    // The ladder the failures below write is only a bound if something reads it back. Showing the lock here
    // tells a stranger nothing: reaching this line already needs a live link out of the client's own mailbox.
    if (isLocked(client, now)) return { ok: false, error: LOCKED_ERROR }

    // A client with an authenticator must use it: an email compromise alone must not be enough. A client who
    // has never enrolled has nothing to give, and is forced through enrolment before the session is usable.
    // totpConfirmedAt alone, not totpSecret as well: a row with the flag set and no secret is corrupted,
    // and the safe reading of a corrupted second factor is "refuse", not "there isn't one". The exemption
    // below is only for a client who genuinely never enrolled.
    if (client.totpConfirmedAt) {
        const accepted = await acceptSecondFactor(client, input.code, deps, now)
        if (!accepted) {
            // Counted the same way codeStep counts a wrong code, against the IP and against the account
            await deps.recordAttempt(ipHash)
            await deps.recordFailure(client.id, afterFailure(client, now))
            return { ok: false, error: CODE_REQUIRED }
        }
    }

    await deps.setPassword(client.id, await deps.hashPassword(input.password), now)
    await deps.useToken(token.id, now)
    // A reset is exactly the moment to end anything already signed in
    await deps.deleteSessionsFor(client.id)
    await deps.clearLock(client.id)

    deps.sendLater(async () => {
        try {
            await deps.sendChanged(client)
        } catch (error) {
            deps.log(`Sending the password-changed notice for ${client.id} failed`, error)
        }
    })

    return { ok: true }
}

async function acceptSecondFactor(client: ClientRecord, code: string, deps: CompleteResetDeps, now: Date): Promise<boolean> {
    // Reached only when totpConfirmedAt is set, so a missing secret here means the row is corrupted, not that
    // the client never enrolled. Refuse rather than falling through to the recovery-code branch.
    if (!client.totpSecret) return false
    try {
        const step = deps.verifyTotp(deps.decryptSecret(client.totpSecret), code, now)
        if (step !== null) return deps.recordTotpUse(client.id, step)
    } catch (error) {
        deps.log(`The stored TOTP secret for ${client.id} could not be read`, error)
        return false
    }
    const normalised = normaliseRecoveryCode(code)
    if (!normalised) return false
    for (const candidate of await deps.unusedRecoveryCodes(client.id)) {
        if (deps.recoveryCodeMatches(normalised, candidate.codeHash)) {
            await deps.useRecoveryCode(candidate.id, now)
            return true
        }
    }
    return false
}
