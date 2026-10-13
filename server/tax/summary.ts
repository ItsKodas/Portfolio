// One financial year, added up: what came in, what went out, month by month and by where it came from, the
// GST turnover and the tax estimate. Plain logic over rows the repo has already read, so the page and the
// reminder emails tell the same story and both are tested without a database.

import { addDays, type Day } from '../invoices/days'
import { estimate, GST_NEAR_CENTS, GST_THRESHOLD_CENTS, type Estimate } from './estimate'
import { monthLabel, monthsOf, shareElapsed, within, type FinancialYear } from './year'

// Income an invoice brought in: one payment, net of any GST it carried, since GST collected is never income
export type PaymentRow = {
    id: string
    day: Day
    cents: number
    invoiceId: string
    invoiceNumber: string
    who: string
    method: string
}

export type EntryRow = {
    id: string
    kind: 'INCOME' | 'EXPENSE'
    day: Day
    description: string
    category: string
    amountCents: number
    businessPercent: number
}

export type YearSettings = { otherIncomeCents: number, withheldCents: number, lodgedOn: Day | null }

export const NO_SETTINGS: YearSettings = { otherIncomeCents: 0, withheldCents: 0, lodgedOn: null }

// Who income added by hand came from, as the lists and the by-client bars show it
export const NOT_INVOICED = 'Not invoiced'

export type IncomeLine = {
    id: string
    day: Day
    description: string
    who: string
    source: string
    cents: number
    invoiceId: string | null
    entryId: string | null
}

export type ExpenseLine = {
    id: string
    day: Day
    description: string
    category: string
    cents: number
    businessPercent: number
    deductibleCents: number
}

export type Month = { month: string, label: string, incomeCents: number, expenseCents: number }

export type Share = { name: string, cents: number }

export type GstStatus = {
    // Income over the twelve months to today: the test the ATO applies each month
    rollingCents: number
    // This year's income so far, carried on at the same pace to 30 June
    projectedCents: number
    thresholdCents: number
    level: 'clear' | 'near' | 'over'
}

export type YearSummary = {
    year: FinancialYear
    incomeCents: number
    expenseCents: number
    profitCents: number
    months: Month[]
    income: IncomeLine[]
    expenses: ExpenseLine[]
    byClient: Share[]
    byCategory: Share[]
    gst: GstStatus
    estimate: Estimate
    // The estimate carried on to 30 June at this year's pace, while the year is still running
    projected: Estimate | null
    settings: YearSettings
}

export const deductibleOf = (entry: { amountCents: number, businessPercent: number }): number =>
    Math.round(entry.amountCents * Math.min(100, Math.max(0, entry.businessPercent)) / 100)

function shares(lines: { name: string, cents: number }[]): Share[] {
    const totals = new Map<string, number>()
    for (const line of lines) totals.set(line.name, (totals.get(line.name) ?? 0) + line.cents)
    return [...totals].map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents)
}

const byDayDesc = <T extends { day: Day }>(a: T, b: T) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)

export function gstStatus(income: { day: Day, cents: number }[], year: FinancialYear, today: Day): GstStatus {
    const from = addDays(today, -365)
    const rollingCents = income.filter(line => line.day > from && line.day <= today).reduce((sum, line) => sum + line.cents, 0)
    const yearCents = income.filter(line => within(line.day, year) && line.day <= today).reduce((sum, line) => sum + line.cents, 0)
    const elapsed = shareElapsed(today, year)
    const projectedCents = elapsed > 0 && elapsed < 1 ? Math.round(yearCents / elapsed) : yearCents
    const highest = Math.max(rollingCents, projectedCents)
    return {
        rollingCents,
        projectedCents,
        thresholdCents: GST_THRESHOLD_CENTS,
        level: highest >= GST_THRESHOLD_CENTS ? 'over' : highest >= GST_NEAR_CENTS ? 'near' : 'clear',
    }
}

// payments and entries may run wider than the year (the GST test looks back twelve months from today); only
// the year's own rows are added into its totals
export function summarise(input: {
    year: FinancialYear
    today: Day
    payments: PaymentRow[]
    entries: EntryRow[]
    settings: YearSettings
}): YearSummary {
    const { year, today, settings } = input

    const allIncome: IncomeLine[] = [
        ...input.payments.map(payment => ({
            id: `payment:${payment.id}`, day: payment.day, description: payment.invoiceNumber, who: payment.who,
            source: payment.method, cents: payment.cents, invoiceId: payment.invoiceId, entryId: null,
        })),
        ...input.entries.filter(entry => entry.kind === 'INCOME').map(entry => ({
            id: `entry:${entry.id}`, day: entry.day, description: entry.description, who: NOT_INVOICED,
            source: entry.category, cents: entry.amountCents, invoiceId: null, entryId: entry.id,
        })),
    ]
    const income = allIncome.filter(line => within(line.day, year)).sort(byDayDesc)

    const expenses: ExpenseLine[] = input.entries
        .filter(entry => entry.kind === 'EXPENSE' && within(entry.day, year))
        .map(entry => ({
            id: entry.id, day: entry.day, description: entry.description, category: entry.category,
            cents: entry.amountCents, businessPercent: entry.businessPercent, deductibleCents: deductibleOf(entry),
        }))
        .sort(byDayDesc)

    const incomeCents = income.reduce((sum, line) => sum + line.cents, 0)
    const expenseCents = expenses.reduce((sum, line) => sum + line.deductibleCents, 0)
    const profitCents = incomeCents - expenseCents

    const months = monthsOf(year).map(month => ({
        month,
        label: monthLabel(month),
        incomeCents: income.filter(line => line.day.startsWith(month)).reduce((sum, line) => sum + line.cents, 0),
        expenseCents: expenses.filter(line => line.day.startsWith(month)).reduce((sum, line) => sum + line.deductibleCents, 0),
    }))

    const current = estimate({ businessCents: profitCents, otherCents: settings.otherIncomeCents, withheldCents: settings.withheldCents }, year)

    // Only while the year is part done: before it starts there is nothing to carry on, after it ends nothing to project
    const elapsed = shareElapsed(today, year)
    const projected = elapsed > 0 && elapsed < 1
        ? estimate({ businessCents: Math.round(profitCents / elapsed), otherCents: settings.otherIncomeCents, withheldCents: settings.withheldCents }, year)
        : null

    return {
        year,
        incomeCents,
        expenseCents,
        profitCents,
        months,
        income,
        expenses,
        byClient: shares(income.map(line => ({ name: line.who, cents: line.cents }))),
        byCategory: shares(expenses.map(line => ({ name: line.category, cents: line.deductibleCents }))),
        gst: gstStatus(allIncome, year, today),
        estimate: current,
        projected,
        settings,
    }
}
