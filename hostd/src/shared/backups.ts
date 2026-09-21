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

export const SCHEDULE_MODES = ['off', 'daily', 'weekly'] as const
export type ScheduleMode = typeof SCHEDULE_MODES[number]
// weekday is 0 (Sunday) to 6, read in Brisbane's own week, and is ignored unless mode is weekly.
export type Schedule = { mode: ScheduleMode, hour: number, minute: number, weekday: number, keep: Keep }

// Australia/Brisbane is UTC+10 all year. The design chose it for exactly that: no daylight saving means
// no slot that is skipped and none that happens twice, and a fixed offset needs no timezone database.
export const BRISBANE_OFFSET_MS = 10 * 60 * 60_000

// A schedule that has never run fires for a slot that has only just passed, not for every slot in
// the past. Without this, a project with no run history (a schedule just switched on, or a history
// file that could not be read, which the store deliberately tolerates by starting empty) would fire
// the moment it was first seen, and an unreadable history would start a backup on every scheduled
// project at once.
export const FIRST_RUN_GRACE_MS = 60 * 60_000

export function defaultSchedule(): Schedule {
    return { mode: 'off', hour: 2, minute: 0, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } }
}

const isWhole = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

function parseKeep(raw: unknown): Keep | null {
    if (!raw || typeof raw !== 'object') return null
    const { daily, weekly, monthly } = raw as Record<string, unknown>
    if (!isWhole(daily, 0, 3650) || !isWhole(weekly, 0, 520) || !isWhole(monthly, 0, 120)) return null
    return { daily, weekly, monthly }
}

// max is the project's registry ceiling: a client may ask for less than the operator allows, never more,
// and asking for more is clamped rather than refused so the portal can say what it settled on.
export function parseSchedule(raw: unknown, max: Keep): { ok: true, schedule: Schedule } | { ok: false, problem: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, problem: 'a schedule must be an object' }
    const { mode, hour, minute, weekday, keep } = raw as Record<string, unknown>
    if (typeof mode !== 'string' || !(SCHEDULE_MODES as readonly string[]).includes(mode)) {
        return { ok: false, problem: `mode must be one of ${SCHEDULE_MODES.join(', ')}` }
    }
    if (!isWhole(hour, 0, 23)) return { ok: false, problem: 'hour must be a whole number from 0 to 23' }
    if (!isWhole(minute, 0, 59)) return { ok: false, problem: 'minute must be a whole number from 0 to 59' }
    if (!isWhole(weekday, 0, 6)) return { ok: false, problem: 'weekday must be a whole number from 0 (Sunday) to 6' }
    const parsedKeep = parseKeep(keep)
    if (!parsedKeep) return { ok: false, problem: 'keep must hold whole daily, weekly and monthly counts' }
    return { ok: true, schedule: { mode: mode as ScheduleMode, hour, minute, weekday, keep: clampKeep(parsedKeep, max) } }
}

// The most recent moment this schedule should have fired at or before `now`, or null if it never has.
function slotBefore(schedule: Schedule, now: number): number | null {
    const local = new Date(now + BRISBANE_OFFSET_MS)
    const slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), schedule.hour, schedule.minute) - BRISBANE_OFFSET_MS
    const today = slot <= now ? slot : slot - 24 * 60 * 60_000
    if (schedule.mode === 'daily') return today
    // Weekly: walk back to the most recent occurrence of its weekday, at most seven days.
    for (let days = 0; days < 7; days += 1) {
        const candidate = today - days * 24 * 60 * 60_000
        if (new Date(candidate + BRISBANE_OFFSET_MS).getUTCDay() === schedule.weekday) return candidate
    }
    return null
}

// True when the slot this schedule last passed has not been run yet. Comparing against the last run,
// rather than against a tick, is what makes a slot missed while api was down run once at startup and
// exactly once: a run at 03:00 for the 02:30 slot still satisfies it.
export function isDue(schedule: Schedule, lastRunAt: number | null, now: number): boolean {
    if (schedule.mode === 'off') return false
    const slot = slotBefore(schedule, now)
    if (slot === null) return false
    // No history: the slot must be recent, not any slot in the past. See FIRST_RUN_GRACE_MS.
    if (lastRunAt === null) return now - slot <= FIRST_RUN_GRACE_MS
    return lastRunAt < slot
}
