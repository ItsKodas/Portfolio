'use server'

// Everything the admin area changes. Each action checks the session itself first, validates what it was sent, and
// reports failure as a message rather than throwing, so the page can show it.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { adminActor, record, type Actor } from '@/server/audit/record'
import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { EnvError } from '@/server/env'
import type { Kind } from '@/server/audit/kinds'
import { STATUS_LABELS, STATUSES } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { deliverById, log } from '@/server/quotes/wiring'

export type ActionResult = { ok: true } | { ok: false, error: string }

const id = z.string().min(1).max(64)
// Not typed as ActionResult: that union would stop `.error` being read back off INVALID below without a
// redundant `ok` check, since TS can't narrow a plain union-typed variable by its literal value.
const INVALID = { ok: false, error: 'That request was not valid.' } as const
const FAILED: ActionResult = { ok: false, error: 'That did not work. The quote may have been deleted, so try reloading.' }

function refresh(quoteId: string) {
    revalidatePath('/admin')
    revalidatePath(`/admin/quotes/${quoteId}`)
}

async function change(quoteId: string, work: () => Promise<void>, recorded: () => Promise<void>): Promise<ActionResult> {
    try {
        await work()
    } catch (error) {
        log(`Admin change to quote ${quoteId} failed`, error)
        return FAILED
    }
    await recorded()
    refresh(quoteId)
    return { ok: true }
}

export async function setStatusAction(quoteId: string, status: string): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = z.object({ quoteId: id, status: z.enum(STATUSES) }).safeParse({ quoteId, status })
    if (!parsed.success) return INVALID
    return change(
        quoteId,
        () => quoteRepo(getDb()).setStatus(parsed.data.quoteId, parsed.data.status),
        () => about(actor, quoteId, 'quote.status', name => `Marked ${name}'s quote ${STATUS_LABELS[parsed.data.status].toLowerCase()}`),
    )
}

export async function setArchivedAction(quoteId: string, archived: boolean): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(quoteId).success || typeof archived !== 'boolean') return INVALID
    return change(
        quoteId,
        () => quoteRepo(getDb()).setArchived(quoteId, archived, new Date()),
        () => about(actor, quoteId, archived ? 'quote.archive' : 'quote.unarchive', name => `${archived ? 'Archived' : 'Unarchived'} ${name}'s quote`),
    )
}

export async function addNoteAction(quoteId: string, body: string): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = z.object({
        quoteId: id,
        body: z.string().trim().min(1, 'Write something first').max(5000, 'Keep notes under 5,000 characters'),
    }).safeParse({ quoteId, body })
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    return change(
        quoteId,
        () => quoteRepo(getDb()).addNote(parsed.data.quoteId, parsed.data.body),
        () => about(actor, quoteId, 'quote.note', name => `Added a note to ${name}'s quote`, { note: parsed.data.body }),
    )
}

export async function deleteNoteAction(quoteId: string, noteId: string): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(quoteId).success || !id.safeParse(noteId).success) return INVALID
    return change(
        quoteId,
        () => quoteRepo(getDb()).removeNote(quoteId, noteId),
        () => about(actor, quoteId, 'quote.noteDelete', name => `Deleted a note on ${name}'s quote`),
    )
}

export async function deleteQuoteAction(quoteId: string): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(quoteId).success) return INVALID
    // Read first, because afterwards there is no name left to say whose quote it was
    const before = await quoteRepo(getDb()).get(quoteId).catch(() => null)
    try {
        await quoteRepo(getDb()).remove(quoteId)
    } catch (error) {
        log(`Deleting quote ${quoteId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'quote.delete', actor,
        target: { type: 'quote', id: quoteId, name: before?.name ?? null },
        summary: `Deleted ${before ? `${before.name}'s` : 'a'} quote`,
    })
    revalidatePath('/admin')
    // Outside the try: redirect() works by throwing
    redirect('/admin')
}

export async function resendEmailsAction(quoteId: string): Promise<ActionResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(quoteId).success) return INVALID
    try {
        const result = await deliverById(quoteId)
        await about(actor, quoteId, 'quote.resend', name => `Sent the emails for ${name}'s quote again`, { ...result })
        refresh(quoteId)
        if (result.notified && result.confirmed) return { ok: true }
        return { ok: false, error: 'An email still did not send. The server log has the reason.' }
    } catch (error) {
        // Names the missing settings, never their values
        if (error instanceof EnvError) return { ok: false, error: error.message }
        log(`Resending quote ${quoteId}'s emails failed`, error)
        return { ok: false, error: 'Sending failed. The server log has the reason.' }
    }
}

// What the activity log says about a quote, by the name of whoever sent it
async function about(actor: Actor, quoteId: string, kind: Kind, say: (name: string) => string, detail?: Record<string, unknown>) {
    const quote = await quoteRepo(getDb()).get(quoteId).catch(() => null)
    await record({
        kind, actor, detail,
        target: { type: 'quote', id: quoteId, name: quote?.name ?? null },
        summary: say(quote?.name ?? 'someone'),
    })
}
