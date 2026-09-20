// Connects the client account modules to the real database, relay, clock and request. The only file that does,
// so everything else can be tested with stand-ins. Same role as server/quotes/wiring.ts.

import 'server-only'

import { headers } from 'next/headers'
import { after } from 'next/server'

import { getDb } from '../db'
import { clientMailConfig, clientSecretKey, ipHashKey } from '../env'
import { createMailer } from '../mailer'
import type { Email } from '../quotes/emails'
import { clientIp, hashIp } from '../ratelimit'
import { changePassword as runChangePassword, regenerateRecoveryCodes as runRegenerate } from './account'
import { CLIENT_ID_PATTERN, newClientId, newRecoveryCode, normaliseRecoveryCode } from './ids'
import { hashPassword, verifyPassword, burnPasswordTime } from './password'
import { clientRepo, type ClientRecord } from './repo'
import { decryptSecret, encryptSecret, hashRecoveryCode, recoveryCodeMatches } from './secrets'
import type { ClientDetails } from './schema'
import { hashSessionToken, newSessionToken } from './session'
import { INVITE_TTL_MS } from './setup'
import { verifyTotp, newTotpSecret } from './totp'
// A top-level import, not a dynamic one: every deps factory below reaches for one of these three emails, so
// deferring the module would not save a page from ever loading it.
import { passwordChangedEmail, resetEmail } from './emails'

export function log(message: string, error?: unknown) {
    console.error(`[clients] ${message}`, error ?? '')
}

export const repo = () => clientRepo(getDb())

// Called at the point of use rather than read once at startup, so a missing key stops only the flows that
// actually need it, the way server/quotes/wiring.ts reads the mail settings
const key = () => clientSecretKey()

export async function requestIpHash(): Promise<string> {
    return hashIp(clientIp(await headers()), ipHashKey())
}

// Truncated: it is only ever shown back to the client so they can recognise their own sessions
export async function requestUserAgent(): Promise<string | null> {
    return (await headers()).get('user-agent')?.slice(0, 200) ?? null
}

export async function sendClientEmail(build: (options: { from: string, replyTo: string, siteUrl: string }) => Email): Promise<void> {
    const config = clientMailConfig()
    await createMailer(config)(build({ from: config.from, replyTo: config.replyTo, siteUrl: config.siteUrl }))
}

const now = () => new Date()
const sendLater = (task: () => Promise<void>) => after(task)

export const passwordStepDeps = (ipHash: string) => {
    const clients = repo()
    return {
        findByEmail: clients.byEmail,
        countAttempts: clients.countAttempts,
        recordAttempt: clients.recordAttempt,
        recordFailure: clients.recordFailure,
        verifyPassword,
        burnTime: () => burnPasswordTime(),
        rehash: (password: string) => hashPassword(password),
        setPassword: clients.setPassword,
        createSession: clients.createSession,
        newToken: () => newSessionToken(),
        hashToken: hashSessionToken,
        now, log, ipHash,
    }
}

export const codeStepDeps = (ipHash: string) => {
    const clients = repo()
    return {
        countAttempts: clients.countAttempts,
        recordAttempt: clients.recordAttempt,
        recordFailure: clients.recordFailure,
        decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
        verifyTotp,
        recordTotpUse: clients.recordTotpUse,
        unusedRecoveryCodes: clients.unusedRecoveryCodes,
        recoveryCodeMatches: (normalised: string, storedHash: string) => recoveryCodeMatches(normalised, storedHash, key()),
        useRecoveryCode: clients.useRecoveryCode,
        completeMfa: clients.completeMfa,
        recordSuccess: clients.recordSuccess,
        prune: clients.prune,
        now, log, ipHash,
    }
}

export const completeInviteDeps = () => {
    const clients = repo()
    return {
        tokenByHash: clients.tokenByHash,
        hashPassword,
        setPassword: clients.setPassword,
        useToken: clients.useToken,
        createSession: clients.createSession,
        newToken: () => newSessionToken(),
        hashToken: hashSessionToken,
        now, log,
    }
}

