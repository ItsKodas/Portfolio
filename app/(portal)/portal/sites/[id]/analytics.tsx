// The Overview's analytics: visits and unique visitors per day for the last 30 days, and what was read
// most. A server component that asks hostd itself, re-deriving the caller from the session as
// deployPanel.tsx does. Live only, like the rest of the Overview.
//
// hostd counts these from the access log Apache keeps for the site, so nothing runs in the visitor's
// browser and nothing about a visitor is kept but counts. See hostd/src/agent/analytics.ts.

import { getAnalytics, type Analytics, type AnalyticsCount } from '@/server/hostd/analytics'
import { readHostd } from '@/server/hostd/config'
import { LIVE } from '@/server/hostd/env'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { DataTable } from '@/ui/DataTable/DataTable'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { AnalyticsChart } from './analyticsChart'
import { count, countryName, dayLabel, summarise } from './analyticsView'
import styles from './analytics.module.css'

async function read(id: string, isAdmin: boolean): Promise<{ ok: true, value: Analytics } | { ok: false, message: string }> {
    const who = await callerFromSession()
    if (!who) return { ok: false, message: forClient('unavailable') }
    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) return { ok: false, message: isAdmin ? problems.join('; ') : forClient('unavailable') }
    const result = await getAnalytics(config, who.caller, id, LIVE)
    if (!result.ok) return { ok: false, message: isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
    return result
}

function Top({ title, label, rows, empty, name = key => key }: {
    title: string
    label: string
    rows: AnalyticsCount[]
    empty: string
    name?: (key: string) => string
}) {
    return (
        <section className={styles.top}>
            <h3>{title}</h3>
            <DataTable
                label={title}
                columns={[{ key: 'key', head: label }, { key: 'count', head: 'Visits', numeric: true }]}
                rows={rows.map(row => ({ key: <span className={styles.topKey}>{name(row.key)}</span>, count: count(row.count) }))}
                empty={empty}
            />
        </section>
    )
}

export async function SiteAnalytics({ id, isAdmin }: { id: string, isAdmin: boolean }) {
    const result = await read(id, isAdmin)

    if (!result.ok) {
        return (
            <section className={styles.panel} aria-label="Visits">
                <h2>Visits</h2>
                <Callout tone="warn" title="Visits could not be read">{result.message}</Callout>
            </section>
        )
    }

    return <AnalyticsBody analytics={result.value} isAdmin={isAdmin} />
}

// What the panel draws from a reading hostd answered. Apart from the read so it can be drawn from any
// figures at all.
export function AnalyticsBody({ analytics, isAdmin }: { analytics: Analytics, isAdmin: boolean }) {
    // Nothing ever counted and nothing being logged: the site is served by a vhost hostd did not write,
    // or the agent has not brought its vhost up to date yet. Saying so beats an empty chart.
    if (!analytics.logging && analytics.since === null) {
        return (
            <section className={styles.panel} aria-label="Visits">
                <h2>Visits</h2>
                <Callout title="Not being counted yet">
                    {isAdmin
                        ? 'Apache is not writing an access log for this site. hostd adds one to every vhost it writes; a site still served by a hand-written vhost needs adopting first.'
                        : 'Visits to your site are not being counted yet. They will appear here once they are.'}
                </Callout>
            </section>
        )
    }

    const summary = summarise(analytics.days)
    const window = analytics.days
    const started = analytics.since !== null && window.length > 0 && analytics.since > window[0]!.date ? analytics.since : null

    return (
        <section className={styles.panel} aria-label="Visits">
            <div className={styles.head}>
                <h2>Visits</h2>
                <p className={styles.note}>
                    Last {window.length} days
                    {started && `, counted since ${dayLabel(started)}`}
                </p>
            </div>

            <StatStrip stats={[
                { key: 'visits', value: count(summary.visits) },
                { key: 'unique visitors', value: count(summary.visitors), note: 'added up day by day' },
                { key: 'today', value: count(summary.today?.views ?? 0) },
                {
                    key: 'busiest day',
                    value: summary.busiest ? count(summary.busiest.views) : '0',
                    note: summary.busiest ? dayLabel(summary.busiest.date) : undefined,
                },
            ]} />

            <ul className={styles.legend}>
                <li><span className={styles.keyViews} aria-hidden />Visits</li>
                <li><span className={styles.keyVisitors} aria-hidden />Unique visitors</li>
            </ul>
            <AnalyticsChart days={window} since={analytics.since} />

            <details className={styles.table}>
                <summary>Show as a table</summary>
                <DataTable
                    label="Visits per day"
                    columns={[
                        { key: 'date', head: 'Day' },
                        { key: 'views', head: 'Visits', numeric: true },
                        { key: 'visitors', head: 'Unique visitors', numeric: true },
                    ]}
                    rows={[...window].reverse().map(day => ({
                        date: dayLabel(day.date, 'long'),
                        views: count(day.views),
                        visitors: count(day.visitors),
                    }))}
                />
            </details>

            <div className={styles.tops}>
                <Top title="Top pages" label="Page" rows={analytics.pages} empty="No pages visited yet." />
                <Top title="Where visitors came from" label="Site" rows={analytics.referrers} empty="No visits from other sites yet." />
                {/* Only behind Cloudflare, which is what tells hostd the country: an empty list on a
                    site that is not would only ever say nothing. */}
                {analytics.countries.length > 0 && (
                    <Top title="Countries" label="Country" rows={analytics.countries} empty="" name={countryName} />
                )}
            </div>
        </section>
    )
}
