import { describe, expect, it } from 'vitest'

import type { Business } from './business'
import { invoiceEmail, overdueEmail, receiptEmail, reminderEmail, type EmailInvoice } from './emails'

const business: Business = { name: 'Horizons', abn: '23 545 335 026', email: 'info@horizons.gg', address: [], website: 'https://www.horizons.gg', gst: false }
const options = { from: 'Horizons <billing@example.com>', replyTo: 'info@example.com', siteUrl: 'https://www.horizons.gg' }
const invoice: EmailInvoice = {
    id: 'inv1', number: 7, billToName: 'Ann', billToEmail: 'ann@example.com', totalCents: 4_900, currency: 'AUD',
    issuedOn: '2026-10-01', dueOn: '2026-10-15', periodStart: '2026-10-01', periodEnd: '2026-10-31', planDescription: 'Website hosting',
}

describe('invoice emails', () => {
    it('sends the invoice to the client with its PDF and a link to pay', () => {
        const email = invoiceEmail(invoice, business, { ...options, pdf: Buffer.from('%PDF-') })
        expect(email.to).toBe('ann@example.com')
        expect(email.subject).toBe('Invoice INV-0007 from Horizons')
        expect(email.attachments?.[0]).toMatchObject({ filename: 'INV-0007.pdf', contentType: 'application/pdf' })
        expect(email.text).toContain('https://www.horizons.gg/portal/billing/inv1')
        expect(email.text).toContain('Website hosting, 1 October 2026 to 31 October 2026')
        expect(email.text).toContain('pay itself automatically')
    })

    it('reminds, chases and thanks', () => {
        expect(reminderEmail(invoice, business, options).subject).toBe('Reminder: invoice INV-0007 is due 15 October 2026')
        expect(overdueEmail(invoice, business, { ...options, notice: 1 }).text).toContain('has not been paid yet')
        expect(overdueEmail(invoice, business, { ...options, notice: 2 }).text).toContain('is still unpaid')
        const receipt = receiptEmail(invoice, business, { ...options, amountCents: 4_900, paidOn: '2026-10-03', automatic: true })
        expect(receipt.text).toContain('automatic payment')
        expect(receipt.text).toContain('ABN 23 545 335 026')
    })

    it('never uses an em dash', () => {
        const all = [
            invoiceEmail(invoice, business, { ...options, pdf: Buffer.from('') }), reminderEmail(invoice, business, options),
            overdueEmail(invoice, business, { ...options, notice: 3 }),
            receiptEmail(invoice, business, { ...options, amountCents: 1, paidOn: '2026-10-03', automatic: false }),
        ]
        for (const email of all) expect(`${email.subject}${email.text}${email.html}`).not.toMatch(/—|&mdash;/)
    })
})
