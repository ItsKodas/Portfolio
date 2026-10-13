'use client'

// The Tax page under its heading: the year's figures across the top, and four tabs under them. On a desktop the
// whole thing fits the window (tax.module.css) and a long list scrolls inside its own panel; on a phone it is
// one column and the page scrolls.

import Link from 'next/link'
import { useState } from 'react'

import { formatDayShort, type Day } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import type { KeyDate } from '@/server/tax/dates'
import type { Estimate } from '@/server/tax/estimate'
import type { Share, YearSummary } from '@/server/tax/summary'
import { endOf, startOf, yearLabel } from '@/server/tax/year'
import { Chip } from '@/ui/Chip/Chip'
import { Meter } from '@/ui/Meter/Meter'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { Tabs } from '@/ui/Tabs/Tabs'
import { MonthlyChart, ProfitChart } from './charts'
import { DeleteEntry, EntryForm, YearForm } from './controls'
import styles from './tax.module.css'

export type TaxTab = 'overview' | 'income' | 'expenses' | 'year'

const TABS: { id: TaxTab, label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'income', label: 'Income' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'year', label: 'Dates and details' },
]

type Props = {
    tab: TaxTab
    today: Day
    current: boolean
    gstRegistered: boolean
    summary: YearSummary
    dates: KeyDate[]
    coming: KeyDate[]
    reminders: { to: string | null, off: boolean, recent: { key: string, sentOn: Day }[] }
}

const dayMonth = (day: Day) => formatDayShort(day).replace(/\s\d{4}$/, '')

