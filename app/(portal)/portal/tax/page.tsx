import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { formatDayShort, todayIn } from '@/server/invoices/days'
import { businessDetails } from '@/server/invoices/business'
import { keyDates } from '@/server/tax/dates'
import { reminderAddress, tax, yearReports, yearSummary } from '@/server/tax/wiring'
import { yearLabel, yearOf } from '@/server/tax/year'
import { Chip } from '@/ui/Chip/Chip'
import frame from '../frame.module.css'
import PortalHeader from '../header'
import styles from './tax.module.css'
import { TaxView, type TaxTab } from './view'

export const metadata: Metadata = { title: 'Tax' }

const TABS: TaxTab[] = ['overview', 'income', 'expenses', 'reports', 'year']

// The operator's tax year at a glance: income from the invoices, expenses added by hand, the estimate and the
// dates. Theirs alone, so it is behind requireAdmin like every operator page, and never in a client's tabs.
export default async function TaxPage({ searchParams }: { searchParams: Promise<{ year?: string, tab?: string }> }) {
    await requireAdmin()
    const params = await searchParams
    const today = todayIn(new Date())
    const current = yearOf(today)

    const repo = tax()
    const first = await repo.firstDay()
    const earliest = Math.min(current, first ? yearOf(first) : current)
    const asked = Number(params.year)
    const year = Number.isInteger(asked) && asked >= earliest && asked <= current ? asked : current
    const tab = TABS.includes(params.tab as TaxTab) ? (params.tab as TaxTab) : 'overview'

    const [summary, recent] = await Promise.all([yearSummary(year, today), repo.recentReminders()])
    const reports = await yearReports(year, today, summary)

    // What is coming up next, across the year that is running and the one before it (whose return is due in this one)
    const [last, now] = await Promise.all([repo.settings(current - 1), repo.settings(current)])
    const coming = [...keyDates(current - 1, today, last.lodgedOn), ...keyDates(current, today, now.lodgedOn)]
        .filter(date => date.state === 'soon' || date.state === 'upcoming' || date.state === 'late')
        .map(date => ({ ...date, title: `${date.title}, ${yearLabel(date.year)}` }))
        .slice(0, 3)

    const link = (to: number) => `/portal/tax?year=${to}${tab === 'overview' ? '' : `&tab=${tab}`}`

    return (
        <div className={styles.fit}>
            <PortalHeader admin />
            <div className={[frame.page, styles.page].join(' ')}>
                <div className={[frame.head, frame.headSpread, frame.headCentred, styles.head].join(' ')}>
                    <div className={styles.titleRow}>
                        <h1 className={frame.title}>Tax</h1>
                        <nav className={styles.years} aria-label="Financial year">
                            {year > earliest
                                ? <Link href={link(year - 1)} className={styles.step} aria-label={`${yearLabel(year - 1)} financial year`}>‹</Link>
                                : <span className={styles.stepOff} aria-hidden>‹</span>}
                            <span className={styles.year}>{yearLabel(year)}</span>
                            {year < current
                                ? <Link href={link(year + 1)} className={styles.step} aria-label={`${yearLabel(year + 1)} financial year`}>›</Link>
                                : <span className={styles.stepOff} aria-hidden>›</span>}
                        </nav>
                        <span className={frame.sub}>
                            {year === current ? `1 July to 30 June, to date ${formatDayShort(today)}` : 'Closed year'}
                        </span>
                    </div>
                    <Chip tone="warn">Estimates, not tax advice</Chip>
                </div>

                <TaxView
                    key={year}
                    tab={tab}
                    today={today}
                    current={year === current}
                    gstRegistered={businessDetails().gst}
                    summary={summary}
                    dates={keyDates(year, today, summary.settings.lodgedOn)}
                    coming={coming}
                    reports={reports}
                    reminders={{
                        to: reminderAddress(),
                        off: /^(0|off|false)$/i.test(process.env.TAX_REMINDERS ?? ''),
                        recent: recent.map(row => ({ key: row.key, sentOn: todayIn(row.sentAt) })),
                    }}
                />
            </div>
        </div>
    )
}
