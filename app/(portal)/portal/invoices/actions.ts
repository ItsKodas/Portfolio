'use server'

// The operator's invoicing actions: writing, sending and settling invoices, and setting up plans. Each checks the
// operator's session first, then does one thing, then says in the activity log what it did.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { adminActor, record } from '@/server/audit/record'
import { requireAdmin } from '@/server/auth'
import { repo as clientRepo } from '@/server/clients/wiring'
import { billToOf } from '@/server/invoices/billing'
import { businessDetails } from '@/server/invoices/business'
import { formatMoney } from '@/server/invoices/money'
import { invoiceSchema, paymentNoteSchema, planSchema } from '@/server/invoices/schema'
import { billing, invoices, log, plans } from '@/server/invoices/wiring'

export type InvoiceResult = { ok: true, notice?: string } | { ok: false, error: string }

const id = z.string().min(1).max(64)
const INVALID = { ok: false, error: 'That request was not valid.' } as const
const FAILED: InvoiceResult = { ok: false, error: 'That did not work. Reload the page and try again.' }

const refresh = (invoiceId?: string, clientId?: string | null) => {
    revalidatePath('/portal/invoices')
    if (invoiceId) revalidatePath(`/portal/invoices/${invoiceId}`)
    if (clientId) revalidatePath(`/portal/clients/${clientId}`)
    revalidatePath('/portal/billing', 'layout')
}

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? INVALID.error

export async function createInvoiceAction(input: unknown): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = invoiceSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const client = await clientRepo().byId(parsed.data.clientId)
    if (!client) return { ok: false, error: 'That client no longer exists.' }

    let created
    try {
        created = await invoices().createDraft(parsed.data, billToOf(client), businessDetails().gst)
    } catch (error) {
        log('Creating an invoice failed', error)
        return FAILED
    }
    await record({
        kind: 'billing.invoiceCreate', actor, target: { type: 'invoice', id: created.id, name: `Draft for ${client.name}` },
        summary: `Drafted an invoice for ${client.name}`,
    })
    refresh(undefined, client.id)
    redirect(`/portal/invoices/${created.id}`)
}

