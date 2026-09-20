// What a client can do to their own account.

import 'server-only'

import type { ClientRecord } from './repo'
import { RECOVERY_CODE_COUNT } from './setup'

export const WRONG_PASSWORD = 'That password is not right.'

export type ChangePasswordDeps = {
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    deleteSessionsFor(clientId: string, exceptId?: string): Promise<void>
    sendLater(task: () => Promise<void>): void
    sendChanged(client: ClientRecord): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

export async function changePassword(
    input: { client: ClientRecord, sessionId: string, current: string, next: string },
    deps: ChangePasswordDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const { client } = input
    if (!client.passwordHash) return { ok: false, error: WRONG_PASSWORD }
    const { ok } = await deps.verifyPassword(input.current, client.passwordHash)
    if (!ok) return { ok: false, error: WRONG_PASSWORD }

    const now = deps.now()
    await deps.setPassword(client.id, await deps.hashPassword(input.next), now)
    // Everywhere else signs out, and the session doing the changing stays, so nobody signs themselves out
    await deps.deleteSessionsFor(client.id, input.sessionId)

    deps.sendLater(async () => {
        try {
            await deps.sendChanged(client)
        } catch (error) {
            deps.log(`Sending the password-changed notice for ${client.id} failed`, error)
        }
    })

    return { ok: true }
}

export type RegenerateDeps = {
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    newRecoveryCode(): string
    hashRecoveryCode(code: string): string
    replaceRecoveryCodes(clientId: string, codeHashes: string[]): Promise<void>
}

export async function regenerateRecoveryCodes(
    input: { client: ClientRecord, password: string },
    deps: RegenerateDeps,
): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }> {
    const { client } = input
    if (!client.passwordHash) return { ok: false, error: WRONG_PASSWORD }
    const { ok } = await deps.verifyPassword(input.password, client.passwordHash)
    if (!ok) return { ok: false, error: WRONG_PASSWORD }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => deps.newRecoveryCode())
    // Replacing invalidates the old set, which is the whole point of offering it
    await deps.replaceRecoveryCodes(client.id, recoveryCodes.map(code => deps.hashRecoveryCode(code)))
    return { ok: true, recoveryCodes }
}

// Enough for a client to recognise their own sessions. Deliberately not a parsed user agent library and
// deliberately never the raw string, which is noise to everyone who is not a developer.
export function describeDevice(userAgent: string | null): string {
    if (!userAgent) return 'Unknown device'
    const browser = /Edg\//.test(userAgent) ? 'Edge'
        : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari'
        : null
    const platform = /iPhone/.test(userAgent) ? 'iPhone'
        : /iPad/.test(userAgent) ? 'iPad'
        : /Android/.test(userAgent) ? 'Android'
        : /Windows/.test(userAgent) ? 'Windows'
        : /Macintosh|Mac OS X/.test(userAgent) ? 'macOS'
        : /Linux/.test(userAgent) ? 'Linux'
        : null
    if (!browser || !platform) return 'Unknown device'
    return `${browser} on ${platform}`
}
