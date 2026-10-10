// The Logs page's reads. Newest first, a page at a time, and one row past the page so the page knows whether
// there is another without counting the whole table.

import 'server-only'

import type { PrismaClient } from '../generated/prisma/client'
import type { Category } from './kinds'

export const PAGE_SIZE = 50

// The actor filter's value for everyone not signed in, who have no id to filter by. No email or client id
// can be this.
export const VISITORS = 'visitors'

export type ActivityFilter = { category: Category | null, actor: string | null, site: string | null, page: number }

export type ActorOption = { value: string, label: string }

export function auditRepo(db: PrismaClient) {
    return {
        events: async ({ category, actor, site, page }: ActivityFilter) => {
            const rows = await db.auditEvent.findMany({
                where: {
                    ...(category ? { kind: { startsWith: `${category}.` } } : {}),
                    ...(actor === VISITORS ? { actorType: 'VISITOR' as const } : actor ? { actorId: actor } : {}),
                    ...(site ? { site } : {}),
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * PAGE_SIZE,
                take: PAGE_SIZE + 1,
            })
            return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE }
        },

        // Everyone who has done anything, by their latest name, for the actor filter
        actors: async (): Promise<ActorOption[]> => {
            const groups = await db.auditEvent.groupBy({
                by: ['actorType', 'actorId', 'actorName'],
                where: { actorType: { not: 'VISITOR' } },
                _max: { createdAt: true },
            })
            const latest = new Map<string, { label: string, at: number }>()
            for (const group of groups) {
                if (!group.actorId) continue
                const at = group._max.createdAt?.getTime() ?? 0
                const seen = latest.get(group.actorId)
                if (seen && seen.at >= at) continue
                const who = group.actorName && group.actorName !== group.actorId ? `${group.actorName} · ${group.actorId}` : group.actorId
                latest.set(group.actorId, { label: group.actorType === 'ADMIN' ? `${who} (operator)` : who, at })
            }
            return [...latest.entries()]
                .map(([value, { label }]) => ({ value, label }))
                .sort((a, b) => a.label.localeCompare(b.label))
        },

        sites: async (): Promise<string[]> => {
            const groups = await db.auditEvent.groupBy({ by: ['site'], where: { site: { not: null } } })
            return groups.map(group => group.site).filter((site): site is string => !!site).sort()
        },

        emails: async (page: number) => {
            const rows = await db.sentEmail.findMany({
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * PAGE_SIZE,
                take: PAGE_SIZE + 1,
                select: { id: true, createdAt: true, to: true, subject: true, error: true },
            })
            return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE }
        },

        email: (id: string) => db.sentEmail.findUnique({ where: { id } }),
    }
}
