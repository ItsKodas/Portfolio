import type { Metadata } from 'next'
import Link from 'next/link'

import { auditRepo } from '@/server/audit/read'
import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { formatWhen } from '../../format'
import frame from '../../frame.module.css'
import PortalHeader from '../../header'
import styles from '../logs.module.css'
import { emailsHref, readPage } from '../query'
import { LogViews, Pager } from '../views'

export const metadata: Metadata = { title: 'Emails' }

// Every email the site has sent, or tried to, newest first. Each one opens whole.
export default async function SentEmails({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
    await requireAdmin()
    const page = readPage((await searchParams).page)
    const { rows, more } = await auditRepo(getDb()).emails(page)

    const columns = [
        { key: 'when', head: 'Sent' },
        { key: 'to', head: 'To' },
        { key: 'subject', head: 'Subject' },
        { key: 'status', head: 'Status' },
    ]

    const table = rows.map(row => ({
        when: <span className={styles.when}>{formatWhen(row.createdAt)}</span>,
        to: row.to,
        subject: <Link href={`/portal/logs/emails/${row.id}`} className={frame.plainLink}>{row.subject}</Link>,
        status: row.error ? <Chip tone="crit">Not sent</Chip> : <Chip tone="good">Sent</Chip>,
    }))

    return (
        <>
            <PortalHeader admin />
            <div className={frame.page}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Logs</h1>
                    <p className={frame.sub}>Every email the site has sent, newest first</p>
                </div>

                <LogViews current="emails" />

                <DataTable label="Emails" columns={columns} rows={table} empty="No email has been sent yet." />
                <Pager page={page} more={more} href={emailsHref} />
            </div>
        </>
    )
}