export async function updateInvoiceAction(invoiceId: string, input: unknown): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const parsed = invoiceSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const client = await clientRepo().byId(parsed.data.clientId)
    if (!client) return { ok: false, error: 'That client no longer exists.' }
    try {
        // A draft takes whatever GST setting is current when it is saved, and keeps it once it is sent
        if (!(await invoices().updateDraft(invoiceId, parsed.data, billToOf(client), businessDetails().gst))) {
            return { ok: false, error: 'Only a draft can be edited. Void a sent invoice and write a new one instead.' }
        }
    } catch (error) {
        log(`Updating invoice ${invoiceId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'billing.invoiceUpdate', actor, target: { type: 'invoice', id: invoiceId, name: `Draft for ${client.name}` },
        summary: `Edited a draft invoice for ${client.name}`,
    })
    refresh(invoiceId, client.id)
    return { ok: true }
}

export async function deleteDraftAction(invoiceId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const before = await invoices().get(invoiceId)
    if (!before || !(await invoices().deleteDraft(invoiceId))) return { ok: false, error: 'Only a draft can be deleted. Void a sent invoice instead.' }
    await record({
        kind: 'billing.invoiceDelete', actor, target: { type: 'invoice', id: invoiceId, name: `Draft for ${before.billToName}` },
        summary: `Deleted a draft invoice for ${before.billToName} (${formatMoney(before.totalCents)})`,
    })
    refresh(undefined, before.clientId)
    redirect('/portal/invoices')
}

export async function sendInvoiceAction(invoiceId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const draft = await invoices().get(invoiceId)
    if (!draft) return FAILED
    // Addressed to the client as they are at the moment it is sent
    const client = draft.clientId ? await clientRepo().byId(draft.clientId) : null
    if (!client) return { ok: false, error: 'That client no longer exists, so there is nobody to send it to.' }
    const result = await billing().send(invoiceId, billToOf(client), actor)
    refresh(invoiceId, client.id)
    if (!result.ok) return result
    if (!result.emailed) return { ok: false, error: 'It is sent and numbered, but the email did not go. The Emails log has the reason, and "Email again" retries.' }
    return { ok: true }
}

export async function resendInvoiceAction(invoiceId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const result = await billing().resend(invoiceId, actor)
    refresh(invoiceId)
    return result.ok ? { ok: true, notice: 'Emailed again.' } : result
}

export async function chaseInvoiceAction(invoiceId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const result = await billing().chase(invoiceId, actor)
    refresh(invoiceId)
    return result.ok ? { ok: true, notice: 'Reminder sent.' } : result
}

export async function markPaidAction(invoiceId: string, note: unknown): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const parsed = paymentNoteSchema.safeParse(typeof note === 'string' ? note : null)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const result = await billing().markPaid(invoiceId, parsed.data, actor)
    refresh(invoiceId)
    return result
}

export async function voidInvoiceAction(invoiceId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(invoiceId).success) return INVALID
    const result = await billing().void(invoiceId, actor)
    refresh(invoiceId)
    return result
}

// Plans

const planTarget = (plan: { id: string, description: string }, clientName: string) =>
    ({ type: 'plan', id: plan.id, name: `${plan.description} for ${clientName}` })

const planWords = (input: { amountCents: number, interval: string }) =>
    input.amountCents === 0 ? 'not charged' : `${formatMoney(input.amountCents)} ${input.interval === 'YEARLY' ? 'a year' : 'a month'}`

export async function createPlanAction(clientId: string, input: unknown): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(clientId).success) return INVALID
    const parsed = planSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const client = await clientRepo().byId(clientId)
    if (!client) return { ok: false, error: 'That client no longer exists.' }
    let created
    try {
        created = await plans().create(clientId, parsed.data)
    } catch (error) {
        log(`Creating a plan for ${clientId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'billing.planCreate', actor, target: planTarget({ id: created.id, description: parsed.data.description }, client.name),
        summary: `Gave ${client.name} ${parsed.data.description}, ${planWords(parsed.data)}, from ${parsed.data.startsOn}`,
        detail: { amountCents: parsed.data.amountCents, interval: parsed.data.interval, startsOn: parsed.data.startsOn },
    })
    refresh(undefined, clientId)
    revalidatePath('/portal/invoices/plans')
    return { ok: true }
}

export async function updatePlanAction(planId: string, input: unknown): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(planId).success) return INVALID
    const parsed = planSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const before = await plans().get(planId)
    if (!before || before.endedAt) return { ok: false, error: 'That plan has ended, so it cannot be changed.' }
    const billed = before.periodsBilled > 0
    try {
        await plans().update(planId, parsed.data, billed)
    } catch (error) {
        log(`Updating plan ${planId} failed`, error)
        return FAILED
    }
    await record({
        kind: 'billing.planUpdate', actor, target: planTarget(before, before.client.name),
        summary: `Changed ${before.client.name}'s ${parsed.data.description} to ${planWords(parsed.data)}`,
        detail: { from: before.amountCents, to: parsed.data.amountCents, interval: parsed.data.interval },
    })
    refresh(undefined, before.clientId)
    revalidatePath('/portal/invoices/plans')
    // A plan paying automatically takes its new price to PayPal too
    const repriced = await billing().repricePaypal(planId)
    if (!repriced.ok) return repriced
    const moved = billed && parsed.data.startsOn !== before.startsOn
    return { ok: true, notice: moved ? 'Saved. The start date stays as it was, because periods have already been billed from it.' : undefined }
}

export async function endPlanAction(planId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(planId).success) return INVALID
    const plan = await plans().get(planId)
    const result = await billing().endPlan(planId, actor)
    refresh(undefined, plan?.clientId)
    revalidatePath('/portal/invoices/plans')
    return result
}

export async function stopAutopayAction(planId: string): Promise<InvoiceResult> {
    const actor = adminActor(await requireAdmin())
    if (!id.safeParse(planId).success) return INVALID
    const plan = await plans().get(planId)
    const result = await billing().stopAutopay(planId, actor)
    refresh(undefined, plan?.clientId)
    revalidatePath('/portal/invoices/plans')
    return result
}

