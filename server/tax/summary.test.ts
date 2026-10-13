import { describe, expect, it } from 'vitest'

import { deductibleOf, gstStatus, NO_SETTINGS, summarise, type EntryRow, type PaymentRow } from './summary'

const payment = (day: string, cents: number, who = 'Ann Example'): PaymentRow =>
    ({ id: `p${day}${cents}`, day, cents, invoiceId: `i${day}`, invoiceNumber: 'INV-0001', who, method: 'PayPal' })

const expense = (day: string, cents: number, category = 'Software and subscriptions', businessPercent = 100): EntryRow =>
    ({ id: `e${day}${cents}`, kind: 'EXPENSE', day, description: 'Figma', category, amountCents: cents, businessPercent })

describe('a year summary', () => {
    const summary = summarise({
        year: 2027,
        today: '2026-10-13',
        payments: [payment('2026-06-30', 99_00), payment('2026-07-01', 1_000_00), payment('2026-10-02', 500_00, 'Bob Co')],
        entries: [
            expense('2026-08-10', 200_00),
            expense('2026-09-01', 100_00, 'Phone and internet', 50),
            { id: 'cash', kind: 'INCOME', day: '2026-09-15', description: 'Logo job', category: 'Work paid outside the portal', amountCents: 300_00, businessPercent: 100 },
        ],
        settings: NO_SETTINGS,
    })

    it('counts only the year\'s own income and expenses', () => {
        expect(summary.incomeCents).toBe(1_800_00)
        expect(summary.expenseCents).toBe(250_00)
        expect(summary.profitCents).toBe(1_550_00)
        expect(summary.income.map(line => line.day)).toEqual(['2026-10-02', '2026-09-15', '2026-07-01'])
    })

    it('claims only the business share of a part-private expense', () => {
        expect(deductibleOf({ amountCents: 100_00, businessPercent: 50 })).toBe(50_00)
        expect(summary.expenses.find(line => line.category === 'Phone and internet')?.deductibleCents).toBe(50_00)
    })

    it('splits the year into months from July', () => {
        expect(summary.months[0]).toMatchObject({ month: '2026-07', label: 'Jul', incomeCents: 1_000_00, expenseCents: 0 })
        expect(summary.months[1]).toMatchObject({ month: '2026-08', expenseCents: 200_00 })
        expect(summary.months[3]).toMatchObject({ month: '2026-10', incomeCents: 500_00 })
    })

    it('groups income by who paid and expenses by category, largest first', () => {
        expect(summary.byClient).toEqual([
            { name: 'Ann Example', cents: 1_000_00 },
            { name: 'Bob Co', cents: 500_00 },
            { name: 'Not invoiced', cents: 300_00 },
        ])
        expect(summary.byCategory[0]).toEqual({ name: 'Software and subscriptions', cents: 200_00 })
    })

    it('projects the year while it is running, and not once it is over', () => {
        expect(summary.projected?.businessCents).toBeGreaterThan(summary.profitCents)
        const closed = summarise({ year: 2026, today: '2026-10-13', payments: [], entries: [], settings: NO_SETTINGS })
        expect(closed.projected).toBeNull()
    })
})

describe('GST turnover', () => {
    it('looks back twelve months from today, across the start of the year', () => {
        const status = gstStatus([{ day: '2025-10-14', cents: 10_000_00 }, { day: '2025-10-13', cents: 99_000_00 }], 2027, '2026-10-13')
        expect(status.rollingCents).toBe(10_000_00)
        expect(status.level).toBe('clear')
    })

    it('warns when getting close and when over, on the twelve months or the year at its pace', () => {
        expect(gstStatus([{ day: '2026-09-01', cents: 65_000_00 }], 2027, '2026-10-13').level).toBe('over')
        expect(gstStatus([{ day: '2026-05-01', cents: 62_000_00 }], 2027, '2026-10-13').level).toBe('near')
        expect(gstStatus([{ day: '2026-05-01', cents: 80_000_00 }], 2027, '2026-10-13').level).toBe('over')
    })
})