export const beginEnrolmentDeps = () => {
    const clients = repo()
    return {
        newSecret: () => newTotpSecret(),
        // Stored base64 inside the ciphertext, so the encrypted form is always text
        encryptSecret: (plaintext: string) => encryptSecret(plaintext, key()),
        storeSecret: (id: string, encrypted: string) => clients.setTotpPending(id, encrypted),
        now,
    }
}

export const confirmEnrolmentDeps = () => {
    const clients = repo()
    return {
        decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
        verifyTotp,
        recordTotpUse: clients.recordTotpUse,
        confirmTotp: clients.confirmTotp,
        newRecoveryCode: () => newRecoveryCode(),
        // The same normalisation the verifying side uses, rather than a second one that only happens to agree
        // with it: they sit on the two halves of one comparison, so there must only be one of them.
        hashRecoveryCode: (code: string) => hashRecoveryCode(normaliseRecoveryCode(code), key()),
        replaceRecoveryCodes: clients.replaceRecoveryCodes,
        now, log,
    }
}

export const acknowledgeDeps = () => {
    const clients = repo()
    return { completeMfa: clients.completeMfa, recordSuccess: clients.recordSuccess, now }
}

export const requestResetDeps = (ipHash: string) => {
    const clients = repo()
    return {
        findByEmail: clients.byEmail,
        countAttempts: clients.countAttempts,
        recordAttempt: clients.recordAttempt,
        invalidateTokens: clients.invalidateTokens,
        createToken: clients.createToken,
        newToken: () => newSessionToken(),
        hashToken: hashSessionToken,
        sendLater,
        sendReset: async (client: ClientRecord, token: string) => {
            await sendClientEmail(options => resetEmail(client, token, options))
        },
        now, log, ipHash,
    }
}

export const completeResetDeps = (ipHash: string) => {
    const clients = repo()
    return {
        tokenByHash: clients.tokenByHash,
        countAttempts: clients.countAttempts,
        recordAttempt: clients.recordAttempt,
        recordFailure: clients.recordFailure,
        decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
        verifyTotp,
        recordTotpUse: clients.recordTotpUse,
        unusedRecoveryCodes: clients.unusedRecoveryCodes,
        recoveryCodeMatches: (normalised: string, storedHash: string) => recoveryCodeMatches(normalised, storedHash, key()),
        useRecoveryCode: clients.useRecoveryCode,
        hashPassword,
        setPassword: clients.setPassword,
        useToken: clients.useToken,
        deleteSessionsFor: (clientId: string) => clients.deleteSessionsFor(clientId),
        clearLock: clients.clearLock,
        sendLater,
        sendChanged: async (client: ClientRecord) => {
            await sendClientEmail(options => passwordChangedEmail(client, options))
        },
        now, log, ipHash,
    }
}

export const changePasswordDeps = () => {
    const clients = repo()
    return {
        verifyPassword,
        hashPassword,
        setPassword: clients.setPassword,
        deleteSessionsFor: clients.deleteSessionsFor,
        sendLater,
        sendChanged: async (client: ClientRecord) => {
            await sendClientEmail(options => passwordChangedEmail(client, options))
        },
        now, log,
    }
}

export const regenerateDeps = () => {
    const clients = repo()
    return {
        verifyPassword,
        newRecoveryCode: () => newRecoveryCode(),
        // As in confirmEnrolmentDeps: one normalisation, shared with the side that checks what is typed in
        hashRecoveryCode: (code: string) => hashRecoveryCode(normaliseRecoveryCode(code), key()),
        replaceRecoveryCodes: clients.replaceRecoveryCodes,
    }
}

export { runChangePassword, runRegenerate }

// Retries on the unique key rather than hoping 40 bits never collides
export async function newClientWithInvite(details: ClientDetails): Promise<{ client: ClientRecord, token: string }> {
    const token = newSessionToken()
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = newClientId()
        if (!CLIENT_ID_PATTERN.test(id)) continue
        try {
            const client = await repo().createWithInvite(details, id, { tokenHash: hashSessionToken(token), expiresAt })
            return { client, token }
        } catch (error) {
            // A duplicate email is the caller's problem and must not be retried; only an id clash is
            if (!String(error).includes('Client_pkey')) throw error
        }
    }
    throw new Error('Could not allocate a client id')
}
