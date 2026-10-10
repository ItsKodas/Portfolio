'use server'

// A client paying: an invoice once, or a plan automatically. Each answers with where PayPal wants the client to
// go next, and the browser goes there. The operator viewing as a client can look but never pay, because the
// money and the PayPal account would be the client's.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { clientActor } from '@/server/audit/record'
import { billingViewer } from '@/server/invoices/viewer'
import { billing } from '@/server/invoices/wiring'

export type PayResult = { ok: true, url?: string } | { ok: false, error: string }

const id = z.string().min(1).max(64)
const method = z.enum(['paypal', 'card'])
const INVALID: PayResult = { ok: false, error: 'That request was not valid.' }
const NOT_YOURS: PayResult = { ok: false, error: 'Only the client can do this. You are viewing as them.' }

async function payer(): Promise<{ clientId: string, name: string } | PayResult> {
    const viewer = await billingViewer()
    if (!viewer || viewer === 'admin') return { ok: false, error: 'Sign in again to pay.' }
    if (viewer.viewingAs) return NOT_YOURS
    return viewer
}

export async function payInvoiceAction(invoiceId: string, how: unknown = 'paypal'): Promise<PayResult> {
    const chosen = method.safeParse(how)
    if (!id.safeParse(invoiceId).success || !chosen.success) return INVALID
    const who = await payer()
    if ('ok' in who) return who
    return billing().startCheckout(invoiceId, who.clientId, chosen.data)
}

export async function startAutopayAction(planId: string, how: unknown = 'paypal'): Promise<PayResult> {
    const chosen = method.safeParse(how)
    if (!id.safeParse(planId).success || !chosen.success) return INVALID
    const who = await payer()
    if ('ok' in who) return who
    return billing().startAutopay(planId, who.clientId, chosen.data)
}

export async function stopAutopayAction(planId: string): Promise<PayResult> {
    if (!id.safeParse(planId).success) return INVALID
    const who = await payer()
    if ('ok' in who) return who
    const result = await billing().stopAutopay(planId, clientActor({ id: who.clientId, name: who.name }), who.clientId)
    revalidatePath('/portal/billing', 'layout')
    return result
}
