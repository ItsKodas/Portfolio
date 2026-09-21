'use server'

// Everything the admin area changes. Each action checks the session itself first, validates what it was sent, and
// reports failure as a message rather than throwing, so the page can show it.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { EnvError } from '@/server/env'
import { STATUSES } from '@/server/quotes/labels'
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

async function change(quoteId: string, work: () => Promise<void>): Promise<ActionResult> {
    try {
        await work()
    } catch (error) {
        log(`Admin change to quote ${quoteId} failed`, error)
        return FAILED
    }
    refresh(quoteId)
    return { ok: true }
}

export async function setStatusAction(quoteId: string, status: string): Promise<ActionResult> {
    await requireAdmin()
    const parsed = z.object({ quoteId: id, status: z.enum(STATUSES) }).safeParse({ quoteId, status })
    if (!parsed.success) return INVALID
    return change(quoteId, () => quoteRepo(getDb()).setStatus(parsed.data.quoteId, parsed.data.status))
}

export async function setArchivedAction(quoteId: string, archived: boolean): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success || typeof archived !== 'boolean') return INVALID
    return change(quoteId, () => quoteRepo(getDb()).setArchived(quoteId, archived, new Date()))
}

export async function addNoteAction(quoteId: string, body: string): Promise<ActionResult> {
    await requireAdmin()
    const parsed = z.object({
        quoteId: id,
        body: z.string().trim().min(1, 'Write something first').max(5000, 'Keep notes under 5,000 characters'),
    }).safeParse({ quoteId, body })
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    return change(quoteId, () => quoteRepo(getDb()).addNote(parsed.data.quoteId, parsed.data.body))
}

export async function deleteNoteAction(quoteId: string, noteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success || !id.safeParse(noteId).success) return INVALID
    return change(quoteId, () => quoteRepo(getDb()).removeNote(quoteId, noteId))
}

export async function deleteQuoteAction(quoteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success) return INVALID
    try {
        await quoteRepo(getDb()).remove(quoteId)
    } catch (error) {
        log(`Deleting quote ${quoteId} failed`, error)
        return FAILED
    }
    revalidatePath('/admin')
    // Outside the try: redirect() works by throwing
    redirect('/admin')
}

export async function resendEmailsAction(quoteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success) return INVALID
    try {
        const result = await deliverById(quoteId)
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
