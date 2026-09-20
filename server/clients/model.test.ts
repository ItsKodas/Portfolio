// Runs against a real Postgres: the horizons_test database from docker-compose.dev.yml, named by TEST_DATABASE_URL.
// Skipped when that isn't set, so npm test still works without Docker.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'

const url = process.env.TEST_DATABASE_URL

const TABLES = '"Client", "Site", "ClientSession", "ClientToken", "ClientRecoveryCode", "ClientTotpUse", "ClientAuthAttempt", "Quote", "Note"'

describe.skipIf(!url)('client models', () => {
    let db: PrismaClient

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    const client = (id = 'cl_ABCDEFGH') =>
        db.client.create({ data: { id, name: 'Ann', email: `${id}@example.com` } })

    it('creates a client with nothing set up yet', async () => {
        const created = await client()
        expect(created.passwordHash).toBeNull()
        expect(created.totpSecret).toBeNull()
        expect(created.totpConfirmedAt).toBeNull()
        expect(created.suspendedAt).toBeNull()
        expect(created.failedSignIns).toBe(0)
    })

    it('refuses two clients with the same email', async () => {
        await client('cl_AAAAAAAA')
        await expect(db.client.create({ data: { id: 'cl_BBBBBBBB', name: 'Bo', email: 'cl_AAAAAAAA@example.com' } }))
            .rejects.toThrow()
    })

    it('refuses a replayed TOTP step for the same client', async () => {
        await client()
        await db.clientTotpUse.create({ data: { clientId: 'cl_ABCDEFGH', step: 58000000n } })
        await expect(db.clientTotpUse.create({ data: { clientId: 'cl_ABCDEFGH', step: 58000000n } }))
            .rejects.toThrow()
    })

    it('allows the same step for a different client', async () => {
        await client('cl_AAAAAAAA')
        await client('cl_BBBBBBBB')
        await db.clientTotpUse.create({ data: { clientId: 'cl_AAAAAAAA', step: 58000000n } })
        await db.clientTotpUse.create({ data: { clientId: 'cl_BBBBBBBB', step: 58000000n } })
        expect(await db.clientTotpUse.count()).toBe(2)
    })

    it('cascades sessions, tokens, codes and sites when a client is deleted', async () => {
        await client()
        await db.clientSession.create({ data: { clientId: 'cl_ABCDEFGH', tokenHash: 't1', expiresAt: new Date() } })
        await db.clientToken.create({ data: { clientId: 'cl_ABCDEFGH', tokenHash: 'k1', purpose: 'INVITE', expiresAt: new Date() } })
        await db.clientRecoveryCode.create({ data: { clientId: 'cl_ABCDEFGH', codeHash: 'c1' } })
        await db.site.create({ data: { clientId: 'cl_ABCDEFGH', projectId: 'acme-bakery', name: 'Acme Bakery' } })

        await db.client.delete({ where: { id: 'cl_ABCDEFGH' } })

        expect(await db.clientSession.count()).toBe(0)
        expect(await db.clientToken.count()).toBe(0)
        expect(await db.clientRecoveryCode.count()).toBe(0)
        expect(await db.site.count()).toBe(0)
    })

    // Deleting a client must never delete the quote they came from, so the history survives
    it('keeps a quote and nulls its clientId when the client is deleted', async () => {
        await client()
        const quote = await db.quote.create({
            data: { name: 'Ann', email: 'ann@example.com', message: 'Hello there', ipHash: 'h1', clientId: 'cl_ABCDEFGH' },
        })

        await db.client.delete({ where: { id: 'cl_ABCDEFGH' } })

        const after = await db.quote.findUnique({ where: { id: quote.id } })
        expect(after).not.toBeNull()
        expect(after!.clientId).toBeNull()
    })
})
