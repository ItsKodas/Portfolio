// Runs against a real Postgres: the horizons_test database from docker-compose.dev.yml, named by TEST_DATABASE_URL.
// Skipped when that isn't set, so npm test still works without Docker.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'
import type { Status } from './labels'
import { quoteRepo, type QuoteRepo } from './repo'
import type { QuoteInput } from './schema'

const url = process.env.TEST_DATABASE_URL

const input: QuoteInput = {
    name: 'Ann', email: 'ann@example.com', message: 'A new website please', company: null, website: null,
    projectType: 'WEB_APP', budget: null, timeline: null, referenceSites: ['https://one.example.com'],
}

describe.skipIf(!url)('quoteRepo', () => {
    let db: PrismaClient
    let repo: QuoteRepo

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
        repo = quoteRepo(db)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE "Quote", "Note" CASCADE')
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    // Inserts a quote with a chosen creation time, which create() doesn't allow
    const at = (iso: string, extra: { ipHash?: string, status?: Status, archivedAt?: Date } = {}) =>
        db.quote.create({ data: { ...input, ipHash: 'h1', createdAt: new Date(iso), ...extra } })

    it('creates a quote with the defaults', async () => {
        const { id } = await repo.create(input, 'h1')
        const quote = await repo.get(id)
        expect(quote).toMatchObject({ ...input, ipHash: 'h1', status: 'NEW', archivedAt: null, notifiedAt: null, confirmedAt: null, notes: [] })
    })

    it('counts recent quotes from one IP hash only, within the window', async () => {
        await at('2026-09-20T00:30:00Z')
        await at('2026-09-20T00:59:00Z')
        await at('2026-09-19T23:00:00Z')
        await at('2026-09-20T00:45:00Z', { ipHash: 'h2' })
        expect(await repo.countRecent('h1', new Date('2026-09-20T00:00:00Z'))).toBe(2)
    })

    it('lists the inbox newest first, keeping archived quotes to their own view', async () => {
        const older = await at('2026-09-20T00:00:00Z')
        const newer = await at('2026-09-20T01:00:00Z')
        const archived = await at('2026-09-20T02:00:00Z', { archivedAt: new Date() })
        expect((await repo.list({ archived: false })).map(q => q.id)).toEqual([newer.id, older.id])
        expect((await repo.list({ archived: true })).map(q => q.id)).toEqual([archived.id])
    })

    it('filters the inbox by status, and counts new quotes that are not archived', async () => {
        const won = await at('2026-09-20T00:00:00Z', { status: 'WON' })
        await at('2026-09-20T01:00:00Z')
        await at('2026-09-20T02:00:00Z', { archivedAt: new Date() })
        expect((await repo.list({ status: 'WON', archived: false })).map(q => q.id)).toEqual([won.id])
        expect(await repo.countNew()).toBe(1)
    })

    it('changes status, archives and unarchives', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.setStatus(id, 'REPLIED')
        await repo.setArchived(id, true, new Date('2026-09-20T03:00:00Z'))
        expect(await repo.get(id)).toMatchObject({ status: 'REPLIED', archivedAt: new Date('2026-09-20T03:00:00Z') })
        await repo.setArchived(id, false, new Date())
        expect((await repo.get(id))?.archivedAt).toBeNull()
    })

    it('keeps notes newest first, and deletes a note only from its own quote', async () => {
        const { id } = await repo.create(input, 'h1')
        const other = await repo.create(input, 'h1')
        await repo.addNote(id, 'first')
        await new Promise(resolve => setTimeout(resolve, 5))
        await repo.addNote(id, 'second')
        const notes = (await repo.get(id))!.notes
        expect(notes.map(note => note.body)).toEqual(['second', 'first'])

        await repo.removeNote(other.id, notes[0].id)
        expect((await repo.get(id))!.notes).toHaveLength(2)
        await repo.removeNote(id, notes[0].id)
        expect((await repo.get(id))!.notes.map(note => note.body)).toEqual(['first'])
    })

    it('deletes a quote along with its notes', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.addNote(id, 'a note')
        await repo.remove(id)
        expect(await repo.get(id)).toBeNull()
        expect(await db.note.count()).toBe(0)
    })

    it('records when each email went', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.markNotified(id, new Date('2026-09-20T00:00:01Z'))
        expect(await repo.get(id)).toMatchObject({ notifiedAt: new Date('2026-09-20T00:00:01Z'), confirmedAt: null })
        await repo.markConfirmed(id, new Date('2026-09-20T00:00:02Z'))
        expect((await repo.get(id))?.confirmedAt).toEqual(new Date('2026-09-20T00:00:02Z'))
    })
})
