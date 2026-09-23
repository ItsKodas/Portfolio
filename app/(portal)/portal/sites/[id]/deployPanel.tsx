// The Deploys tab. A server component: hostd is asked here, the caller is worked out from the session
// here, and which environment is open is part of the URL rather than client state, so the panel reloads
// and can be linked to.
//
// It re-derives the caller rather than trusting the page that rendered it, the same way env.tsx does.
// Reading a deploy history is not admin-only (hostd's 'deploy-read' policy verb lets an owner read their
// own), so what changes between the two is what is shown, not whether anything is.

import { readHostd } from '@/server/hostd/config'
import { listDeploys, type DeployRecord } from '@/server/hostd/deploys'
import type { EnvironmentName } from '@/server/hostd/env'
import { forAdmin, forClient } from '@/server/hostd/errors'
import type { Environment } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { KeyValue } from '@/ui/KeyValue/KeyValue'
import { Row } from '@/ui/Row/Row'
import { DeployControls } from './deployControls'
import { DeployLog } from './deployLog'
import { formatDuration, outcomeTone, outcomeWord, rollbackTarget, shortCommit, updatesFor } from './deploys'
import { EnvSwitcher } from './envSwitcher'
import { formatDay, formatWhen } from '../../format'
import styles from './site.module.css'

// What hostd calls a deploy nobody asked for: its poller noticing a push. Every other trigger is a
// person, and saying "hostd" where a name would go is more honest than inventing one.
const BY_HOSTD = 'hostd'

function when(iso: string): string {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : formatWhen(at)
}

function day(iso: string): string {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : formatDay(at)
}

// One row of the operator's history. The reason and the output hang under the row rather than inside it:
// a build that failed is the one row anybody opens, and a summary that has to be clicked is better than
// six lines of build output in a list of twenty deploys.
function Deploy({ record }: { record: DeployRecord }) {
    // ui/Row's meta column is 58px of tabular figures, which a duration fits and a date does not, so the
    // date goes in the wider aside beside it.
    const by = record.actor === BY_HOSTD ? `${record.trigger}, by hostd` : `${record.trigger}, by hand`
    return (
        <div className={styles.deploy}>
            <Row
                tone={record.outcome === 'failed' ? 'crit' : undefined}
                lead={<Chip tone={outcomeTone(record.outcome)}>{outcomeWord(record.outcome)}</Chip>}
                title={record.subject ?? <span className={styles.empty}>no commit subject</span>}
                sub={<><span className={styles.mono}>{shortCommit(record.commit)}</span>{` ${by}`}</>}
                aside={when(record.startedAt)}
                meta={formatDuration(record.durationMs)}
            />
            {record.reason && <p className={styles.note}>{record.reason}</p>}
            {record.output && (
                <details className={styles.outputBlock}>
                    <summary>Show what it printed</summary>
                    <pre>{record.output}</pre>
                </details>
            )}
        </div>
    )
}

type Props = {
    id: string
    environments: Environment[]
    environment: EnvironmentName
    // Whether hostd would accept a deploy at all. It checks this itself and the action checks it again;
    // this only decides whether the buttons look available.
    enabled: boolean
}

export async function DeployPanel({ id, environments, environment, enabled }: Props) {
    const who = await callerFromSession()
    if (!who) return null
    const isAdmin = who.clientId === null

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        return isAdmin
            ? <Callout tone="warn" title="hostd is not configured">{problems.join('; ')}</Callout>
            : <Callout tone="warn" title="Not available">{forClient('unavailable')}</Callout>
    }

    const history = await listDeploys(config, who.caller, id, environment)
    if (!history.ok) {
        return (
            <>
                <EnvSwitcher id={id} tab="deploys" environments={environments} chosen={environment} />
                <Callout tone="warn" title="The deploy history could not be read">
                    {isAdmin ? forAdmin(history.code, history.message) : forClient(history.code)}
                </Callout>
            </>
        )
    }

    const view = history.value

    // A client is shown what reached their site and stayed there, and in days rather than minutes. No
    // commits, no branch, no failures: a build that fell over is our problem, and from outside the
    // machine it never happened. The operator's list below it has all three outcomes.
    if (!isAdmin) {
        const updates = updatesFor(view)
        return (
            <section className={styles.block}>
                <h2>Recent updates</h2>
                {updates.length === 0
                    ? <p className={styles.empty}>Nothing has been updated yet.</p>
                    : updates.map(update => (
                        <Row key={`${update.commit}-${update.startedAt}`} title={day(update.startedAt)} />
                    ))}
                <p className={styles.note}>
                    Each of these is a change that went live on your site. Ask Koda if you want to know
                    what was in one of them.
                </p>
            </section>
        )
    }

    const target = rollbackTarget(view)
    const latest = view.deploys[0]?.startedAt ?? null

    return (
        <>
            <EnvSwitcher id={id} tab="deploys" environments={environments} chosen={environment} />

            {/* The history beside what a deploy of this environment is doing right now. The column is
                always here, not only while a deploy runs: see site.module.css on .deployLayout for why. */}
            <div className={styles.deployLayout}>
                <div className={styles.deployMain}>
                    <KeyValue pairs={[
                        { key: 'branch', value: view.branch ?? 'none set' },
                        { key: 'serving', value: view.deployed ? shortCommit(view.deployed) : 'nothing yet' },
                        {
                            key: 'polling',
                            value: view.paused ? 'paused' : 'every two minutes',
                            tone: view.paused ? 'warn' : undefined,
                        },
                    ]} />

                    {view.paused && (
                        <div className={styles.said}>
                            <Callout tone="warn" title="Deploys are paused">
                                {view.consecutiveFailures} in a row went wrong, so hostd stopped polling this
                                branch: rebuilding a broken branch every two minutes helps nobody. Deploying by
                                hand or switching branch starts it again.
                            </Callout>
                        </div>
                    )}

                    <DeployControls
                        id={id}
                        environment={environment}
                        enabled={enabled}
                        branch={view.branch}
                        rollbackTo={target}
                        latest={latest}
                    />

                    <section className={`${styles.block} ${styles.history}`}>
                        <h2>History</h2>
                        {/* Scrolls on its own on a wide window, so the controls above it stay put */}
                        <div className={styles.historyList}>
                            {view.deploys.length === 0
                                ? <p className={styles.empty}>
                                    Nothing has been deployed yet. hostd keeps the last twenty, newest first.
                                </p>
                                : view.deploys.map(record => (
                                    <Deploy key={`${record.commit}-${record.startedAt}`} record={record} />
                                ))}
                        </div>
                    </section>
                </div>

                <DeployLog id={id} environment={environment} />
            </div>
        </>
    )
}
