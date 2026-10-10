// The Overview's body: visits and unique visitors per day for the last 30 days over the live log, with
// what was read most and what the site is made of in a column beside them. A server component that asks
// hostd itself, re-deriving the caller from the session as deployPanel.tsx does. Live only, like the rest
// of the Overview.
//
// Laid out to fit the window on a desktop rather than scroll: the chart is short, the log takes whatever
// height is left, and the side column scrolls inside itself if its lists outgrow the screen. A phone
// stacks it all and scrolls the page, as every other tab does.
//
// hostd counts visits from the access log Apache keeps for the site, so nothing runs in the visitor's
// browser and nothing about a visitor is kept but counts. See hostd/src/agent/analytics.ts.

import type { ReactNode } from 'react'

import { getAnalytics, type Analytics, type AnalyticsCount } from '@/server/hostd/analytics'
import { readHostd } from '@/server/hostd/config'
import { LIVE } from '@/server/hostd/env'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { DataTable } from '@/ui/DataTable/DataTable'
import { AnalyticsChart } from './analyticsChart'
import { count, countryName, dayLabel, summarise } from './analyticsView'
import styles from './analytics.module.css'

// How many rows each list in the side column shows. Enough to say what matters, few enough that three
// lists and the containers fit beside the chart and the log.
const ROWS = 5

type Reading = { ok: true, value: Analytics } | { ok: false, message: string }

async function read(id: string, isAdmin: boolean): Promise<Reading> {
    const who = await callerFromSession()
    if (!who) return { ok: false, message: forClient('unavailable') }
    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) return { ok: false, message: isAdmin ? problems.join('; ') : forClient('unavailable') }
    const result = await getAnalytics(config, who.caller, id, LIVE)
    if (!result.ok) return { ok: false, message: isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
    return result
}

// One short list, each row with a bar for its share of the top row, so the order reads at a glance
function Top({ title, rows, name = key => key }: { title: string, rows: AnalyticsCount[], name?: (key: string) => string }) {
    const shown = rows.slice(0, ROWS)
    const most = shown[0]?.count ?? 1
    return (
        <section className={styles.top}>
            <h3>{title}</h3>
            <ol className={styles.topList}>
                {shown.map(row => (
                    <li key={row.key} className={styles.topRow}>
                        <span className={styles.topBar} style={{ width: `${(row.count / most) * 100}%` }} aria-hidden />
                        <span className={styles.topKey} title={name(row.key)}>{name(row.key)}</span>
                        <span className={styles.topCount}>{count(row.count)}</span>
                    </li>
                ))}
            </ol>
        </section>
    )
}

type Props = {
    id: string
    isAdmin: boolean
    // The live log, under the chart, when this viewer may read it
    logs?: ReactNode
    // What the site is made of, at the foot of the side column
    side: ReactNode
}

export async function SiteAnalytics({ id, isAdmin, logs, side }: Props) {
    return <OverviewBody reading={await read(id, isAdmin)} isAdmin={isAdmin} logs={logs} side={side} />
}

// The layout around a reading hostd answered or refused. Apart from the read so it can be drawn from any
// figures at all.
export function OverviewBody({ reading, isAdmin, logs, side }: Omit<Props, 'id'> & { reading: Reading }) {
    const analytics = reading.ok ? reading.value : null
    const lists = analytics && (
        <>
            {analytics.pages.length > 0 && <Top title="Top pages" rows={analytics.pages} />}
            {analytics.referrers.length > 0 && <Top title="Where visitors came from" rows={analytics.referrers} />}
            {/* Only behind Cloudflare, which is what tells hostd the country */}
            {analytics.countries.length > 0 && <Top title="Countries" rows={analytics.countries} name={countryName} />}
        </>
    )

    return (
        <div className={styles.overview}>
            <div className={styles.main}>
                <Visits reading={reading} isAdmin={isAdmin} />
                {logs && <div className={styles.logs}>{logs}</div>}
            </div>
            <div className={styles.side}>
                {lists}
                {side}
            </div>
        </div>
    )
}

function Visits({ reading, isAdmin }: { reading: Reading, isAdmin: boolean }) {
    if (!reading.ok) {
        return (
            <section className={styles.visits} aria-label="Visits">
                <Callout tone="warn" title="Visits could not be read">{reading.message}</Callout>
            </section>
        )
    }

    const analytics = reading.value
    // Nothing ever counted and nothing being logged: the site is served by a vhost hostd did not write,
    // or the agent has not brought its vhost up to date yet. Saying so beats an empty chart.
    if (!analytics.logging && analytics.since === null) {
        return (
            <section className={styles.visits} aria-label="Visits">
                <Callout title="Visits are not being counted yet">
                    {isAdmin
                        ? 'Apache is not writing an access log for this site. hostd adds one to every vhost it writes; a site still served by a hand-written vhost needs adopting first.'
                        : 'They will appear here once they are.'}
                </Callout>
            </section>
        )
    }

    const summary = summarise(analytics.days)
    const window = analytics.days
    const started = analytics.since !== null && window.length > 0 && analytics.since > window[0]!.date ? analytics.since : null

    return (
        <section className={styles.visits} aria-label="Visits">
            <div className={styles.head}>
                <h2>
                    Visits
                    <span className={styles.note}>
                        {` last ${window.length} days`}
                        {started && `, counted since ${dayLabel(started)}`}
                    </span>
                </h2>
                {/* The totals, each beside its line's colour, which makes them the chart's legend too */}
                <dl className={styles.totals}>
                    <div><dt><span className={styles.keyViews} aria-hidden />visits</dt><dd>{count(summary.visits)}</dd></div>
                    <div><dt><span className={styles.keyVisitors} aria-hidden />unique visitors</dt><dd>{count(summary.visitors)}</dd></div>
                    <div><dt>today</dt><dd>{count(summary.today?.views ?? 0)}</dd></div>
                    {summary.busiest && (
                        <div><dt>busiest, {dayLabel(summary.busiest.date)}</dt><dd>{count(summary.busiest.views)}</dd></div>
                    )}
                </dl>
            </div>

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
        </section>
    )
}
