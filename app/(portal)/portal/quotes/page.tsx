import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { WarningAmber } from '@/ui/icons'
import { STATUS_TONES, formatWhen } from '../format'
import AdminHeader from '../adminHeader'
import frame from '../frame.module.css'
import styles from './quotes.module.css'

export const metadata: Metadata = { title: 'Quotes' }

const isStatus = (value: string | undefined): value is Status => (STATUSES as readonly string[]).includes(value ?? '')

export default async function Inbox({ searchParams }: { searchParams: Promise<{ status?: string, archived?: string }> }) {
    await requireAdmin()
    const params = await searchParams
    const status = isStatus(params.status) ? params.status : undefined
    const archived = params.archived === '1'

    const repo = quoteRepo(getDb())
    const [quotes, newCount] = await Promise.all([repo.list({ status, archived }), repo.countNew()])
    const now = new Date()

    const filters: { label: string, href: string, active: boolean }[] = [
        { label: 'All', href: '/admin', active: !status && !archived },
        ...STATUSES.map(value => ({ label: STATUS_LABELS[value], href: `/admin?status=${value}`, active: status === value && !archived })),
        { label: 'Archived', href: '/admin?archived=1', active: archived },
    ]

    const columns = [
        { key: 'received', head: 'Received', numeric: true },
        { key: 'name', head: 'Name' },
        { key: 'company', head: 'Company' },
        { key: 'project', head: 'Project' },
        { key: 'budget', head: 'Budget' },
        { key: 'status', head: 'Status' },
    ]

    const rows = quotes.map(quote => ({
        received: formatWhen(quote.createdAt),
        name: (
            <>
                <Link href={`/admin/quotes/${quote.id}`} className={frame.plainLink}>{quote.name}</Link>
                {/* Was a Tooltip, which said nothing on a touch screen and hid the meaning behind a hover.
                    An icon with a title has an accessible name and is read out where a tooltip was not. */}
                {emailsMissing(quote, now) && (
                    <span className={styles.missing}>
                        <WarningAmber size={16} title="An email for this quote was not sent" />
                    </span>
                )}
            </>
        ),
        company: quote.company,
        project: quote.projectType && PROJECT_TYPE_LABELS[quote.projectType],
        budget: quote.budget && BUDGET_LABELS[quote.budget],
        status: <Chip tone={STATUS_TONES[quote.status]}>{STATUS_LABELS[quote.status]}</Chip>,
    }))

    return (
        <div className={frame.page}>
            <AdminHeader />
            <div className={frame.head}>
                <h1 className={frame.title}>Quotes</h1>
                <p className={frame.sub}>{newCount} new</p>
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

            {/* DataTable prints its own line rather than headings over nothing, so the page has no empty state of its own */}
            <DataTable label="Quotes" columns={columns} rows={rows} empty="Nothing here." />
        </div>
    )
}
