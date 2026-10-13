import { describe, expect, it } from 'vitest'

import { balanceDayOf, balanceSheet, balanceSheetCsv, basCsv, basQuarters, profitAndLoss, profitAndLossCsv, SALES } from './reports'
import { NO_SETTINGS, summarise, type EntryRow, type PaymentRow } from './summary'

const payment = (day: string, cents: number, gstCents = 0): PaymentRow =>
    ({ id: `p${day}`, day, cents, gstCents, invoiceId: `i${day}`, invoiceNumber: 'INV-0001', who: 'Ann', method: 'PayPal' })

const expense = (day: string, cents: number, category: string, businessPercent = 100): EntryRow =>
    ({ id: `e${day}${category}`, kind: 'EXPENSE', day, description: 'x', category, amountCents: cents, businessPercent })

const year2027 = summarise({
    year: 2027, today: '2027-02-10', settings: NO_SETTINGS,
    payments: [payment('2026-07-10', 1_000_00), payment('2026-11-02', 2_000_00), payment('2027-01-20', 500_00, 50_00)],
    entries: [
        expense('2026-08-01', 300_00, 'Hosting and domains'),
        expense('2026-09-01', 100_00, 'Phone and internet', 50),
        { id: 'cash', kind: 'INCOME', day: '2026-12-01', description: 'Cash job', category: 'Work paid outside the portal', amountCents: 200_00, businessPercent: 100 },
    ],
})

const year2026 = summarise({
    year: 2026, today: '2027-02-10', settings: NO_SETTINGS,
    payments: [payment('2026-05-01', 800_00)], entries: [expense('2026-05-02', 50_00, 'Advertising')],
})

describe('profit and loss', () => {
    const report = profitAndLoss(year2027, year2026)

    it('puts invoiced sales first, then other income, and the expenses at their business share', () => {
        expect(report.income).toEqual([
            { label: SALES, cents: 3_500_00, previousCents: 800_00 },
            { label: 'Work paid outside the portal', cents: 200_00, previousCents: 0 },
        ])
        expect(report.expenses.map(line => [line.label, line.cents, line.previousCents])).toEqual([
            ['Hosting and domains', 300_00, 0],
            ['Phone and internet', 50_00, 0],
            ['Advertising', 0, 50_00],
        ])
        expect(report.profitCents).toBe(3_350_00)
        expect(report.previous).toEqual({ year: 2026, incomeCents: 800_00, expenseCents: 50_00, profitCents: 750_00 })
    })

    it('downloads as a CSV of plain dollar amounts', () => {
        const csv = profitAndLossCsv(report)
        expect(csv).toContain(',2026-27,2025-26\r\n')
        expect(csv).toContain('Sales (invoices paid),3500.00,800.00\r\n')
        expect(csv).toContain('Net profit,3350.00,750.00\r\n')
    })

    it('has one column when there is no year before', () => {
        expect(profitAndLossCsv(profitAndLoss(year2027, null))).toContain('Net profit,3350.00\r\n')
    })
})

describe('balance sheet', () => {
    it('is as at the last day of a closed year, or today', () => {
        expect(balanceDayOf(2026, '2026-10-13')).toBe('2026-06-30')
        expect(balanceDayOf(2027, '2026-10-13')).toBe('2026-10-13')
    })

    it('adds what clients owe and the estimated tax to the lines given, and equity balances it', () => {
        const sheet = balanceSheet({
            asAt: '2026-10-13', receivableCents: 400_00, taxOwingCents: 900_00,
            items: [
                { id: 'a', side: 'ASSET', name: 'Business bank account', amountCents: 5_000_00 },
                { id: 'b', side: 'LIABILITY', name: 'Credit card', amountCents: 300_00 },
            ],
        })
        expect(sheet.assetCents).toBe(5_400_00)
        expect(sheet.liabilityCents).toBe(1_200_00)
        expect(sheet.equityCents).toBe(4_200_00)
        expect(balanceSheetCsv(sheet)).toContain('Owner\'s equity,4200.00\r\n')
    })
})

describe('BAS figures', () => {
    const quarters = basQuarters(year2027, '2027-02-10', false)

    it('splits the year into quarters with the ATO due dates', () => {
        expect(quarters.map(quarter => [quarter.from, quarter.to, quarter.due])).toEqual([
            ['2026-07-01', '2026-09-30', '2026-10-28'],
            ['2026-10-01', '2026-12-31', '2027-02-28'],
            ['2027-01-01', '2027-03-31', '2027-04-28'],
            ['2027-04-01', '2027-06-30', '2027-07-28'],
        ])
        expect(quarters.map(quarter => quarter.future)).toEqual([false, false, false, true])
    })

    it('counts sales GST included at G1 and without it at T1, and no GST unless registered', () => {
        expect(quarters[1]).toMatchObject({ g1Cents: 2_200_00, t1Cents: 2_200_00, gstOnSalesCents: 0 })
        expect(quarters[2]).toMatchObject({ g1Cents: 550_00, t1Cents: 500_00, gstOnSalesCents: 0 })
        expect(basQuarters(year2027, '2027-02-10', true)[2].gstOnSalesCents).toBe(50_00)
    })

    it('downloads with the ATO labels', () => {
        expect(basCsv(2027, quarters)).toContain('G1 Total sales,1A GST on sales,1B GST on purchases,T1 PAYG instalment income')
    })
})
