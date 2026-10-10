// The Backups tab. A server component: hostd is asked here and the caller is worked out from the session
// here, the same way deployPanel.tsx does it, so nothing the page was handed decides who hostd is asked as.
//
// Backups are the client's as well as the operator's. hostd's backup-read and backup policy verbs let an
// owner list, run, delete, download and schedule their own site's copies, so both roles get the same
// controls; what changes is how much of the machinery is named. A client reads "copies" and days, the
// operator also gets restic's ids, who started each run and hostd's own reasons.
//
// Putting a copy back over live is the operator's alone (hostd's backup-restore verb is admin-only): each
// copy gets a Restore button for the operator, behind a typed confirmation, and a client is told to ask.

import {
    listBackups, listRestores, getSchedule, type BackupList, type BackupRecord, type Restores, type Schedule,
    type Snapshot,
} from '@/server/hostd/backups'
import { readHostd } from '@/server/hostd/config'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { Row } from '@/ui/Row/Row'
import { BackupControls, BackupRowActions } from './backupControls'
import { RestoreButton, RestoreStatus } from './restoreControls'
import { ScheduleForm } from './scheduleForm'
import { latestFailure, manualBlock, newestFirst, runOf } from './backupView'
import { formatDuration } from './deploys'
import { formatWhen } from '../../format'
import styles from './site.module.css'

function when(iso: string): string {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : formatWhen(at)
}

// Who made a copy, in the reader's own terms. hostd records the kind of caller and never the person.
function madeBy(record: BackupRecord | null, snapshot: Snapshot, isAdmin: boolean): string {
    if (snapshot.tag === 'scheduled') return 'automatic'
    if (!record) return 'made by hand'
    if (record.actor === 'client') return isAdmin ? 'made by the client' : 'made by you'
    if (record.actor === 'admin') return isAdmin ? 'made by you' : 'made by Koda'
    return 'made by hand'
}

type CopyProps = {
    id: string
    snapshot: Snapshot
    record: BackupRecord | null
    isAdmin: boolean
    // The operator's restore: the site's name to type back, and why it is refused right now. null for a
    // client, or when hostd's restores could not be read.
    restore: { name: string, block: string | null } | null
}

function Copy({ id, snapshot, record, isAdmin, restore }: CopyProps) {
    const label = when(snapshot.at)
    return (
        <div className={styles.backup}>
            <div className={styles.backupRow}>
                <Row
                    lead={<Chip>{snapshot.tag === 'scheduled' ? 'automatic' : 'by hand'}</Chip>}
                    title={label}
                    sub={isAdmin
                        ? <><span className={styles.mono}>{snapshot.id}</span>{` ${madeBy(record, snapshot, isAdmin)}`}</>
                        : madeBy(record, snapshot, isAdmin)}
                    meta={record ? formatDuration(record.durationMs) : undefined}
                />
                <BackupRowActions id={id} snapshot={snapshot.id} label={label}>
                    {restore && <RestoreButton id={id} name={restore.name} snapshot={snapshot.id} label={label} block={restore.block} />}
                </BackupRowActions>
            </div>
            {record?.disruptive && (
                <p className={styles.note}>
                    {isAdmin
                        ? 'A database with no dump method was stopped for a moment to copy it.'
                        : 'Part of your site paused for a moment while this copy was made.'}
                </p>
            )}
        </div>
    )
}

// What the operator sees of a run that failed. A client is told it did not work and that their earlier
// copies are fine, never hostd's reason: that names paths and services on the dedi.
function Failure({ record, isAdmin }: { record: BackupRecord, isAdmin: boolean }) {
    return (
        <div className={styles.said}>
            <Callout tone="warn" title="The last copy did not work">
                {isAdmin
                    ? `${record.tag} run at ${when(record.startedAt)}: ${record.reason ?? 'no reason was recorded'}. `
                        + 'A failed run leaves no copy behind, and earlier ones are untouched.'
                    : 'Nothing was saved from it, and your earlier copies are untouched.'}
            </Callout>
        </div>
    )
}

type Props = {
    id: string
    // The site's name, which the operator types back to restore a copy
    name: string
}

