'use client'

// The Reports tab: a profit and loss statement, a balance sheet and the BAS figures, one at a time, each with a
// CSV download for an accountant. The report fills the main column and scrolls inside it; the side column says
// what the report is and, for the balance sheet, takes the lines the portal can't work out.

import { useState } from 'react'

import { formatDay, formatDayShort, type Day } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import type { ReportLine } from '@/server/tax/reports'
import type { YearReports } from '@/server/tax/wiring'
import { yearLabel } from '@/server/tax/year'
import { Chip } from '@/ui/Chip/Chip'
import { BalanceForm, DeleteEntry } from './controls'
import styles from './tax.module.css'

type Report = 'profit-and-loss' | 'balance-sheet' | 'bas'

const REPORTS: { id: Report, label: string }[] = [
    { id: 'profit-and-loss', label: 'Profit and loss' },
    { id: 'balance-sheet', label: 'Balance sheet' },
    { id: 'bas', label: 'BAS' },
]

const money = (cents: number) => (cents < 0 ? `(${formatMoney(-cents)})` : formatMoney(cents))

function Lines({ lines, previous, deletable }: { lines: (ReportLine & { id?: string })[], previous: boolean, deletable?: boolean }) {
    return (
        <>
            {lines.map(line => (
                <tr key={`${line.label}${line.id ?? ''}`}>
                    <td className={styles.indent}>{line.label}</td>
                    <td className={styles.num}>{money(line.cents)}</td>
                    {previous && <td className={[styles.num, styles.dim].join(' ')}>{money(line.previousCents ?? 0)}</td>}
                    {deletable && <td className={styles.act}>{line.id && <DeleteEntry id={line.id} description={line.label} line />}</td>}
                </tr>
            ))}
        </>
    )
}

function Total({ label, cents, previous, strong, span = 0 }: { label: string, cents: number, previous?: number | null, strong?: boolean, span?: number }) {
    return (
        <tr className={strong ? styles.grand : styles.sum}>
            <td>{label}</td>
            <td className={styles.num}>{money(cents)}</td>
            {previous !== undefined && previous !== null && <td className={[styles.num, styles.dim].join(' ')}>{money(previous)}</td>}
            {span > 0 && <td />}
        </tr>
    )
}

const Heading = ({ children, span }: { children: string, span: number }) => (
    <tr className={styles.section}><th colSpan={span} scope="colgroup">{children}</th></tr>
)

