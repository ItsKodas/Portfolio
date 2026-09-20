'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin } from '@/server/auth'
import { EnvError } from '@/server/env'
import { emailChangedEmail, inviteEmail, resetEmail, twoFactorResetEmail } from '@/server/clients/emails'
import { clientDetailsSchema, siteSchema } from '@/server/clients/schema'
import { hashSessionToken, newSessionToken } from '@/server/clients/session'
import { INVITE_TTL_MS, RESET_TTL_MS } from '@/server/clients/setup'
import { log, newClientWithInvite, repo, sendClientEmail } from '@/server/clients/wiring'

export type AdminResult = { ok: true } | { ok: false, error: string, clientId?: string }

const id = z.string().min(1).max(64)
const INVALID = { ok: false, error: 'That request was not valid.' } as const
const FAILED: AdminResult = { ok: false, error: 'That did not work. The client may have been deleted, so try reloading.' }

const refresh = (clientId?: string) => {
    revalidatePath('/admin/clients')
    if (clientId) revalidatePath(`/admin/clients/${clientId}`)
}

// EnvError names the missing variable, never its value
const emailFailure = (what: string, error: unknown) => {
    if (error instanceof EnvError) return `${what} was saved, but the email did not send: ${error.message}`
    log(`${what}: sending the email failed`, error)
    return `${what} was saved, but the email did not send. The server log has the reason.`
}

async function change(clientId: string, work: () => Promise<void>): Promise<AdminResult> {
    try {
        await work()
    } catch (error) {
        log(`Admin change to client ${clientId} failed`, error)
        return FAILED
    }
    refresh(clientId)
    return { ok: true }
}

export async function createClientAction(input: unknown, fromQuoteId?: string): Promise<AdminResult> {
    await requireAdmin()
    const parsed = clientDetailsSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }

    const existing = await repo().byEmail(parsed.data.email)
    // Offering to link is better than creating a second account on the same address
    if (existing) return { ok: false, error: 'A client already uses that email address.', clientId: existing.id }

    let created
    try {
        created = await newClientWithInvite(parsed.data)
    } catch (error) {
        log('Creating a client failed', error)
        return { ok: false, error: 'That did not work. Please try again.' }
    }

    if (fromQuoteId && id.safeParse(fromQuoteId).success) {
        try {
            await repo().linkQuote(fromQuoteId, created.client.id)
            revalidatePath(`/admin/quotes/${fromQuoteId}`)
        } catch (error) {
            // The client exists and matters more than the link, so this is reported, not rolled back
            log(`Linking quote ${fromQuoteId} to ${created.client.id} failed`, error)
        }
    }

    // Sent inline, not through after(): the admin is standing there and should be told if the relay refused
    try {
        await sendClientEmail(options => inviteEmail(created.client, created.token, options))
    } catch (error) {
        refresh(created.client.id)
        return { ok: false, error: emailFailure('The client', error), clientId: created.client.id }
    }

    refresh(created.client.id)
    redirect(`/admin/clients/${created.client.id}`)
}

export async function updateClientAction(clientId: string, input: unknown): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    const parsed = clientDetailsSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }

    const before = await repo().byId(clientId)
    if (!before) return FAILED

    try {
        await repo().updateDetails(clientId, parsed.data)
    } catch (error) {
        log(`Updating client ${clientId} failed`, error)
        return FAILED
    }
    refresh(clientId)

    if (parsed.data.email !== before.email) {
        const updated = { ...before, ...parsed.data }
        try {
            // Sent to both addresses, so the change is visible from the one it left as well as the one it landed on
            await sendClientEmail(options => emailChangedEmail(updated, { ...options, to: before.email }))
            await sendClientEmail(options => emailChangedEmail(updated, { ...options, to: updated.email }))
        } catch (error) {
            return { ok: false, error: emailFailure('The client', error), clientId }
        }
    }
    return { ok: true }
}

export async function resendInviteAction(clientId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    const client = await repo().byId(clientId)
    if (!client) return FAILED

    const now = new Date()
    const token = newSessionToken()
    try {
        await repo().invalidateTokens(clientId, 'INVITE', now)
        await repo().createToken(clientId, 'INVITE', hashSessionToken(token), new Date(now.getTime() + INVITE_TTL_MS))
    } catch (error) {
        log(`Creating a fresh invite for ${clientId} failed`, error)
        return FAILED
    }

    try {
        await sendClientEmail(options => inviteEmail(client, token, options))
    } catch (error) {
        return { ok: false, error: emailFailure('The invite', error), clientId }
    }
    refresh(clientId)
    return { ok: true }
}

export async function sendResetAction(clientId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    const client = await repo().byId(clientId)
    if (!client) return FAILED

    const now = new Date()
    const token = newSessionToken()
    try {
        await repo().invalidateTokens(clientId, 'PASSWORD_RESET', now)
        await repo().createToken(clientId, 'PASSWORD_RESET', hashSessionToken(token), new Date(now.getTime() + RESET_TTL_MS))
    } catch (error) {
        log(`Creating a password reset for ${clientId} failed`, error)
        return FAILED
    }

    try {
        await sendClientEmail(options => resetEmail(client, token, options))
    } catch (error) {
        return { ok: false, error: emailFailure('The reset link', error), clientId }
    }
    refresh(clientId)
    return { ok: true }
}

export async function resetTwoFactorAction(clientId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    const client = await repo().byId(clientId)
    if (!client) return FAILED

    try {
        // Wipes the secret, every recovery code and every session in one go
        await repo().clearTotp(clientId)
    } catch (error) {
        log(`Resetting 2FA for ${clientId} failed`, error)
        return FAILED
    }

    try {
        await sendClientEmail(options => twoFactorResetEmail(client, options))
    } catch (error) {
        refresh(clientId)
        return { ok: false, error: emailFailure('The reset', error), clientId }
    }
    refresh(clientId)
    return { ok: true }
}

export async function setSuspendedAction(clientId: string, suspended: boolean): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success || typeof suspended !== 'boolean') return INVALID
    return change(clientId, () => repo().setSuspended(clientId, suspended ? new Date() : null))
}

export async function clearLockAction(clientId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    return change(clientId, () => repo().clearLock(clientId))
}

export async function deleteClientAction(clientId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    try {
        await repo().remove(clientId)
    } catch (error) {
        log(`Deleting client ${clientId} failed`, error)
        return FAILED
    }
    revalidatePath('/admin/clients')
    // Outside the try: redirect() works by throwing
    redirect('/admin/clients')
}

export async function addSiteAction(clientId: string, input: unknown): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success) return INVALID
    const parsed = siteSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }

    try {
        await repo().createSite(clientId, parsed.data)
    } catch (error) {
        if (String(error).includes('Site_projectId_key')) return { ok: false, error: 'That project id is already linked to a client.' }
        log(`Adding a site to ${clientId} failed`, error)
        return FAILED
    }
    refresh(clientId)
    return { ok: true }
}

export async function removeSiteAction(clientId: string, siteId: string): Promise<AdminResult> {
    await requireAdmin()
    if (!id.safeParse(clientId).success || !id.safeParse(siteId).success) return INVALID
    return change(clientId, () => repo().removeSite(clientId, siteId))
}
