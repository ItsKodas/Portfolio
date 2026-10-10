import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { todayIn, formatDayShort } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { invoiceNumber, isStanding, STANDING_LABELS, STANDING_TONES, STANDINGS, standingOf } from '@/server/invoices/standing'
import { invoices } from '@/server/invoices/wiring'
import { readPaypal } from '@/server/paypal/config'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import frame from '../frame.module.css'
import PortalHeader from '../header'
import styles from './invoices.module.css'

export const metadata: Metadata = { title: 'Invoices' }

const DAY_MS = 86_400_000

// Every invoice, newest first, with what is owed over the top
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
    await requireAdmin()
    const params = await searchParams
    const standing = isStanding(params.show) ? params.show : null
    const now = new Date()
    const today = todayIn(now)

    const repo = invoices()
    const [list, summary] = await Promise.all([repo.list({ standing }, today), repo.summary(today, new Date(now.getTime() - 30 * DAY_MS))])
    const paypal = readPaypal()

    const filters = [
        { label: 'All', href: '/portal/invoices', active: !standing },
        ...STANDINGS.map(value => ({ label: STANDING_LABELS[value], href: `/portal/invoices?show=${value}`, active: standing === value })),
    ]

    const columns = [
        { key: 'number', head: 'Invoice' },
        { key: 'client', head: 'Client' },
        { key: 'issued', head: 'Issued', numeric: true },
        { key: 'due', head: 'Due', numeric: true },
        { key: 'total', head: 'Total', numeric: true },
        { key: 'status', head: 'Status' },
    ]

    const rows = list.map(invoice => {
        const state = standingOf(invoice, today)
        return {
            number: <Link href={`/portal/invoices/${invoice.id}`} className={frame.plainLink}>{invoiceNumber(invoice.number)}</Link>,
            client: invoice.clientId
                ? <Link href={`/portal/clients/${invoice.clientId}`} className={frame.link}>{invoice.billToName}</Link>
                : invoice.billToName,
            issued: invoice.issuedOn ? formatDayShort(invoice.issuedOn) : '',
            due: formatDayShort(invoice.dueOn),
            total: formatMoney(invoice.totalCents, invoice.currency),
            status: <Chip tone={STANDING_TONES[state]}>{STANDING_LABELS[state]}</Chip>,
        }
    })

    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

    return (
        <>
            <PortalHeader admin />
            <div className={frame.page}>
                <div className={[frame.head, frame.headSpread].join(' ')}>
                    <h1 className={frame.title}>Invoices</h1>
                    <div className={styles.headActions}>
                        <Link href="/portal/invoices/plans" className={frame.action}>Plans</Link>
                        <Link href="/portal/invoices/new" className={[frame.action, frame.actionPrimary].join(' ')}>New invoice</Link>
                    </div>
                </div>

                {!paypal.ok && (
                    <div className={styles.strip}>
                        <Callout tone="warn" title="PayPal is not set up, so clients can't pay online yet">
                            {paypal.problems.join('; ')}. Invoices still send and can be marked paid by hand.
                        </Callout>
                    </div>
                )}

                <div className={styles.strip}>
                    <StatStrip stats={[
                        { key: 'Outstanding', value: formatMoney(summary.outstanding.cents), note: count(summary.outstanding.count, 'invoice') },
                        {
                            key: 'Overdue', value: formatMoney(summary.overdue.cents), note: count(summary.overdue.count, 'invoice'),
                            tone: summary.overdue.count ? 'crit' : undefined,
                        },
                        { key: 'Paid, last 30 days', value: formatMoney(summary.paid.cents), note: count(summary.paid.count, 'invoice'), tone: 'good' },
                        { key: 'Drafts', value: String(summary.drafts) },
                        { key: 'PayPal', value: paypal.ok ? paypal.value.mode : 'not set up', tone: paypal.ok ? (paypal.value.mode === 'live' ? 'good' : 'warn') : 'crit' },
                    ]} />
                </div>

                <div className={styles.filters}>
                    {filters.map(filter => (
                        <Link
                            key={filter.label}
                            href={filter.href}
                            className={[styles.filter, filter.active && styles.filterOn].filter(Boolean).join(' ')}
                            aria-current={filter.active ? 'page' : undefined}
                        >
                            {filter.label}
                        </Link>
                    ))}
                </div>

                <DataTable label="Invoices" columns={columns} rows={rows} empty={standing ? 'Nothing here.' : 'No invoices yet.'} />
            </div>
        </>
    )
}
