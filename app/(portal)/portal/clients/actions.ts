'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { adminActor, record, type Actor } from '@/server/audit/record'
import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { EnvError } from '@/server/env'
import { emailChangedEmail, inviteEmail, resetEmail, twoFactorResetEmail } from '@/server/clients/emails'
import { clientDetailsSchema, publicContactSchema, siteSchema } from '@/server/clients/schema'
import { hashSessionToken, newSessionToken } from '@/server/clients/session'
import { INVITE_TTL_MS, RESET_TTL_MS } from '@/server/clients/setup'
import { log, newClientWithInvite, repo, sendClientEmail } from '@/server/clients/wiring'
import { callerFromSession } from '@/server/hostd/session'
import { sitesOf } from '@/server/sites/access'
import { syncHoldingContacts } from '@/server/sites/holdingContact'
import { billing } from '@/server/invoices/wiring'
import { parsePermissions } from '@/server/sites/permissions'

export type AdminResult = { ok: true } | { ok: false, error: string, clientId?: string }

const id = z.string().min(1).max(64)
const INVALID = { ok: false, error: 'That request was not valid.' } as const
const FAILED: AdminResult = { ok: false, error: 'That did not work. The client may have been deleted, so try reloading.' }

// The activity log's target for a client, by the name they had when it happened
const asTarget = (client: { id: string, name: string, company?: string | null }) =>
    ({ type: 'client', id: client.id, name: client.company ? `${client.name} (${client.company})` : client.name })

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

async function change(clientId: string, work: () => Promise<void>, recorded: () => Promise<void>): Promise<AdminResult> {
    try {
        await work()
    } catch (error) {
        log(`Admin change to client ${clientId} failed`, error)
        return FAILED
    }
    await recorded()
    refresh(clientId)
    return { ok: true }
}

