// Backups, per project. They are not per environment: hostd only ever backs up live, so a site has one
// list of copies and one schedule. Five calls: the list, starting a run, deleting a copy, and reading and
// writing the schedule. The download is a stream and lives in openBackupDownload below.
//
// Every type here is copied from hostd's own source rather than from any description of it:
// hostd/src/shared/backups.ts for a record, a snapshot and a schedule, hostd/src/shared/protocol.ts for
// the replies and hostd/src/api/routes.ts for the routes. The backups design's own snapshot layout was
// corrected after it was built, which is exactly why the prose is not what this reads from.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import { fetchHostdStream, PROJECT_ID, type LogStream } from './logs'

export type BackupTag = 'manual' | 'scheduled'
export type BackupOutcome = 'ok' | 'failed'

// restic's short id, when it was taken and which kind it is. There is no size: `restic snapshots` does
// not report one, so hostd does not either.
export type Snapshot = { id: string, at: string, tag: BackupTag }

export type BackupRecord = {
    run: string
    tag: BackupTag
    // 'client' or 'admin' for a run somebody asked for, 'hostd' for a scheduled one. Never a name.
    actor: string
    startedAt: string
    durationMs: number
    outcome: BackupOutcome
    // The snapshot this run produced, null when it failed: a failed run never leaves one behind
    snapshot: string | null
    reason: string | null
    // A database with no dump method was stopped for a moment to copy it
    disruptive: boolean
}

export type BackupList = {
    // Newest first is not promised by restic, so callers sort for themselves
    snapshots: Snapshot[]
    // Newest first, capped by hostd at MAX_BACKUP_RECORDS
    runs: BackupRecord[]
    running: boolean
}

export type Keep = { daily: number, weekly: number, monthly: number }
export type ScheduleMode = 'off' | 'daily' | 'weekly'
// hour and minute are Brisbane's, which has no daylight saving. weekday is 0 (Sunday) to 6 and only read
// when mode is weekly.
export type Schedule = { mode: ScheduleMode, hour: number, minute: number, weekday: number, keep: Keep }

export const SCHEDULE_MODES: readonly ScheduleMode[] = ['off', 'daily', 'weekly']

// hostd's own SNAPSHOT_ID, from hostd/src/shared/protocol.ts. Checked here so a path is never built from
// something hostd's router would answer 404 to anyway.
export const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }
const NO_SNAPSHOT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such backup' }

export async function listBackups(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<BackupList>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ ok: true } & BackupList>(config, caller, `/projects/${id}/backups`, {}, fetchImpl)
    if (!result.ok) return result
    const { snapshots, runs, running } = result.value
    return { ok: true, value: { snapshots, runs, running } }
}

// Answers as soon as the run has started, with its id. A backup takes minutes and hostd's own call
// timeout is shorter than that, so the outcome lands in the list later.
export async function startBackup(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ run: string }>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ run: string }>(config, caller, `/projects/${id}/backups`, { method: 'POST' }, fetchImpl)
    return result.ok ? { ok: true, value: { run: result.value.run } } : result
}

export async function deleteBackup(
    config: HostdConfig,
    caller: Caller,
    id: string,
    snapshot: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<null>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!SNAPSHOT_ID.test(snapshot)) return NO_SNAPSHOT
    const result = await hostdRequest<unknown>(config, caller, `/projects/${id}/backups/${snapshot}`, { method: 'DELETE' }, fetchImpl)
    return result.ok ? { ok: true, value: null } : result
}

export async function getSchedule(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Schedule>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ schedule: Schedule }>(config, caller, `/projects/${id}/backups/schedule`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.schedule } : result
}

// hostd clamps the keep counts to the operator's ceiling rather than refusing them, and answers with what
// it settled on. That answer is what this hands back, so the page shows what was saved rather than what
// was asked for.
export async function setSchedule(
    config: HostdConfig,
    caller: Caller,
    id: string,
    schedule: Schedule,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Schedule>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ schedule: Schedule }>(
        config,
        caller,
        `/projects/${id}/backups/schedule`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(schedule) },
        fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.schedule } : result
}

// The archive itself, as a stream for the route handler to pipe on. No timeout, like the log stream: a
// large site's archive takes as long as it takes, and hostd ends the stream itself.
export async function openBackupDownload(
    config: HostdConfig,
    caller: Caller,
    id: string,
    snapshot: string,
    fetchImpl: typeof fetch = fetch,
): Promise<LogStream> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    if (!SNAPSHOT_ID.test(snapshot)) return { ok: false, code: 'not-found', message: 'no such backup' }
    return fetchHostdStream(config, caller, `/projects/${id}/backups/${snapshot}/download`, fetchImpl)
}