const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`

const DATE_TONES: Record<KeyDate['state'], 'good' | 'warn' | 'crit' | undefined> = {
    done: 'good', soon: 'warn', late: 'crit', upcoming: undefined, past: undefined,
}
const DATE_LABELS: Record<KeyDate['state'], string> = {
    done: 'Done', soon: 'Soon', late: 'Overdue', upcoming: 'Upcoming', past: 'Passed',
}

const REMINDER_NAMES: Record<string, string> = {
    'eofy-30': 'Year ends in 30 days',
    'eofy-7': 'Year ends in 7 days',
    'year-closed': 'Year closed',
    'return-30': 'Return due in 30 days',
    'return-7': 'Return due in 7 days',
    'return-due': 'Return due today',
    'return-late': 'Return overdue',
    'gst-near': 'Nearing the GST threshold',
    'gst-over': 'Reached the GST threshold',
}

function reminderName(key: string): string {
    const [kind, year] = key.split(':')
    return `${REMINDER_NAMES[kind] ?? kind}${year ? `, ${yearLabel(Number(year))}` : ''}`
}

function Bars({ shares, empty }: { shares: Share[], empty: string }) {
    if (!shares.length) return <p className={styles.empty}>{empty}</p>
    const top = Math.max(...shares.map(share => share.cents))
    return (
        <ul className={styles.bars}>
            {shares.map(share => (
                <li key={share.name} className={styles.barRow}>
                    <span className={styles.barFill} style={{ width: `${top ? (share.cents / top) * 100 : 0}%` }} aria-hidden />
                    <span className={styles.barName}>{share.name}</span>
                    <span className={styles.barValue}>{formatMoney(share.cents)}</span>
                </li>
            ))}
        </ul>
    )
}

function Breakdown({ estimate, projected }: { estimate: Estimate, projected: Estimate | null }) {
    const rows: [string, number, string?][] = [
        ['Business profit', estimate.businessCents],
        ...(estimate.otherCents ? [['Other income', estimate.otherCents] as [string, number]] : []),
        ['Taxable income', estimate.taxableCents, styles.subtotal],
        ['Income tax', estimate.incomeTaxCents],
        ...(estimate.lowIncomeOffsetCents ? [['Low income offset', -estimate.lowIncomeOffsetCents] as [string, number]] : []),
        ...(estimate.smallBusinessOffsetCents ? [['Small business offset', -estimate.smallBusinessOffsetCents] as [string, number]] : []),
        ['Medicare levy', estimate.medicareCents],
        ['Estimated tax', estimate.totalCents, styles.subtotal],
        ...(estimate.withheldCents ? [['Already paid', -estimate.withheldCents] as [string, number], ['Still to pay', estimate.owingCents, styles.total] as [string, number, string]] : []),
    ]
    return (
        <>
            <dl className={styles.breakdown}>
                {rows.map(([label, cents, className]) => (
                    <div key={label} className={className}>
                        <dt>{label}</dt>
                        <dd>{cents < 0 ? `-${formatMoney(-cents)}` : formatMoney(cents)}</dd>
                    </div>
                ))}
            </dl>
            {projected && (
                <p className={styles.small}>
                    At this pace the year ends with {formatMoney(projected.businessCents)} profit and about {formatMoney(projected.totalCents)} tax.
                </p>
            )}
        </>
    )
}

export function TaxView({ tab, today, current, gstRegistered, summary, dates, coming, reminders }: Props) {
    const [selected, setSelected] = useState<TaxTab>(tab)
    const { estimate, gst } = summary
    const year = summary.year
    // Months that have begun: the running profit is drawn this far and no further
    const through = summary.months.filter(month => `${month.month}-01` <= today).length
    const entryDay = current ? today : endOf(year)
    // Put aside, as a share of profit, so a payment coming in can be split as it lands. Worked out on the year at
    // its current pace while it runs, since the rate climbs as the year's profit does.
    const basis = summary.projected ?? estimate
    const setAside = basis.businessCents > 0 ? basis.businessShareCents / basis.businessCents : 0

    const gstTurnover = Math.max(gst.rollingCents, gst.projectedCents)
    const gstTone = gst.level === 'over' ? 'crit' : gst.level === 'near' ? 'warn' : 'good'

    return (
        <div className={styles.body}>
            <div className={styles.stats}>
                <StatStrip stats={[
                    { key: 'Income', value: formatMoney(summary.incomeCents), note: `${summary.income.length} payment${summary.income.length === 1 ? '' : 's'}` },
                    { key: 'Expenses', value: formatMoney(summary.expenseCents), note: `${summary.expenses.length} logged` },
                    { key: 'Profit', value: formatMoney(summary.profitCents), tone: summary.profitCents < 0 ? 'crit' : undefined, note: 'Income less expenses' },
                    { key: 'Estimated tax', value: formatMoney(estimate.totalCents), note: `${percent(estimate.rate)} of taxable income` },
                    estimate.withheldCents
                        ? { key: 'Still to pay', value: formatMoney(estimate.owingCents), tone: estimate.owingCents ? 'warn' : 'good', note: 'After tax already paid' }
                        : { key: 'Put aside', value: percent(setAside), note: 'Of each dollar of profit' },
                ]} />
            </div>

            <Tabs label="Tax" tabs={TABS} selected={selected} onSelect={id => setSelected(id as TaxTab)} />

            <div className={styles.panel} role="tabpanel" id={`panel-${selected}`} aria-labelledby={`tab-${selected}`}>
                {selected === 'overview' && (
                    <div className={styles.split}>
                        <div className={styles.charts}>
                            <section className={styles.chartBlock}>
                                <div className={styles.chartHead}>
                                    <h2>Each month</h2>
                                    <span className={styles.legend}>
                                        <span><span className={styles.keyIncome} aria-hidden />Income</span>
                                        <span><span className={styles.keyExpense} aria-hidden />Expenses</span>
                                    </span>
                                </div>
                                <MonthlyChart months={summary.months} />
                            </section>
                            <section className={styles.chartBlock}>
                                <div className={styles.chartHead}>
                                    <h2>Profit so far</h2>
                                    <span className={styles.note}>{formatMoney(summary.profitCents)} to date</span>
                                </div>
                                <ProfitChart months={summary.months} through={through} />
                            </section>
                        </div>
                        <aside className={styles.side}>
                            <section>
                                <h2 className={styles.sideHead}>Tax estimate</h2>
                                <Breakdown estimate={estimate} projected={summary.projected} />
                            </section>
                            <section>
                                <h2 className={styles.sideHead}>GST</h2>
                                {gstRegistered
                                    ? <p className={styles.small}>Registered for GST. Invoices charge it, and income here is counted without it.</p>
                                    : (
                                        <Meter
                                            label="Turnover"
                                            value={`${formatMoney(gstTurnover)} of ${formatMoney(gst.thresholdCents).replace(/\.00$/, '')}`}
                                            percent={(gstTurnover / gst.thresholdCents) * 100}
                                            tone={gstTone}
                                            threshold={80}
                                            note={gst.level === 'over'
                                                ? 'Over the threshold: register for GST within 21 days.'
                                                : gst.level === 'near'
                                                    ? 'Getting close. Registration is required at $75,000.'
                                                    : `Last 12 months ${formatMoney(gst.rollingCents)}, this year projected ${formatMoney(gst.projectedCents)}. Not registered, which is fine below $75,000.`}
                                            noteTone={gst.level === 'clear' ? undefined : 'warn'}
                                        />
                                    )}
                            </section>
                            <section>
                                <h2 className={styles.sideHead}>Coming up</h2>
                                {coming.length
                                    ? (
                                        <ul className={styles.coming}>
                                            {coming.map(date => (
                                                <li key={`${date.title}${date.day}`}>
                                                    <span className={styles.comingDay}>{dayMonth(date.day)}</span>
                                                    <span>{date.title}</span>
                                                    {date.state !== 'upcoming' && <Chip tone={DATE_TONES[date.state]}>{DATE_LABELS[date.state]}</Chip>}
                                                </li>
                                            ))}
                                        </ul>
                                    )
                                    : <p className={styles.empty}>Nothing due.</p>}
                            </section>
                        </aside>
                    </div>
                )}

                {selected === 'income' && (
                    <div className={styles.split}>
                        <div className={styles.listWrap}>
                            {summary.income.length
                                ? (
                                    <table className={styles.table} aria-label="Income">
                                        <thead><tr><th>Date</th><th>For</th><th>From</th><th>How</th><th className={styles.num}>Amount</th><th aria-label="Actions" /></tr></thead>
                                        <tbody>
                                            {summary.income.map(line => (
                                                <tr key={line.id}>
                                                    <td className={styles.dim}>{formatDayShort(line.day)}</td>
                                                    <td>{line.invoiceId ? <Link href={`/portal/invoices/${line.invoiceId}`} className={styles.link}>{line.description}</Link> : line.description}</td>
                                                    <td>{line.who}</td>
                                                    <td className={styles.dim}>{line.source}</td>
                                                    <td className={styles.num}>{formatMoney(line.cents)}</td>
                                                    <td className={styles.act}>{line.entryId && <DeleteEntry id={line.entryId} description={line.description} />}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )
                                : <p className={styles.empty}>No income in {yearLabel(year)} yet. Paid invoices land here on their own.</p>}
                        </div>
                        <aside className={styles.side}>
                            <section>
                                <h2 className={styles.sideHead}>Add income</h2>
                                <p className={styles.small}>Paid invoices are counted already. Add money that came in another way.</p>
                                <EntryForm kind="INCOME" defaultDay={entryDay} min={startOf(year)} max={endOf(year)} />
                            </section>
                            <section>
                                <h2 className={styles.sideHead}>By client</h2>
                                <Bars shares={summary.byClient} empty="Nothing yet." />
                            </section>
                        </aside>
                    </div>
                )}

                {selected === 'expenses' && (
                    <div className={styles.split}>
                        <div className={styles.listWrap}>
                            {summary.expenses.length
                                ? (
                                    <table className={styles.table} aria-label="Expenses">
                                        <thead><tr><th>Date</th><th>What for</th><th>Category</th><th className={styles.num}>Paid</th><th className={styles.num}>Claimed</th><th aria-label="Actions" /></tr></thead>
                                        <tbody>
                                            {summary.expenses.map(line => (
                                                <tr key={line.id}>
                                                    <td className={styles.dim}>{formatDayShort(line.day)}</td>
                                                    <td>{line.description}</td>
                                                    <td className={styles.dim}>{line.category}</td>
                                                    <td className={styles.num}>{formatMoney(line.cents)}</td>
                                                    <td className={styles.num}>{formatMoney(line.deductibleCents)}{line.businessPercent < 100 && <span className={styles.dim}> ({line.businessPercent}%)</span>}</td>
                                                    <td className={styles.act}><DeleteEntry id={line.id} description={line.description} /></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )
                                : <p className={styles.empty}>No expenses logged for {yearLabel(year)}. Software, hosting, equipment, your phone and internet, and PayPal fees all count.</p>}
                        </div>
                        <aside className={styles.side}>
                            <section>
                                <h2 className={styles.sideHead}>Add an expense</h2>
                                <EntryForm kind="EXPENSE" defaultDay={entryDay} min={startOf(year)} max={endOf(year)} />
                            </section>
                            <section>
                                <h2 className={styles.sideHead}>By category</h2>
                                <Bars shares={summary.byCategory} empty="Nothing yet." />
                            </section>
                        </aside>
                    </div>
                )}

                {selected === 'year' && (
                    <div className={styles.split}>
                        <div className={styles.listWrap}>
                            <ol className={styles.dates}>
                                {dates.map(date => (
                                    <li key={date.title} className={styles.date}>
                                        <span className={styles.dateDay}>{formatDayShort(date.day)}</span>
                                        <div>
                                            <p className={styles.dateTitle}>{date.title} <Chip tone={DATE_TONES[date.state]}>{DATE_LABELS[date.state]}</Chip></p>
                                            <p className={styles.small}>{date.detail}</p>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                            <h2 className={styles.sideHead}>Reminder emails</h2>
                            <p className={styles.small}>
                                {reminders.off
                                    ? 'Switched off on the server (TAX_REMINDERS).'
                                    : reminders.to
                                        ? `Sent to ${reminders.to}: 30 and 7 days before the year ends, when it closes, 30 and 7 days before the return is due, on the day, and if it is late (until it is marked lodged). Also when turnover nears or reaches the GST threshold.`
                                        : 'Nowhere to send them: set TAX_NOTIFY_TO or ADMIN_EMAIL on the server.'}
                            </p>
                            {reminders.recent.length > 0 && (
                                <ul className={styles.sent}>
                                    {reminders.recent.map(reminder => (
                                        <li key={reminder.key}><span className={styles.dim}>{formatDayShort(reminder.sentOn)}</span> {reminderName(reminder.key)}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <aside className={styles.side}>
                            <section>
                                <h2 className={styles.sideHead}>{yearLabel(year)} details</h2>
                                <YearForm year={year} settings={summary.settings} returnOpen={!summary.settings.lodgedOn} />
                            </section>
                            <p className={styles.small}>
                                Worked out as a sole trader: business profit goes on your own return, taxed at resident rates with the
                                Medicare levy, the low income offset and the small business offset. It leaves out anything the portal
                                can&rsquo;t know, so treat it as a guide to what to put aside, not the figure on your assessment.
                            </p>
                        </aside>
                    </div>
                )}
            </div>
        </div>
    )
}