export async function createClientAction(input: unknown, fromQuoteId?: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
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

    await record({
        kind: 'client.create', actor, target: asTarget(created.client),
        summary: `Created ${created.client.name} (${created.client.email})`,
        detail: fromQuoteId ? { fromQuote: fromQuoteId } : undefined,
    })

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
    const actor = adminActor(await requireAdmin())
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
    await record({
        kind: 'client.update', actor, target: asTarget({ ...before, ...parsed.data }),
        summary: `Changed the details of ${parsed.data.name}`,
        detail: { changed: changedFields(before, parsed.data) },
    })
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

// The details a client's sites show a visitor while they are down, and whether they are shown at all. Only
// the operator can list them; the client edits the same details on their own account page.
export async function savePublicContactAction(clientId: string, input: unknown, listed: unknown): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success || typeof listed !== 'boolean') return INVALID
    const parsed = publicContactSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (listed && !parsed.data.email && !parsed.data.phone) {
        return { ok: false, error: 'Add an email or a phone number before listing them.' }
    }
    const client = await repo().byId(clientId)
    if (!client) return FAILED

    try {
        await repo().setPublicContact(clientId, parsed.data)
        await repo().setPublicContactListed(clientId, listed)
    } catch (error) {
        log(`Saving the public contact of ${clientId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'client.publicContact', actor, target: asTarget(client),
        summary: listed ? `Listed ${client.name}'s public contact on their sites` : `Saved ${client.name}'s public contact, not listed`,
    })
    refresh(clientId)

    const problems = await sendHoldingContacts(await sitesOf(clientId))
    if (problems.length > 0) return { ok: false, error: `Saved, but not every site was updated: ${problems.join('; ')}`, clientId }
    return { ok: true }
}

// The operator's own caller, so hostd's audit log names them. Never throws: the change it follows is
// already saved, and a site that could not be told is said out loud by the caller or logged.
async function sendHoldingContacts(projectIds: string[]): Promise<string[]> {
    try {
        const who = await callerFromSession()
        if (!who) return ['your session has expired']
        return await syncHoldingContacts(projectIds, who.caller)
    } catch (error) {
        log('Sending holding page contacts to hostd failed', error)
        return ['the server log has the reason']
    }
}

// After an access change: who is listed on a site may have changed with it. Logged rather than reported,
// because the access change itself worked and is what the operator asked for.
async function resyncHoldingContacts(projectIds: string[]) {
    const problems = await sendHoldingContacts(projectIds)
    for (const problem of problems) log(`The holding page contact could not be updated: ${problem}`)
}

export async function resendInviteAction(clientId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success) return INVALID
    const client = await repo().byId(clientId)
    if (!client) return FAILED
    // The detail page only offers this while there is no password, and the action has to hold the same line:
    // an invite is redeemed with no second factor and no notification, so a fresh one for a finished account
    // would be a way around the authenticator the client already set up.
    if (client.passwordHash) {
        return { ok: false, error: 'That client has already set their password. Send a reset link instead.', clientId }
    }

    const now = new Date()
    const token = newSessionToken()
    try {
        await repo().invalidateTokens(clientId, 'INVITE', now)
        await repo().createToken(clientId, 'INVITE', hashSessionToken(token), new Date(now.getTime() + INVITE_TTL_MS))
    } catch (error) {
        log(`Creating a fresh invite for ${clientId} failed`, error)
        return FAILED
    }
    await record({ kind: 'client.invite', actor, target: asTarget(client), summary: `Sent ${client.name} a fresh invite` })

    try {
        await sendClientEmail(options => inviteEmail(client, token, options))
    } catch (error) {
        return { ok: false, error: emailFailure('The invite', error), clientId }
    }
    refresh(clientId)
    return { ok: true }
}

export async function sendResetAction(clientId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
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
    await record({ kind: 'client.reset', actor, target: asTarget(client), summary: `Sent ${client.name} a password reset link` })

    try {
        await sendClientEmail(options => resetEmail(client, token, options))
    } catch (error) {
        return { ok: false, error: emailFailure('The reset link', error), clientId }
    }
    refresh(clientId)
    return { ok: true }
}

export async function resetTwoFactorAction(clientId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
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
    await record({
        kind: 'client.twoFactorReset', actor, target: asTarget(client),
        summary: `Reset ${client.name}'s authenticator and signed them out everywhere`,
    })

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
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success || typeof suspended !== 'boolean') return INVALID
    return change(
        clientId,
        () => repo().setSuspended(clientId, suspended ? new Date() : null),
        () => recordAbout(actor, clientId, suspended ? 'client.suspend' : 'client.unsuspend', name => (suspended ? `Suspended ${name}` : `Restored ${name}`)),
    )
}

export async function clearLockAction(clientId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success) return INVALID
    return change(
        clientId,
        () => repo().clearLock(clientId),
        () => recordAbout(actor, clientId, 'client.unlock', name => `Cleared the sign-in lock on ${name}`),
    )
}

