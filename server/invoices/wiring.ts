// Connects invoicing to the real database, relay, PayPal and clock. The only file that does, so everything else
// can be tested with stand-ins. Same role as server/clients/wiring.ts.

import 'server-only'

import { record } from '../audit/record'
import { getDb } from '../db'
import { clientMailConfig } from '../env'
import { createMailer } from '../mailer'
import { createPaypal, type Paypal } from '../paypal/api'
import { modeOf, readPaypal } from '../paypal/config'
import { createBilling } from './billing'
import { businessDetails } from './business'
import { invoicePdf, type PdfInvoice } from './pdf'
import { invoiceRepo, planRepo } from './repo'

export function log(message: string, error?: unknown) {
    console.error(`[billing] ${message}`, error ?? '')
}

// For a business that has numbered invoices before this one: the first number this site gives out
const firstNumber = () => {
    const value = Number(process.env.INVOICE_FIRST_NUMBER)
    return Number.isInteger(value) && value > 0 ? value : 1
}

export const invoices = () => invoiceRepo(getDb(), { firstNumber: firstNumber() })
export const plans = () => planRepo(getDb())

// One PayPal client per process, so its access token is reused, rebuilt if the settings it was made from change
const cache = globalThis as unknown as { horizonsPaypal?: { key: string, client: Paypal } }

export function paypal(): Paypal | null {
    const setup = readPaypal()
    if (!setup.ok) return null
    const key = `${setup.value.mode}:${setup.value.clientId}:${setup.value.secret.length}`
    if (cache.horizonsPaypal?.key !== key) cache.horizonsPaypal = { key, client: createPaypal(setup.value) }
    return cache.horizonsPaypal.client
}

// The mode PayPal is set up in, or null when it is not, so nothing is ever counted against a mode that is not running
export const paypalMode = () => (readPaypal().ok ? modeOf() : null)

export async function drawPdf(invoice: PdfInvoice): Promise<Buffer> {
    const business = businessDetails()
    return invoicePdf(invoice, business, { payUrl: `${business.website.replace(/^https?:\/\//, '')}/portal/billing` })
}

export function billing() {
    return createBilling({
        invoices: invoices(),
        plans: plans(),
        business: () => businessDetails(),
        paypal,
        mode: paypalMode,
        siteUrl: () => (process.env.AUTH_URL ?? '').trim().replace(/\/+$/, ''),
        send: async build => {
            const config = clientMailConfig()
            await createMailer(config)(build({ from: config.from, replyTo: config.replyTo, siteUrl: config.siteUrl }))
        },
        pdf: drawPdf,
        record,
        now: () => new Date(),
        log,
    })
}
