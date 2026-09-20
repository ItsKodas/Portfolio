// Runs against a real Postgres, the horizons_test database named by TEST_DATABASE_URL. Skipped without it.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'
import { clientRepo, type ClientRepo } from './repo'

const url = process.env.TEST_DATABASE_URL
const TABLES = '"Client", "Site", "ClientSession", "ClientToken", "ClientRecoveryCode", "ClientTotpUse", "ClientAuthAttempt", "Quote", "Note"'

const details = { name: 'Ann Example', company: 'Acme', email: 'ann@example.com' }
const hour = (count: number) => new Date(Date.now() + count * 60 * 60 * 1000)

describe.skipIf(!url)('clientRepo', () => {
    let db: PrismaClient
    let repo: ClientRepo

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
        repo = clientRepo(db)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    const invited = () => repo.createWithInvite(details, 'cl_ABCDEFGH', { tokenHash: 'invite1', expiresAt: hour(1) })

    it('creates the client and its invite in one go', async () => {
        const client = await invited()
        expect(client.id).toBe('cl_ABCDEFGH')
        expect(await db.clientToken.count({ where: { clientId: client.id, purpose: 'INVITE' } })).toBe(1)
    })

    // One transaction: a client with no way to accept the invite is worse than no client at all
    it('writes neither the client nor the token when the email is taken', async () => {
        await invited()
        await expect(repo.createWithInvite(details, 'cl_BBBBBBBB', { tokenHash: 'invite2', expiresAt: hour(1) })).rejects.toThrow()
        expect(await db.client.count()).toBe(1)
        expect(await db.clientToken.count()).toBe(1)
    })

    // The duplicate-email case above cannot prove this: the Client unique constraint fails on the first
    // write, so the token insert is never attempted either way. Colliding on the tokenHash instead lets
    // the client insert succeed and the token insert fail, which is the only shape that tells an atomic
    // write apart from two separate ones.
    it('rolls the client back when its invite token cannot be written', async () => {
        await invited()
        await expect(repo.createWithInvite(
            { ...details, email: 'bo@example.com' },
            'cl_BBBBBBBB',
            { tokenHash: 'invite1', expiresAt: hour(1) },
        )).rejects.toThrow()
        expect(await db.client.findUnique({ where: { id: 'cl_BBBBBBBB' } })).toBeNull()
        expect(await db.client.count()).toBe(1)
    })

    it('finds a client by a lower-cased email', async () => {
        await invited()
        expect((await repo.byEmail('ann@example.com'))?.id).toBe('cl_ABCDEFGH')
        expect(await repo.byEmail('nobody@example.com')).toBeNull()
    })

    it('reads a token back with its client attached', async () => {
        await invited()
        const found = await repo.tokenByHash('invite1')
        expect(found?.client.email).toBe('ann@example.com')
        expect(found?.usedAt).toBeNull()
    })

    it('invalidates earlier tokens of the same purpose', async () => {
        const client = await invited()
        await repo.invalidateTokens(client.id, 'INVITE', new Date())
        expect((await repo.tokenByHash('invite1'))?.usedAt).not.toBeNull()
    })

    it('refuses a replayed TOTP step and accepts a new one', async () => {
        const client = await invited()
        expect(await repo.recordTotpUse(client.id, 100n)).toBe(true)
        expect(await repo.recordTotpUse(client.id, 100n)).toBe(false)
        expect(await repo.recordTotpUse(client.id, 101n)).toBe(true)
    })

    it('keeps every session but the one named when signing out elsewhere', async () => {
        const client = await invited()
        const keep = await repo.createSession(client.id, 'keep', hour(1), 'Firefox')
        await repo.createSession(client.id, 'drop', hour(1), 'Chrome')
        await repo.deleteSessionsFor(client.id, keep.id)
        expect((await repo.listSessions(client.id)).map(session => session.id)).toEqual([keep.id])
    })

    it('replaces the whole set of recovery codes', async () => {
        const client = await invited()
        await repo.replaceRecoveryCodes(client.id, ['a', 'b'])
        await repo.replaceRecoveryCodes(client.id, ['c'])
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(1)
    })

    it('stops counting a recovery code once it is used', async () => {
        const client = await invited()
        await repo.replaceRecoveryCodes(client.id, ['a', 'b'])
        const [first] = await repo.unusedRecoveryCodes(client.id)
        await repo.useRecoveryCode(first.id, new Date())
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(1)
    })

    it('clears the authenticator, its codes and every session together', async () => {
        const client = await invited()
        await repo.setTotpPending(client.id, 'v1$a$b$c')
        await repo.confirmTotp(client.id, new Date())
        await repo.replaceRecoveryCodes(client.id, ['a'])
        await repo.createSession(client.id, 'session', hour(1), null)

        await repo.clearTotp(client.id)

        const after = await repo.byId(client.id)
        expect(after?.totpSecret).toBeNull()
        expect(after?.totpConfirmedAt).toBeNull()
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(0)
        expect(await repo.listSessions(client.id)).toEqual([])
    })

    it('prunes expired sessions, old codes and old attempts', async () => {
        const client = await invited()
        await repo.createSession(client.id, 'stale', hour(-1), null)
        await repo.createSession(client.id, 'live', hour(1), null)
        await repo.recordTotpUse(client.id, 1n)
        await repo.recordAttempt('ip1')

        await db.$executeRawUnsafe(`UPDATE "ClientTotpUse" SET "usedAt" = now() - interval '1 day'`)
        await db.$executeRawUnsafe(`UPDATE "ClientAuthAttempt" SET "createdAt" = now() - interval '1 day'`)
        await repo.prune(client.id, new Date())

        expect((await repo.listSessions(client.id)).map(session => session.tokenHash)).toEqual(['live'])
        expect(await db.clientTotpUse.count()).toBe(0)
        expect(await db.clientAuthAttempt.count()).toBe(0)
    })

    it('counts only recent attempts from the same IP', async () => {
        await repo.recordAttempt('ip1')
        await repo.recordAttempt('ip1')
        await repo.recordAttempt('ip2')
        expect(await repo.countAttempts('ip1', new Date(Date.now() - 60_000))).toBe(2)
    })

    it('links a quote to a client', async () => {
        const client = await invited()
        const quote = await db.quote.create({ data: { name: 'Ann', email: 'ann@example.com', message: 'Hello there', ipHash: 'h' } })
        await repo.linkQuote(quote.id, client.id)
        expect((await db.quote.findUnique({ where: { id: quote.id } }))?.clientId).toBe(client.id)
    })

    it('only removes a site that belongs to the client it was asked about', async () => {
        const client = await invited()
        await repo.createSite(client.id, { projectId: 'acme-bakery', name: 'Acme Bakery' })
        const [site] = await repo.listSites(client.id)
        await repo.removeSite('cl_SOMEONEE', site.id)
        expect(await repo.listSites(client.id)).toHaveLength(1)
    })
})