export async function deleteClientAction(clientId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success) return INVALID
    // Read first, because afterwards there is no name left to say who was deleted, and no sites to update
    const before = await repo().byId(clientId)
    const sites = await sitesOf(clientId).catch(() => [])
    // Their plans go with them, so PayPal has to stop taking money for them before they do. Their invoices stay.
    const stopped = await billing().stopAllForClient(clientId, actor)
    if (!stopped.ok) return { ok: false, error: `Not deleted: ${stopped.error}`, clientId }
    try {
        await repo().remove(clientId)
    } catch (error) {
        log(`Deleting client ${clientId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'client.delete', actor,
        target: before ? asTarget(before) : { type: 'client', id: clientId },
        summary: `Deleted ${before ? `${before.name} (${before.email})` : clientId}`,
    })
    if (before?.publicContactListed) await resyncHoldingContacts(sites)
    revalidatePath('/admin/clients')
    // Outside the try: redirect() works by throwing
    redirect('/admin/clients')
}

// Access is shown on both the client's page and the site's Access tab, and a site's nav and tabs follow it, so
// a change to it refreshes the whole portal rather than guessing which page asked.
async function changeAccess(clientId: string, work: () => Promise<void>, recorded: () => Promise<void>): Promise<AdminResult> {
    try {
        await work()
    } catch (error) {
        log(`Changing site access for ${clientId} failed`, error)
        return FAILED
    }
    await recorded()
    revalidatePath('/portal', 'layout')
    return { ok: true }
}

// Gives a client a site, or changes what they may do on one they already have. Taken from the client's page
// (any project id, typed) and from a site's Access tab (that site, by its id and name) alike.
export async function grantSiteAction(clientId: string, input: unknown, permissions: unknown): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success) return INVALID
    const parsed = siteSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    const allowed = parsePermissions(permissions)
    if (!allowed) return INVALID
    const client = await repo().byId(clientId)
    if (!client) return FAILED

    const result = await changeAccess(clientId, () => repo().grantAccess(clientId, parsed.data, allowed), () => record({
        kind: 'access.grant', actor, site: parsed.data.projectId, target: asTarget(client),
        summary: `Gave ${client.name} ${parsed.data.projectId}: ${permissionWords(allowed)}`,
        detail: { permissions: allowed },
    }))
    if (result.ok && client.publicContactListed) await resyncHoldingContacts([parsed.data.projectId])
    return result
}

export async function setSitePermissionsAction(clientId: string, siteId: string, permissions: unknown): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success || !id.safeParse(siteId).success) return INVALID
    const allowed = parsePermissions(permissions)
    if (!allowed) return INVALID
    return changeAccess(clientId, () => repo().setAccessPermissions(siteId, clientId, allowed), () => recordAccess(
        actor, clientId, siteId, 'access.permissions', (name, site) => `Changed ${name}'s access to ${site}: ${permissionWords(allowed)}`,
        { permissions: allowed },
    ))
}

export async function revokeSiteAction(clientId: string, siteId: string): Promise<AdminResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success || !id.safeParse(siteId).success) return INVALID
    // The site is named before the row goes, since afterwards there is nothing to read it from
    const site = await siteName(siteId)
    const result = await changeAccess(clientId, () => repo().revokeAccess(siteId, clientId), () => recordAccess(
        actor, clientId, siteId, 'access.revoke', (name, project) => `Took ${project} away from ${name}`, undefined, site,
    ))
    if (result.ok && site) await resyncHoldingContacts([site])
    return result
}

// What the activity log says about a change that only had the client's id to hand
async function recordAbout(
    actor: Actor, clientId: string, kind: 'client.suspend' | 'client.unsuspend' | 'client.unlock', say: (name: string) => string,
) {
    const client = await repo().byId(clientId).catch(() => null)
    await record({
        kind, actor,
        target: client ? asTarget(client) : { type: 'client', id: clientId },
        summary: say(client?.name ?? clientId),
    })
}

// SiteAccess names a site by the portal's own row id. The log names the hostd project id instead, which is
// what every site event and the Logs page's site filter use.
async function siteName(siteId: string): Promise<string | null> {
    const row = await getDb().site.findUnique({ where: { id: siteId }, select: { projectId: true } }).catch(() => null)
    return row?.projectId ?? null
}

async function recordAccess(
    actor: Actor, clientId: string, siteId: string, kind: 'access.permissions' | 'access.revoke',
    say: (name: string, site: string) => string, detail?: Record<string, unknown>, known?: string | null,
) {
    const [client, site] = await Promise.all([repo().byId(clientId).catch(() => null), known ?? siteName(siteId)])
    await record({
        kind, actor, site,
        target: client ? asTarget(client) : { type: 'client', id: clientId },
        summary: say(client?.name ?? clientId, site ?? siteId),
        detail,
    })
}

const permissionWords = (permissions: readonly string[]) =>
    permissions.length === 0 ? 'overview only' : permissions.map(one => one.toLowerCase().replace('_', ' ')).join(', ')

// Which fields an edit changed, by name. The values are on the client's page; the log says what moved.
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
    return Object.keys(after).filter(key => (before[key] ?? null) !== (after[key] ?? null))
}
