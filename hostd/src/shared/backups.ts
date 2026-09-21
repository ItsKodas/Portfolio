// What one backup run leaves behind, and the rules over a project's runs and snapshots. Pure: the store
// beside it (in agent/backup-state.ts) is what puts this on disk, and restic is what holds the snapshots
// themselves. Nothing here ever holds a password, a repository path or a dump's output, because a client
// is allowed to read this history for their own site.

import type { Keep } from './registry.ts'
import type { DiskUsage } from './system.ts'

// Five is the design's cap, and it is a cap on snapshots rather than runs: a failed run leaves nothing
// behind to delete, so it must not consume a slot.
export const MAX_MANUAL_SNAPSHOTS = 5
export const MANUAL_COOLDOWN_MS = 10 * 60_000
// Enough for the portal to draw a history without this file growing without bound.
export const MAX_BACKUP_RECORDS = 20
// A run is refused below this, so a backup can never be the thing that fills the disk it is written to.
export const MIN_FREE_FRACTION = 0.1

export const BACKUP_TAGS = ['manual', 'scheduled'] as const
export type BackupTag = typeof BACKUP_TAGS[number]
export type BackupOutcome = 'ok' | 'failed'

// What restic knows about a snapshot, narrowed to what the portal shows. The id is restic's own short id.
export type Snapshot = { id: string, at: string, tag: BackupTag, sizeBytes: number | null }

export type BackupRecord = {
    run: string
    tag: BackupTag
    // 'client', 'admin' or 'hostd' for a scheduled run: the agent never learns which user that was, and
    // the audit log in api is where that is recorded.
    actor: string
    startedAt: string
    durationMs: number
    outcome: BackupOutcome
    // The snapshot this run produced, or null when it failed. A failed run never names one, because a
    // snapshot missing its database looks like protection.
    snapshot: string | null
    reason: string | null
    // A generic-engine dump stopped a database service to copy it. The portal says so.
    disruptive: boolean
}

export type ProjectBackups = { runs: BackupRecord[] }

export function emptyBackups(): ProjectBackups {
    return { runs: [] }
}

export function recordBackup(state: ProjectBackups, record: BackupRecord): ProjectBackups {
    return { runs: [record, ...state.runs].slice(0, MAX_BACKUP_RECORDS) }
}

// The operator's signal: the newest scheduled run, if it failed. A later success clears it, and a failed
// manual run never raises it, because a person is already watching that one.
export function lastScheduledFailure(state: ProjectBackups): BackupRecord | null {
    const newest = state.runs.find(run => run.tag === 'scheduled')
    return newest && newest.outcome === 'failed' ? newest : null
}

export function clampKeep(wanted: Keep, max: Keep): Keep {
    const bound = (value: number, ceiling: number) => Math.max(0, Math.min(Math.trunc(value), ceiling))
    return { daily: bound(wanted.daily, max.daily), weekly: bound(wanted.weekly, max.weekly), monthly: bound(wanted.monthly, max.monthly) }
}

export function manualProblem(snapshots: readonly Snapshot[], runs: readonly BackupRecord[], now: number): string | null {
    const manual = snapshots.filter(snapshot => snapshot.tag === 'manual')
    if (manual.length >= MAX_MANUAL_SNAPSHOTS) {
        return 'there are already five manual backups; delete one before taking another'
    }
    const recent = runs.find(run => run.tag === 'manual')
    if (recent && now - Date.parse(recent.startedAt) < MANUAL_COOLDOWN_MS) {
        return 'a manual backup was taken less than 10 minutes ago; wait before taking another'
    }
    return null
}

export function diskProblem(disk: DiskUsage | null): string | null {
    if (!disk) return 'the backup disk could not be read'
    if (disk.totalBytes <= 0) return 'the backup disk could not be read'
    return disk.freeBytes / disk.totalBytes < MIN_FREE_FRACTION
        ? 'the backup disk has less than 10% free'
        : null
}
