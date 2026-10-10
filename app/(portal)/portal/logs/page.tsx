import type { Metadata } from 'next'
import Link from 'next/link'

import { CATEGORIES, kindLabel } from '@/server/audit/kinds'
import { auditRepo, VISITORS } from '@/server/audit/read'
import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { Button } from '@/ui/Button/Button'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { Field } from '@/ui/Field/Field'
import { formatWhen } from '../format'
import frame from '../frame.module.css'
import PortalHeader from '../header'
import styles from './logs.module.css'
import { activityHref, readActivityQuery } from './query'
import { LogViews, Pager } from './views'

export const metadata: Metadata = { title: 'Logs' }

const WHO_TYPE = { ADMIN: 'Operator', CLIENT: 'Client', VISITOR: 'Not signed in', SYSTEM: 'Automatic' } as const

// Everything anyone has done, newest first. The operator's alone: a client never sees another client's
// doings, or their own written down like this.
export default async function ActivityLog({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    await requireAdmin()
    const query = readActivityQuery(await searchParams)

    const repo = auditRepo(getDb())
    const [{ rows, more }, actors, sites] = await Promise.all([repo.events(query), repo.actors(), repo.sites()])

    const columns = [
        { key: 'when', head: 'When' },
        { key: 'who', head: 'Who' },
        { key: 'what', head: 'What' },
        { key: 'site', head: 'Site' },
        { key: 'summary', head: 'Details' },
    ]

    const table = rows.map(row => ({
        when: <span className={styles.when}>{formatWhen(row.createdAt)}</span>,
        who: (
            <>
                <span className={styles.who}>
                    {row.actorType === 'CLIENT' && row.actorId
                        ? <Link href={`/portal/clients/${row.actorId}`} className={frame.plainLink}>{row.actorName ?? row.actorId}</Link>
                        : row.actorName ?? row.actorId ?? 'Someone'}
                </span>
                <span className={styles.whoType}>{WHO_TYPE[row.actorType]}</span>
            </>
        ),
        what: <Chip tone={toneOf(row.kind)}>{kindLabel(row.kind)}</Chip>,
        site: row.site && <Link href={`/portal/sites/${row.site}`} className={frame.link}>{row.site}</Link>,
        summary: (
            <div className={styles.summary}>
                {row.summary}
                {row.detail !== null && (
                    <details className={styles.detail}>
                        <summary>More</summary>
                        <pre>{JSON.stringify(row.detail, null, 2)}</pre>
                    </details>
                )}
            </div>
        ),
    }))

    const filtered = query.category || query.actor || query.site

    return (
        <>
            <PortalHeader admin />
            <div className={frame.page}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Logs</h1>
                    <p className={frame.sub}>Everything done in the portal, newest first</p>
                </div>

                <LogViews current="activity" />

                {/* A plain GET form, so a filtered view is an address that can be bookmarked or sent */}
                <form method="get" action="/portal/logs" className={styles.filters}>
                    <Field as="select" label="Type" name="type" defaultValue={query.category ?? ''}>
                        <option value="">Everything</option>
                        {Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </Field>
                    <Field as="select" label="Who" name="actor" defaultValue={query.actor ?? ''}>
                        <option value="">Anyone</option>
                        <option value={VISITORS}>Not signed in</option>
                        {/* One the list no longer has still shows as chosen, rather than the filter quietly vanishing */}
                        {query.actor && query.actor !== VISITORS && !actors.some(one => one.value === query.actor) && (
                            <option value={query.actor}>{query.actor}</option>
                        )}
                        {actors.map(one => <option key={one.value} value={one.value}>{one.label}</option>)}
                    </Field>
                    <Field as="select" label="Site" name="site" defaultValue={query.site ?? ''}>
                        <option value="">Any site</option>
                        {query.site && !sites.includes(query.site) && <option value={query.site}>{query.site}</option>}
                        {sites.map(site => <option key={site} value={site}>{site}</option>)}
                    </Field>
                    <div className={styles.filterButtons}>
                        <Button type="submit" variant="primary" size="small">Filter</Button>
                        {filtered && <Link href="/portal/logs" className={[frame.action, frame.actionSmall].join(' ')}>Clear</Link>}
                    </div>
                </form>

                <DataTable
                    label="Activity"
                    columns={columns}
                    rows={table}
                    empty={filtered ? 'Nothing matches these filters.' : 'Nothing has been recorded yet.'}
                />
                <Pager page={query.page} more={more} href={page => activityHref(query, { page })} />
            </div>
        </>
    )
}

// Taking something away is worth seeing at a glance; everything else reads as plain
function toneOf(kind: string): 'warn' | 'crit' | undefined {
    if (/\.(delete|revoke|suspend|signInRefused|codeRefused|twoFactorReset|paymentFailed|invoiceVoid|overdue)$/.test(kind)) return 'crit'
    if (/\.(stop|rollback|noteDelete|invoiceDelete|refund|autopayStop|planEnd)$/.test(kind)) return 'warn'
    return undefined
}
