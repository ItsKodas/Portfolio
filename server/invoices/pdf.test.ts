import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import type { Business } from './business'
import { invoicePdf, type PdfInvoice } from './pdf'

const business: Business = { name: 'Horizons', abn: '23 545 335 026', email: 'info@horizons.gg', address: [], website: 'https://www.horizons.gg', gst: false }

const invoice: PdfInvoice = {
    number: 42, standing: 'due', issuedOn: '2026-10-10', dueOn: '2026-10-24',
    billToName: 'Ann Lee', billToCompany: 'Lee & Co', billToEmail: 'ann@example.com', currency: 'AUD', gst: false,
    lines: [{ description: 'Landing page design', quantity: 1, unitCents: 120_000, amountCents: 120_000 }],
    subtotalCents: 120_000, gstCents: 0, totalCents: 120_000, paidCents: 0, paidOn: null, notes: 'Thanks!', periodStart: null, periodEnd: null,
}

const text = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getTitle()

describe('invoicePdf', () => {
    it('draws a PDF titled with the invoice number', async () => {
        const pdf = await invoicePdf(invoice, business, { payUrl: 'www.horizons.gg/portal/billing' })
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
        expect(await text(pdf)).toBe('Invoice INV-0042')
    })

    it('calls itself a tax invoice only when GST was charged', async () => {
        const pdf = await invoicePdf({ ...invoice, gst: true, gstCents: 12_000, totalCents: 132_000 }, business, { payUrl: 'x' })
        expect(await text(pdf)).toBe('Tax invoice INV-0042')
    })

    it('runs onto more pages rather than off the bottom, and survives text Helvetica cannot draw', async () => {
        const lines = Array.from({ length: 60 }, (_, index) => ({
            description: `Line ${index} 🚀 李 ${'word '.repeat(index % 7 * 10)}`, quantity: 1.5, unitCents: 1_000, amountCents: 1_500,
        }))
        const pdf = await invoicePdf({ ...invoice, lines, notes: 'A note\nover two lines' }, business, { payUrl: 'x' })
        expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1)
    })
})
