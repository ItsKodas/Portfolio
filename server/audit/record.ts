// Writes the activity log and the sent-mail log. Neither may ever stop the thing it is recording: a failure
// here is logged to the console and swallowed, because a deploy that did not start because its log line
// could not be written would be worse than a missing line.

import 'server-only'

import type { Session } from 'next-auth'

import { getDb } from '../db'
import type { Prisma } from '../generated/prisma/client'
import type { Caller } from '../hostd/actor'
import type { Email } from '../emails/layout'
import { withoutTokens } from './emails'
import type { Kind } from './kinds'

export type Actor =
    | { type: 'ADMIN', id: string, name?: string | null }
    | { type: 'CLIENT', id: string, name?: string | null }
    | { type: 'VISITOR', id?: null, name?: string | null }

export type AuditEntry = {
    kind: Kind
    actor: Actor
    summary: string
    // The hostd project id
    site?: string | null
    target?: { type: string, id: string, name?: string | null }
    // Never a secret. It is shown to the operator as it is stored.
    detail?: Record<string, unknown>
}

export const VISITOR: Actor = { type: 'VISITOR' }

export const adminActor = (session: Session): Actor => ({
    type: 'ADMIN',
    id: session.user?.email ?? 'admin',
    name: session.user?.name ?? null,
})

export const clientActor = (client: { id: string, name: string, company?: string | null }): Actor => ({
    type: 'CLIENT',
    id: client.id,
    name: client.company ? `${client.name} (${client.company})` : client.name,
})

// A hostd caller says who it is in the same terms: the operator by email, a client by id. The operator viewing
// as a client carries the client's actor but their own email as the user, and is recorded as themselves.
export function callerActor(caller: Caller): Actor {
    if (caller.actor === 'admin') return { type: 'ADMIN', id: caller.user }
    const client = caller.actor?.startsWith('client:') ? caller.actor.slice('client:'.length) : null
    if (client && caller.user !== client) return { type: 'ADMIN', id: caller.user, name: `${caller.user}, viewing as ${client}` }
    return { type: 'CLIENT', id: caller.user }
}

const log = (message: string, error: unknown) => console.error(`[audit] ${message}`, error)

export async function record(entry: AuditEntry): Promise<void> {
    try {
        const db = getDb()
        let name = entry.actor.name ?? null
        // A client named only by id is looked up, so the page reads a name even after they are deleted
        if (!name && entry.actor.type === 'CLIENT') {
            const client = await db.client.findUnique({ where: { id: entry.actor.id }, select: { name: true, company: true } })
            if (client) name = clientActor({ id: entry.actor.id, ...client }).name ?? null
        }
        await db.auditEvent.create({
            data: {
                kind: entry.kind,
                actorType: entry.actor.type,
                actorId: entry.actor.id ?? null,
                actorName: name,
                site: entry.site ?? null,
                targetType: entry.target?.type ?? null,
                targetId: entry.target?.id ?? null,
                targetName: entry.target?.name ?? null,
                summary: entry.summary,
                detail: entry.detail as Prisma.InputJsonValue | undefined,
            },
        })
    } catch (error) {
        log(`could not record ${entry.kind}`, error)
    }
}

export async function recordEmail(email: Email, error: unknown): Promise<void> {
    try {
        await getDb().sentEmail.create({
            data: {
                from: email.from,
                to: email.to,
                replyTo: email.replyTo,
                subject: email.subject,
                text: withoutTokens(email.text),
                html: withoutTokens(email.html),
                error: error === null ? null : String(error instanceof Error ? error.message : error).slice(0, 2000),
            },
        })
    } catch (failure) {
        log(`could not record the email to ${email.to}`, failure)
    }
}
