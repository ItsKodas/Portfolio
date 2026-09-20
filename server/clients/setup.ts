// Turning an invite into a working account: set a password, enrol an authenticator, save the recovery codes.
// Leaving halfway is safe by construction, because none of these steps on its own produces a usable session.

import 'server-only'

import type { ClientTokenPurpose } from '../generated/prisma/client'
import type { ClientRecord, SessionWithClient } from './repo'
import { activeExpiry, pendingExpiry } from './session'
import { formatSecretForTyping, otpauthUri } from './totp'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 60 * 60 * 1000
export const RECOVERY_CODE_COUNT = 10

// One message for expired, used, unknown and suspended. Distinguishing them would turn the page into a way to
// probe which tokens exist.
export const LINK_ERROR = 'That link is no longer valid. Ask Koda for a new one.'

type TokenRecord = { purpose: ClientTokenPurpose, usedAt: Date | null, expiresAt: Date, client: { suspendedAt: Date | null } }

export function tokenProblem(token: TokenRecord | null, expected: ClientTokenPurpose, now: Date): string | null {
    if (!token) return LINK_ERROR
    // Checked, because an invite is redeemed without a second factor and a reset is not. Without this, a reset
    // link could be spent at the invite endpoint, and a compromised mailbox alone would be enough to change a
    // client's password and lock the real one out.
    if (token.purpose !== expected) return LINK_ERROR
    if (token.usedAt) return LINK_ERROR
    if (token.expiresAt.getTime() <= now.getTime()) return LINK_ERROR
    if (token.client.suspendedAt) return LINK_ERROR
    return null
}

export type CompleteInviteDeps = {
    tokenByHash(tokenHash: string): Promise<({ id: string } & TokenRecord & { client: ClientRecord }) | null>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    useToken(id: string, now: Date): Promise<void>
    createSession(clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<{ id: string }>
    newToken(): string
    hashToken(token: string): string
    now(): Date
    log(message: string, error?: unknown): void
}

export async function completeInvite(
    input: { tokenHash: string, password: string, userAgent: string | null },
    deps: CompleteInviteDeps,
): Promise<{ ok: true, token: string, expiresAt: Date } | { ok: false, error: string }> {
    const now = deps.now()
    const token = await deps.tokenByHash(input.tokenHash)
    const problem = tokenProblem(token, 'INVITE', now)
    if (problem || !token) return { ok: false, error: problem ?? LINK_ERROR }

    await deps.setPassword(token.client.id, await deps.hashPassword(input.password), now)
    await deps.useToken(token.id, now)

    // Still pending: mfaAt is not set here, so this session can reach enrolment and nothing else
    const sessionToken = deps.newToken()
    const expiresAt = pendingExpiry(now)
    await deps.createSession(token.client.id, deps.hashToken(sessionToken), expiresAt, input.userAgent)
    return { ok: true, token: sessionToken, expiresAt }
}

export type BeginEnrolmentDeps = {
    newSecret(): Buffer
    encryptSecret(plaintext: string): string
    storeSecret(id: string, encrypted: string): Promise<void>
    now(): Date
}

// Stores the secret straight away, unconfirmed, so reloading the page doesn't strand a half-scanned QR code.
// Harmless: sign-in needs totpConfirmedAt and a usable session needs mfaAt, and this sets neither.
export async function beginEnrolment(client: ClientRecord, deps: BeginEnrolmentDeps): Promise<{ uri: string, typed: string }> {
    const secret = deps.newSecret()
    await deps.storeSecret(client.id, deps.encryptSecret(secret.toString('base64')))
    return { uri: otpauthUri({ secret, email: client.email }), typed: formatSecretForTyping(secret) }
}

export type ConfirmEnrolmentDeps = {
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    confirmTotp(id: string, now: Date): Promise<void>
    newRecoveryCode(): string
    hashRecoveryCode(code: string): string
    replaceRecoveryCodes(clientId: string, codeHashes: string[]): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

const WRONG_CODE = 'That code is not right. Check the app and try the next one.'

export async function confirmEnrolment(
    input: { session: SessionWithClient, code: string },
    deps: ConfirmEnrolmentDeps,
): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }> {
    const now = deps.now()
    const client = input.session.client
    if (!client.totpSecret) return { ok: false, error: WRONG_CODE }

    let secret: Buffer
    try {
        secret = deps.decryptSecret(client.totpSecret)
    } catch (error) {
        deps.log(`The pending TOTP secret for ${client.id} could not be read`, error)
        return { ok: false, error: WRONG_CODE }
    }

    const step = deps.verifyTotp(secret, input.code, now)
    if (step === null) return { ok: false, error: WRONG_CODE }
    // The enrolling code is spent like any other, so it can't be replayed at the sign-in page
    if (!await deps.recordTotpUse(client.id, step)) return { ok: false, error: WRONG_CODE }

    await deps.confirmTotp(client.id, now)

    // Generated once and shown once. Only the keyed hashes are kept.
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => deps.newRecoveryCode())
    await deps.replaceRecoveryCodes(client.id, recoveryCodes.map(code => deps.hashRecoveryCode(code)))
    return { ok: true, recoveryCodes }
}

export type AcknowledgeDeps = {
    completeMfa(sessionId: string, mfaAt: Date, expiresAt: Date): Promise<void>
    recordSuccess(id: string, now: Date): Promise<void>
    now(): Date
}

// The third and last place mfaAt is written, and reachable only once confirmEnrolment has succeeded
export async function acknowledgeRecoveryCodes(session: SessionWithClient, deps: AcknowledgeDeps): Promise<void> {
    const now = deps.now()
    await deps.completeMfa(session.id, now, activeExpiry(session.createdAt, now))
    await deps.recordSuccess(session.client.id, now)
}