export async function BackupPanel({ id, name }: Props) {
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

    // Two reads, side by side: the schedule lives in hostd's api and the copies in its agent, so either
    // can fail without the other, and each says so in its own place.
    // The operator also reads the restores; hostd refuses them to a client.
    const [listed, scheduled, restored] = await Promise.all([
        listBackups(config, who.caller, id),
        getSchedule(config, who.caller, id),
        isAdmin ? listRestores(config, who.caller, id) : Promise.resolve(null),
    ])

    if (!listed.ok) {
        return (
            <Callout tone="warn" title="The backups could not be read">
                {isAdmin ? forAdmin(listed.code, listed.message) : forClient(listed.code)}
            </Callout>
        )
    }

    const view: BackupList = listed.value
    const copies = newestFirst(view.snapshots)
    const failure = latestFailure(view.runs)
    const block = manualBlock(view.snapshots, view.runs, Date.now())
    const schedule: Schedule | null = scheduled.ok ? scheduled.value : null
    const restores: Restores | null = restored?.ok ? restored.value : null
    const restoreBlock = restores?.running
        ? 'A copy is being put back right now.'
        : view.running ? 'A copy is being made right now.' : null
    const scheduleError = scheduled.ok
        ? null
        : isAdmin ? forAdmin(scheduled.code, scheduled.message) : forClient(scheduled.code)

    return (
        <div>
            <div className={styles.deployStatus}>
                <dl className={styles.facts}>
                    <div className={styles.fact}>
                        <dt>Last copy</dt>
                        <dd>{copies[0] ? when(copies[0].at) : 'none yet'}</dd>
                    </div>
                    <div className={styles.fact}>
                        <dt>Automatic</dt>
                        <dd>{schedule ? (schedule.mode === 'off' ? 'off' : schedule.mode) : 'not available'}</dd>
                    </div>
                    <div className={styles.fact}>
                        <dt>Copies kept</dt>
                        <dd>{copies.length}</dd>
                    </div>
                </dl>

                {failure && <Failure record={failure} isAdmin={isAdmin} />}

                {restores && <RestoreStatus id={id} restores={restores.restores} running={restores.running} />}
                {restored && !restored.ok && (
                    <div className={styles.said}>
                        <Callout tone="warn" title="Restores could not be read">
                            {forAdmin(restored.code, restored.message)}
                        </Callout>
                    </div>
                )}

                <BackupControls id={id} block={block} running={view.running} latest={view.runs[0]?.run ?? null} />
            </div>

            <section className={styles.history}>
                <h2>
                    Copies
                    {copies.length > 0 && <span className={styles.count}>{copies.length}</span>}
                </h2>
                {copies.length === 0
                    ? <p className={styles.empty}>There are no copies yet.</p>
                    : copies.map(snapshot => (
                        <Copy
                            key={snapshot.id}
                            id={id}
                            snapshot={snapshot}
                            record={runOf(snapshot, view.runs)}
                            isAdmin={isAdmin}
                            restore={restores ? { name, block: restoreBlock } : null}
                        />
                    ))}
                <p className={styles.note}>
                    Each copy holds your site&apos;s databases and the files it stores, such as uploads. Your
                    code and settings are not in it. Copies you make yourself are kept until you delete them,
                    up to five at a time; automatic ones are cleared out as the schedule below says.
                </p>
            </section>

            <section className={styles.block}>
                <h2>Automatic copies</h2>
                {schedule
                    ? <ScheduleForm id={id} schedule={schedule} />
                    : <Callout tone="warn" title="The schedule could not be read">{scheduleError}</Callout>}
            </section>

            <section className={styles.block}>
                <h2>Putting a copy back</h2>
                <p className={styles.note}>
                    Putting a copy back replaces everything your site has saved since. {isAdmin
                        ? 'Restore on a copy above does it for the live site: you type the site\'s name to confirm, '
                            + 'a fresh copy of live is made first, and the site is paused while its databases and '
                            + 'stored files are replaced. Sites without a known engine are still the runbook '
                            + 'procedure in hostd/RUNBOOK.md.'
                        : 'Ask Koda, who does it and checks it with you first.'}
                </p>
                <p className={styles.note}>
                    Only the live site is backed up. Test and staging environments are not.
                    {isAdmin && ' Copies are kept on the dedi itself for now: there is no offsite copy yet, so a lost dedi takes them with it.'}
                </p>
            </section>
        </div>
    )
}