export function ReportsPanel({ year, today, gstRegistered, reports }: { year: number, today: Day, gstRegistered: boolean, reports: YearReports }) {
    const [report, setReport] = useState<Report>('profit-and-loss')
    const { profitAndLoss: pnl, balanceSheet: sheet, bas } = reports
    const label = yearLabel(year)
    const previous = !!pnl.previous
    const span = previous ? 3 : 2

    return (
        <div className={styles.split}>
            <div className={styles.listWrap}>
                {report === 'profit-and-loss' && (
                    <table className={[styles.table, styles.statement].join(' ')} aria-label={`Profit and loss, ${label}`}>
                        <thead>
                            <tr><th /><th className={styles.num}>{label}</th>{previous && <th className={styles.num}>{yearLabel(pnl.previous!.year)}</th>}</tr>
                        </thead>
                        <tbody>
                            <Heading span={span}>Income</Heading>
                            {pnl.income.length ? <Lines lines={pnl.income} previous={previous} /> : <tr><td className={[styles.indent, styles.dim].join(' ')} colSpan={span}>None yet</td></tr>}
                            <Total label="Total income" cents={pnl.incomeCents} previous={pnl.previous?.incomeCents ?? null} />
                            <Heading span={span}>Expenses</Heading>
                            {pnl.expenses.length ? <Lines lines={pnl.expenses} previous={previous} /> : <tr><td className={[styles.indent, styles.dim].join(' ')} colSpan={span}>None logged</td></tr>}
                            <Total label="Total expenses" cents={pnl.expenseCents} previous={pnl.previous?.expenseCents ?? null} />
                            <Total label="Net profit" cents={pnl.profitCents} previous={pnl.previous?.profitCents ?? null} strong />
                        </tbody>
                    </table>
                )}

                {report === 'balance-sheet' && (
                    <table className={[styles.table, styles.statement].join(' ')} aria-label={`Balance sheet as at ${formatDay(sheet.asAt)}`}>
                        <thead><tr><th>As at {formatDay(sheet.asAt)}</th><th className={styles.num} /><th aria-label="Actions" /></tr></thead>
                        <tbody>
                            <Heading span={3}>Assets</Heading>
                            <Lines lines={sheet.assets} previous={false} deletable />
                            <Total label="Total assets" cents={sheet.assetCents} span={1} />
                            <Heading span={3}>Liabilities</Heading>
                            <Lines lines={sheet.liabilities} previous={false} deletable />
                            <Total label="Total liabilities" cents={sheet.liabilityCents} span={1} />
                            <Total label="Owner’s equity" cents={sheet.equityCents} strong span={1} />
                        </tbody>
                    </table>
                )}

                {report === 'bas' && (
                    <table className={styles.table} aria-label={`BAS figures, ${label}`}>
                        <thead>
                            <tr>
                                <th>Quarter</th><th>Due</th>
                                <th className={styles.num}>G1 Total sales</th>
                                <th className={styles.num}>1A GST on sales</th>
                                <th className={styles.num}>1B GST on purchases</th>
                                <th className={styles.num}>T1 Instalment income</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bas.map(quarter => (
                                <tr key={quarter.from} className={quarter.future ? styles.dim : undefined}>
                                    <td>{quarter.label}<span className={styles.dim}> {quarter.from.slice(0, 4)}</span></td>
                                    <td className={styles.dim}>{formatDayShort(quarter.due)}</td>
                                    <td className={styles.num}>{quarter.future ? '' : formatMoney(quarter.g1Cents)}</td>
                                    <td className={styles.num}>{quarter.future ? '' : formatMoney(quarter.gstOnSalesCents)}</td>
                                    <td className={styles.num}>{quarter.future ? '' : formatMoney(quarter.gstOnPurchasesCents)}</td>
                                    <td className={styles.num}>{quarter.future ? '' : formatMoney(quarter.t1Cents)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <aside className={styles.side}>
                <section>
                    <div className={styles.switch} role="radiogroup" aria-label="Report">
                        {REPORTS.map(item => (
                            <button key={item.id} type="button" role="radio" aria-checked={report === item.id}
                                className={[styles.switchItem, report === item.id && styles.switchOn].filter(Boolean).join(' ')}
                                onClick={() => setReport(item.id)}>
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <a className={styles.download} href={`/api/tax/${year}/${report}`} download>Download as CSV</a>
                </section>

                {report === 'profit-and-loss' && (
                    <p className={styles.small}>
                        Income and expenses for 1 July to 30 June, counted when the money moved (cash basis), with expenses at their
                        business share.{previous ? ' The second column is the year before.' : ''} These are the totals the business
                        schedule of your tax return asks for.
                    </p>
                )}

                {report === 'balance-sheet' && (
                    <>
                        <p className={styles.small}>
                            What the business owned and owed {sheet.asAt === today ? 'today' : `on ${formatDay(sheet.asAt)}`}. Money clients
                            owe and the estimated tax are worked out; add the rest, like your bank balance or equipment, as it stood then.
                        </p>
                        <section>
                            <h2 className={styles.sideHead}>Add a line</h2>
                            <BalanceForm year={year} />
                        </section>
                    </>
                )}

                {report === 'bas' && (
                    <>
                        {gstRegistered
                            ? <p className={styles.small}>Registered for GST, so a BAS is due each quarter by the date shown. Lodge it through Online services for business or your tax agent.</p>
                            : (
                                <>
                                    <span className={styles.chipRow}><Chip>No BAS needed yet</Chip></span>
                                    <p className={styles.small}>
                                        A sole trader who is not registered for GST and has no employees does not lodge a BAS. If the ATO puts you
                                        on PAYG instalments it sends an instalment notice instead, and T1 is the figure it asks for. These are the
                                        figures a BAS would take, ready for when you register.
                                    </p>
                                </>
                            )}
                        <p className={styles.small}>Quarters are counted on a cash basis: a sale counts in the quarter it was paid.</p>
                    </>
                )}
            </aside>
        </div>
    )
}
