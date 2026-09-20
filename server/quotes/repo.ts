// Every query the quotes feature makes, in one place, taking the client as a parameter so the tests can point it at
// the test database

import 'server-only'

import type { PrismaClient } from '../generated/prisma/client'
import type { Status } from './labels'
import type { QuoteInput } from './schema'

export type InboxFilter = { status?: Status, archived: boolean }

const inboxColumns = {
    id: true, createdAt: true, name: true, company: true, projectType: true, budget: true, status: true,
    notifiedAt: true, confirmedAt: true,
} as const

export function quoteRepo(db: PrismaClient) {
    return {
        create: (input: QuoteInput, ipHash: string) =>
            db.quote.create({ data: { ...input, ipHash }, select: { id: true } }),

        countRecent: (ipHash: string, since: Date) =>
            db.quote.count({ where: { ipHash, createdAt: { gte: since } } }),

        list: (filter: InboxFilter) => db.quote.findMany({
            where: { archivedAt: filter.archived ? { not: null } : null, ...(filter.status && { status: filter.status }) },
            orderBy: { createdAt: 'desc' },
            select: inboxColumns,
        }),

        countNew: () => db.quote.count({ where: { status: 'NEW', archivedAt: null } }),

        get: (id: string) => db.quote.findUnique({
            where: { id },
            include: { notes: { orderBy: { createdAt: 'desc' } }, client: { select: { id: true, name: true, company: true } } },
        }),

        setStatus: async (id: string, status: Status) => {
            await db.quote.update({ where: { id }, data: { status } })
        },

        setArchived: async (id: string, archived: boolean, now: Date) => {
            await db.quote.update({ where: { id }, data: { archivedAt: archived ? now : null } })
        },

        remove: async (id: string) => {
            await db.quote.delete({ where: { id } })
        },

        addNote: async (quoteId: string, body: string) => {
            await db.note.create({ data: { quoteId, body } })
        },

        // Scoped to the quote, so a note can only be deleted from the page it is shown on
        removeNote: async (quoteId: string, noteId: string) => {
            await db.note.deleteMany({ where: { id: noteId, quoteId } })
        },

        markNotified: async (id: string, at: Date) => {
            await db.quote.update({ where: { id }, data: { notifiedAt: at } })
        },

        markConfirmed: async (id: string, at: Date) => {
            await db.quote.update({ where: { id }, data: { confirmedAt: at } })
        },

        // Quotes a client came from, for their page in the admin area. Newest first, like the inbox.
        listForClient: (clientId: string) => db.quote.findMany({
            where: { clientId },
            select: { id: true, name: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
        }),
    }
}

export type QuoteRepo = ReturnType<typeof quoteRepo>
export type InboxRow = Awaited<ReturnType<QuoteRepo['list']>>[number]
