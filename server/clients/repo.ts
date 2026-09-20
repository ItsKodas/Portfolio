// Every query the client accounts feature makes, in one place, taking the client as a parameter so the tests
// can point it at the test database. Same shape as server/quotes/repo.ts.

import 'server-only'

import type { ClientSession, ClientTokenPurpose, PrismaClient, Site } from '../generated/prisma/client'
import type { LockUpdate } from './limits'
import type { ClientDetails, SiteInput } from './schema'

// How long a used TOTP step stays recorded. Well past the accepted window, and short enough that the table
// never grows.
const TOTP_USE_TTL_MS = 5 * 60 * 1000
const ATTEMPT_TTL_MS = 60 * 60 * 1000

const listColumns = {
    id: true, name: true, company: true, email: true, createdAt: true, lastSignInAt: true,
    passwordHash: true, totpConfirmedAt: true, suspendedAt: true, lockedUntil: true,
    _count: { select: { sites: true } },
} as const

export function clientRepo(db: PrismaClient) {
    const repo = {
        // One transaction: a client who exists with no way to accept the invite is worse than no client at all
        createWithInvite: (details: ClientDetails, id: string, token: { tokenHash: string, expiresAt: Date }) =>
            db.client.create({
                data: {
                    id, ...details,
                    tokens: { create: { purpose: 'INVITE', tokenHash: token.tokenHash, expiresAt: token.expiresAt } },
                },
            }),

        byId: (id: string) => db.client.findUnique({ where: { id } }),

        // The schema lower-cases every address on the way in, so a plain equality match is enough
        byEmail: (email: string) => db.client.findUnique({ where: { email } }),

        list: () => db.client.findMany({ orderBy: { createdAt: 'desc' }, select: listColumns }),

        updateDetails: async (id: string, details: ClientDetails) => {
            await db.client.update({ where: { id }, data: details })
        },

        remove: async (id: string) => {
            await db.client.delete({ where: { id } })
        },

        setPassword: async (id: string, passwordHash: string, now: Date) => {
            await db.client.update({ where: { id }, data: { passwordHash, passwordUpdatedAt: now } })
        },

        // Stored before the client has proved they can read it, so a page reload doesn't strand a half-scanned
        // QR code. Not usable for sign-in until confirmTotp sets totpConfirmedAt.
        setTotpPending: async (id: string, totpSecret: string) => {
            await db.client.update({ where: { id }, data: { totpSecret, totpConfirmedAt: null } })
        },

        confirmTotp: async (id: string, now: Date) => {
            await db.client.update({ where: { id }, data: { totpConfirmedAt: now } })
        },

        // Everything the old authenticator could reach goes with it, including open sessions
        clearTotp: async (id: string) => {
            await db.$transaction([
                db.client.update({ where: { id }, data: { totpSecret: null, totpConfirmedAt: null } }),
                db.clientRecoveryCode.deleteMany({ where: { clientId: id } }),
                db.clientSession.deleteMany({ where: { clientId: id } }),
            ])
        },

        setSuspended: async (id: string, suspendedAt: Date | null) => {
            await db.$transaction([
                db.client.update({ where: { id }, data: { suspendedAt } }),
                // Suspending must take effect on the next request, not at the next token expiry
                ...(suspendedAt ? [db.clientSession.deleteMany({ where: { clientId: id } })] : []),
            ])
        },

        recordFailure: async (id: string, update: LockUpdate) => {
            await db.client.update({ where: { id }, data: update })
        },

        recordSuccess: async (id: string, now: Date) => {
            await db.client.update({ where: { id }, data: { failedSignIns: 0, lockedUntil: null, lastSignInAt: now } })
        },

        clearLock: async (id: string) => {
            await db.client.update({ where: { id }, data: { failedSignIns: 0, lockedUntil: null } })
        },

        createToken: async (clientId: string, purpose: ClientTokenPurpose, tokenHash: string, expiresAt: Date) => {
            await db.clientToken.create({ data: { clientId, purpose, tokenHash, expiresAt } })
        },

        tokenByHash: (tokenHash: string) => db.clientToken.findUnique({ where: { tokenHash }, include: { client: true } }),

        useToken: async (id: string, now: Date) => {
            await db.clientToken.update({ where: { id }, data: { usedAt: now } })
        },

        // Marked used rather than deleted, so an old link reads as "no longer valid" rather than "never existed"
        invalidateTokens: async (clientId: string, purpose: ClientTokenPurpose, now: Date) => {
            await db.clientToken.updateMany({ where: { clientId, purpose, usedAt: null }, data: { usedAt: now } })
        },

        createSession: (clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null) =>
            db.clientSession.create({ data: { clientId, tokenHash, expiresAt, userAgent }, select: { id: true } }),

        sessionByHash: (tokenHash: string) => db.clientSession.findUnique({ where: { tokenHash }, include: { client: true } }),

        completeMfa: async (sessionId: string, mfaAt: Date, expiresAt: Date) => {
            await db.clientSession.update({ where: { id: sessionId }, data: { mfaAt, expiresAt, lastUsedAt: mfaAt } })
        },

        touchSession: async (sessionId: string, lastUsedAt: Date, expiresAt: Date) => {
            await db.clientSession.update({ where: { id: sessionId }, data: { lastUsedAt, expiresAt } })
        },

        listSessions: (clientId: string) => db.clientSession.findMany({ where: { clientId }, orderBy: { lastUsedAt: 'desc' } }),

        deleteSession: async (id: string) => {
            await db.clientSession.deleteMany({ where: { id } })
        },

        deleteSessionsFor: async (clientId: string, exceptId?: string) => {
            await db.clientSession.deleteMany({ where: { clientId, ...(exceptId && { id: { not: exceptId } }) } })
        },

        // Regenerating invalidates the old set, which is the whole point of offering it
        replaceRecoveryCodes: async (clientId: string, codeHashes: string[]) => {
            await db.$transaction([
                db.clientRecoveryCode.deleteMany({ where: { clientId } }),
                db.clientRecoveryCode.createMany({ data: codeHashes.map(codeHash => ({ clientId, codeHash })) }),
            ])
        },

        unusedRecoveryCodes: (clientId: string) =>
            db.clientRecoveryCode.findMany({ where: { clientId, usedAt: null }, select: { id: true, codeHash: true } }),

        useRecoveryCode: async (id: string, now: Date) => {
            await db.clientRecoveryCode.update({ where: { id }, data: { usedAt: now } })
        },

        countUnusedRecoveryCodes: (clientId: string) => db.clientRecoveryCode.count({ where: { clientId, usedAt: null } }),

        // The unique key is what refuses the replay, so there is no window between checking and recording
        recordTotpUse: async (clientId: string, step: bigint): Promise<boolean> => {
            try {
                await db.clientTotpUse.create({ data: { clientId, step } })
                return true
            } catch {
                return false
            }
        },

        countAttempts: (ipHash: string, since: Date) =>
            db.clientAuthAttempt.count({ where: { ipHash, createdAt: { gte: since } } }),

        recordAttempt: async (ipHash: string) => {
            await db.clientAuthAttempt.create({ data: { ipHash } })
        },

        // Lazily, on a successful sign-in, which is the only moment any of these three grows
        prune: async (clientId: string, now: Date) => {
            await db.$transaction([
                db.clientSession.deleteMany({ where: { clientId, expiresAt: { lt: now } } }),
                db.clientTotpUse.deleteMany({ where: { clientId, usedAt: { lt: new Date(now.getTime() - TOTP_USE_TTL_MS) } } }),
                db.clientAuthAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ATTEMPT_TTL_MS) } } }),
            ])
        },

        listSites: (clientId: string) => db.site.findMany({ where: { clientId }, orderBy: { name: 'asc' } }),

        createSite: async (clientId: string, input: SiteInput) => {
            await db.site.create({ data: { clientId, ...input } })
        },

        // Scoped to the client, so a site can only be removed from the page it is shown on
        removeSite: async (clientId: string, siteId: string) => {
            await db.site.deleteMany({ where: { id: siteId, clientId } })
        },

        linkQuote: async (quoteId: string, clientId: string) => {
            await db.quote.update({ where: { id: quoteId }, data: { clientId } })
        },
    }
    return repo
}

export type ClientRepo = ReturnType<typeof clientRepo>
export type ClientRecord = NonNullable<Awaited<ReturnType<ClientRepo['byId']>>>
export type ClientListRow = Awaited<ReturnType<ClientRepo['list']>>[number]
export type SessionWithClient = NonNullable<Awaited<ReturnType<ClientRepo['sessionByHash']>>>
export type { ClientSession, Site }
