import { auth } from '@/server/auth'
import { isAdminSession } from '@/server/auth/allow'
import { todayIn } from '@/server/invoices/days'
import { balanceSheetCsv, basCsv, profitAndLossCsv } from '@/server/tax/reports'
import { log, yearReports } from '@/server/tax/wiring'
import { yearLabel, yearOf } from '@/server/tax/year'

export const dynamic = 'force-dynamic'

const REPORTS = {
    'profit-and-loss': 'Profit and loss',
    'balance-sheet': 'Balance sheet',
    bas: 'BAS figures',
} as const

type Report = keyof typeof REPORTS

// One of the Tax page's reports as a CSV, for an accountant or a spreadsheet. The operator's alone.
export async function GET(_request: Request, { params }: { params: Promise<{ year: string, report: string }> }) {
    const session = await auth()
    if (!isAdminSession(session, process.env.ADMIN_EMAIL)) return new Response('Not found.', { status: 404 })

    const { year: yearText, report } = await params
    const today = todayIn(new Date())
    const year = Number(yearText)
    if (!Number.isInteger(year) || year < 2000 || year > yearOf(today) || !Object.hasOwn(REPORTS, report)) {
        return new Response('Not found.', { status: 404 })
    }

    try {
        const reports = await yearReports(year, today)
        const csv = report === 'profit-and-loss'
            ? profitAndLossCsv(reports.profitAndLoss)
            : report === 'balance-sheet'
                ? balanceSheetCsv(reports.balanceSheet)
                : basCsv(year, reports.bas)
        return new Response(csv, {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${REPORTS[report as Report]} ${yearLabel(year)}.csv"`,
                'Cache-Control': 'private, no-store',
            },
        })
    } catch (error) {
        log(`Making the ${report} report for ${year} failed`, error)
        return new Response('The report could not be made. Please try again.', { status: 500 })
    }
}
