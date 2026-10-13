// The three reports an accountant or the ATO asks a small business for, built from a year's summary: a profit
// and loss statement, a balance sheet and the figures for a business activity statement. Plain logic, so the
// page and the CSV downloads show the same numbers.

import type { Day } from '../invoices/days'
import type { YearSummary } from './summary'
import { endOf, startOf, yearLabel, type FinancialYear } from './year'

export type ReportLine = { label: string, cents: number, previousCents?: number }

export type ProfitAndLoss = {
    year: FinancialYear
    income: ReportLine[]
    incomeCents: number
    expenses: ReportLine[]
    expenseCents: number
    profitCents: number
    previous: { year: FinancialYear, incomeCents: number, expenseCents: number, profitCents: number } | null
}

export const SALES = 'Sales (invoices paid)'

function totalsBy(lines: { label: string, cents: number }[]): Map<string, number> {
    const totals = new Map<string, number>()
    for (const line of lines) totals.set(line.label, (totals.get(line.label) ?? 0) + line.cents)
    return totals
}

const incomeLines = (summary: YearSummary) =>
    summary.income.map(line => ({ label: line.invoiceId ? SALES : line.source, cents: line.cents }))

const expenseLines = (summary: YearSummary) =>
    summary.expenses.map(line => ({ label: line.category, cents: line.deductibleCents }))

// Lines from this year and last, in one list, so a category only one year had still shows in both columns
function compare(current: Map<string, number>, previous: Map<string, number> | null): ReportLine[] {
    const labels = [...new Set([...current.keys(), ...(previous?.keys() ?? [])])]
    return labels
        .map(label => ({ label, cents: current.get(label) ?? 0, ...(previous && { previousCents: previous.get(label) ?? 0 }) }))
        .sort((a, b) => (a.label === SALES ? -1 : b.label === SALES ? 1 : b.cents - a.cents || a.label.localeCompare(b.label)))
}

export function profitAndLoss(summary: YearSummary, previous: YearSummary | null): ProfitAndLoss {
    return {
        year: summary.year,
        income: compare(totalsBy(incomeLines(summary)), previous && totalsBy(incomeLines(previous))),
        incomeCents: summary.incomeCents,
        expenses: compare(totalsBy(expenseLines(summary)), previous && totalsBy(expenseLines(previous))),
        expenseCents: summary.expenseCents,
        profitCents: summary.profitCents,
        previous: previous && { year: previous.year, incomeCents: previous.incomeCents, expenseCents: previous.expenseCents, profitCents: previous.profitCents },
    }
}

export type BalanceItem = { id: string, side: 'ASSET' | 'LIABILITY', name: string, amountCents: number }

export type BalanceSheet = {
    asAt: Day
    assets: (ReportLine & { id?: string })[]
    assetCents: number
    liabilities: (ReportLine & { id?: string })[]
    liabilityCents: number
    equityCents: number
}

// The year's last day once it is over, and today while it runs
export const balanceDayOf = (year: FinancialYear, today: Day): Day => (today < endOf(year) ? today : endOf(year))

export function balanceSheet(input: { asAt: Day, receivableCents: number, taxOwingCents: number, items: BalanceItem[] }): BalanceSheet {
    const assets = [
        ...input.items.filter(item => item.side === 'ASSET').map(item => ({ id: item.id, label: item.name, cents: item.amountCents })),
        { label: 'Owed by clients (invoices sent, not yet paid)', cents: input.receivableCents },
    ]
    const liabilities = [
        ...input.items.filter(item => item.side === 'LIABILITY').map(item => ({ id: item.id, label: item.name, cents: item.amountCents })),
        { label: 'Income tax for the year, estimated', cents: input.taxOwingCents },
    ]
    const assetCents = assets.reduce((sum, line) => sum + line.cents, 0)
    const liabilityCents = liabilities.reduce((sum, line) => sum + line.cents, 0)
    return { asAt: input.asAt, assets, assetCents, liabilities, liabilityCents, equityCents: assetCents - liabilityCents }
}

