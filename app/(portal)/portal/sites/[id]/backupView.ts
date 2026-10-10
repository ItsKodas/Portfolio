// The Backups tab's own reasoning, kept out of the component so it can be tested without rendering
// anything, the same way deploys.ts is. Nothing here asks hostd anything.

// Types only: the schedule form is a client component and reads this file, and server/hostd/backups is
// server-only.
import type { BackupRecord, Schedule, Snapshot } from '@/server/hostd/backups'

// hostd's own rules, from hostd/src/shared/backups.ts, mirrored so the page can say why Back up now is off
// before it is pressed. hostd checks both itself, so getting these wrong costs a refusal, never a sixth copy.
const MAX_MANUAL_SNAPSHOTS = 5
const MANUAL_COOLDOWN_MS = 10 * 60_000

// Newest first. restic lists snapshots oldest first today, but nothing promises that, and a list of
// copies is read from the top.
export function newestFirst(snapshots: readonly Snapshot[]): Snapshot[] {
    return [...snapshots].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

// The run that produced a snapshot. A run records restic's full id and the list carries its short one,
// which is the full id's first eight characters, so the match is by prefix. Null for a snapshot whose run
// has fallen off the end of hostd's history.
export function runOf(snapshot: Snapshot, runs: readonly BackupRecord[]): BackupRecord | null {
    return runs.find(run => run.snapshot !== null && run.snapshot.startsWith(snapshot.id)) ?? null
}

// Why Back up now would be refused, or null when it would not. hostd's manualProblem
// (hostd/src/shared/backups.ts) is the rule, mirrored here only so the button can say why it is off before
// it is pressed; hostd checks both again. Worded for whoever is reading, client or operator alike.
export function manualBlock(snapshots: readonly Snapshot[], runs: readonly BackupRecord[], now: number): string | null {
    const manual = snapshots.filter(snapshot => snapshot.tag === 'manual')
    if (manual.length >= MAX_MANUAL_SNAPSHOTS) {
        return 'You already have five copies you made yourself. Delete one to make another.'
    }
    const recent = runs.find(run => run.tag === 'manual')
    if (recent && now - Date.parse(recent.startedAt) < MANUAL_COOLDOWN_MS) {
        return 'A copy was made less than ten minutes ago. Wait a little before making another.'
    }
    return null
}

// The newest run that failed and has not been followed by one that worked. That is the one worth a
// callout: a failure from last month with a dozen good copies since is history, not news.
export function latestFailure(runs: readonly BackupRecord[]): BackupRecord | null {
    const newest = runs[0]
    return newest && newest.outcome === 'failed' ? newest : null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function weekdayName(weekday: number): string {
    return WEEKDAYS[weekday] ?? 'Sunday'
}

export const WEEKDAY_NAMES: readonly string[] = WEEKDAYS

// "2:30 am", in Brisbane. The schedule is kept in Brisbane's time because it has no daylight saving, and
// it is said in the same words a person would use for it.
export function timeOfDay(hour: number, minute: number): string {
    const suffix = hour < 12 ? 'am' : 'pm'
    const twelve = hour % 12 === 0 ? 12 : hour % 12
    return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`
}

// The schedule as one sentence, for the line above the form
export function describeSchedule(schedule: Schedule): string {
    if (schedule.mode === 'off') return 'No automatic copies are made.'
    const at = timeOfDay(schedule.hour, schedule.minute)
    const when = schedule.mode === 'daily'
        ? `every day at ${at}`
        : `every ${weekdayName(schedule.weekday)} at ${at}`
    return `A copy is made ${when}, Brisbane time.`
}

export function describeKeep(schedule: Schedule): string {
    const { daily, weekly, monthly } = schedule.keep
    const copies = (count: number, kind: string) => `${count} ${kind} ${count === 1 ? 'copy' : 'copies'}`
    return `Keeps the last ${copies(daily, 'daily')}, ${copies(weekly, 'weekly')} and ${copies(monthly, 'monthly')}.`
}
