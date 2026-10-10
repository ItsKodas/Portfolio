import { describe, expect, it } from 'vitest'

import { invoiceSchema, planSchema } from './schema'

const invoice = {
    clientId: 'cl_ABCDEFGH', dueOn: '2026-10-24', notes: '',
    lines: [{ description: 'Landing page', quantity: '1.5', unitCents: '1,200.50' }],
}

describe('invoiceSchema', () => {
    it('reads prices and quantities as typed', () => {
        const parsed = invoiceSchema.parse(invoice)
        expect(parsed.lines[0]).toEqual({ description: 'Landing page', quantity: 1.5, unitCents: 120_050 })
        expect(parsed.notes).toBeNull()
    })

    it('says what is wrong with a line', () => {
        const message = (patch: object) => invoiceSchema.safeParse({ ...invoice, lines: [{ ...invoice.lines[0], ...patch }] }).error?.issues[0]?.message
        expect(message({ unitCents: 'ten' })).toMatch(/amount/)
        expect(message({ quantity: '0' })).toMatch(/above zero/)
        expect(message({ quantity: '1.234' })).toMatch(/two decimal/)
        expect(message({ description: ' ' })).toMatch(/Describe/)
    })

    it('needs a line and a real due date', () => {
        expect(invoiceSchema.safeParse({ ...invoice, lines: [] }).success).toBe(false)
        expect(invoiceSchema.safeParse({ ...invoice, dueOn: '2026-02-30' }).success).toBe(false)
    })
})

describe('planSchema', () => {
    const plan = { description: 'Website hosting', amountCents: '49', interval: 'MONTHLY', startsOn: '2026-11-01', dueDays: '14', siteId: '' }

    it('allows a plan that is not charged', () => {
        expect(planSchema.parse({ ...plan, amountCents: '0' })).toMatchObject({ amountCents: 0, dueDays: 14, siteId: null })
    })

    it('refuses an interval or a term it does not know', () => {
        expect(planSchema.safeParse({ ...plan, interval: 'WEEKLY' }).success).toBe(false)
        expect(planSchema.safeParse({ ...plan, dueDays: '1.5' }).success).toBe(false)
        expect(planSchema.safeParse({ ...plan, description: 'two\nlines' }).success).toBe(false)
    })
})