// A business activity statement covers a quarter. The labels are the ATO's own: G1 total sales (GST included),
// 1A GST on sales, 1B GST on purchases, and T1 the income PAYG instalments are worked out on.
export type BasQuarter = {
    label: string
    from: Day
    to: Day
    due: Day
    g1Cents: number
    gstOnSalesCents: number
    gstOnPurchasesCents: number
    t1Cents: number
    // Not started yet, so its figures are nothing rather than a quarter of nothing
    future: boolean
}

const QUARTERS = [
    { label: 'July to September', from: '07-01', to: '09-30', due: '10-28', yearOffset: -1 },
    { label: 'October to December', from: '10-01', to: '12-31', due: '02-28', yearOffset: -1 },
    { label: 'January to March', from: '01-01', to: '03-31', due: '04-28', yearOffset: 0 },
    { label: 'April to June', from: '04-01', to: '06-30', due: '07-28', yearOffset: 0 },
]

// Cash basis, as a small business reports: a sale counts in the quarter it was paid. Without GST registration
// 1A and 1B stay nothing, because an unregistered business neither charges GST nor claims it back.
export function basQuarters(summary: YearSummary, today: Day, gstRegistered: boolean): BasQuarter[] {
    return QUARTERS.map((quarter, index) => {
        const calendar = summary.year + quarter.yearOffset
        const from = `${calendar}-${quarter.from}`
        const to = `${calendar}-${quarter.to}`
        // October to December's is due in February, the only one that falls in the next calendar year
        const due = `${index === 1 ? calendar + 1 : calendar}-${quarter.due}`
        const lines = summary.income.filter(line => line.day >= from && line.day <= to)
        const net = lines.reduce((sum, line) => sum + line.cents, 0)
        const gst = lines.reduce((sum, line) => sum + line.gstCents, 0)
        return {
            label: quarter.label, from, to, due,
            g1Cents: net + gst,
            gstOnSalesCents: gstRegistered ? gst : 0,
            gstOnPurchasesCents: 0,
            t1Cents: net,
            future: from > today,
        }
    })
}

// CSV for an accountant's spreadsheet. Amounts in plain dollars with two places and no symbol, so they sum.
const cell = (value: string | number) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const dollars = (cents: number) => (cents / 100).toFixed(2)
const rows = (lines: (string | number)[][]) => lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n'

export function profitAndLossCsv(report: ProfitAndLoss): string {
    const previous = report.previous
    const head = ['', yearLabel(report.year), ...(previous ? [yearLabel(previous.year)] : [])]
    const line = (label: string, cents: number, previousCents?: number) =>
        [label, dollars(cents), ...(previous ? [dollars(previousCents ?? 0)] : [])]
    return rows([
        [`Profit and loss, ${yearLabel(report.year)} (${startOf(report.year)} to ${endOf(report.year)}), cash basis`],
        head,
        ['Income'],
        ...report.income.map(item => line(item.label, item.cents, item.previousCents)),
        line('Total income', report.incomeCents, previous?.incomeCents),
        ['Expenses'],
        ...report.expenses.map(item => line(item.label, item.cents, item.previousCents)),
        line('Total expenses', report.expenseCents, previous?.expenseCents),
        line('Net profit', report.profitCents, previous?.profitCents),
    ])
}

export function balanceSheetCsv(sheet: BalanceSheet): string {
    return rows([
        [`Balance sheet as at ${sheet.asAt}`],
        ['Assets'],
        ...sheet.assets.map(line => [line.label, dollars(line.cents)]),
        ['Total assets', dollars(sheet.assetCents)],
        ['Liabilities'],
        ...sheet.liabilities.map(line => [line.label, dollars(line.cents)]),
        ['Total liabilities', dollars(sheet.liabilityCents)],
        ['Owner\'s equity', dollars(sheet.equityCents)],
    ])
}

export function basCsv(year: FinancialYear, quarters: BasQuarter[]): string {
    return rows([
        [`Business activity statement figures, ${yearLabel(year)}, cash basis`],
        ['Quarter', 'From', 'To', 'Due', 'G1 Total sales', '1A GST on sales', '1B GST on purchases', 'T1 PAYG instalment income'],
        ...quarters.map(quarter => [
            quarter.label, quarter.from, quarter.to, quarter.due,
            dollars(quarter.g1Cents), dollars(quarter.gstOnSalesCents), dollars(quarter.gstOnPurchasesCents), dollars(quarter.t1Cents),
        ]),
    ])
}
