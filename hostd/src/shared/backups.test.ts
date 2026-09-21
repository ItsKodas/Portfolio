import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    MAX_BACKUP_RECORDS, MANUAL_COOLDOWN_MS, clampKeep, diskProblem, emptyBackups, lastScheduledFailure,
    manualProblem, recordBackup, defaultSchedule, isDue, parseSchedule, type BackupRecord, type Snapshot, type Schedule,
} from './backups.ts'

const AT = Date.parse('2026-09-21T02:00:00.000Z')

const record = (over: Partial<BackupRecord> = {}): BackupRecord => ({
    run: 'a1b2c3d4', tag: 'manual', actor: 'client', startedAt: new Date(AT).toISOString(),
    durationMs: 1000, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false, ...over,
})

const snapshot = (id: string, tag: Snapshot['tag']): Snapshot => ({ id, at: new Date(AT).toISOString(), tag, sizeBytes: null })

describe('recordBackup', () => {
    it('keeps the newest records first and caps the history', () => {
        let state = emptyBackups()
        for (let index = 0; index < MAX_BACKUP_RECORDS + 5; index += 1) state = recordBackup(state, record({ run: `run${index}` }))
        assert.equal(state.runs.length, MAX_BACKUP_RECORDS)
        assert.equal(state.runs[0]?.run, `run${MAX_BACKUP_RECORDS + 4}`)
    })
})

describe('lastScheduledFailure', () => {
    it('finds a failed scheduled run and ignores manual ones', () => {
        const state = recordBackup(
            recordBackup(emptyBackups(), record({ tag: 'scheduled', outcome: 'failed', reason: 'the dump failed', snapshot: null })),
            record({ tag: 'manual', outcome: 'failed', reason: 'also failed', snapshot: null }),
        )
        assert.equal(lastScheduledFailure(state)?.reason, 'the dump failed')
    })

    it('is null once a later scheduled run succeeded', () => {
        const state = recordBackup(
            recordBackup(emptyBackups(), record({ tag: 'scheduled', outcome: 'failed', snapshot: null })),
            record({ tag: 'scheduled', outcome: 'ok' }),
        )
        assert.equal(lastScheduledFailure(state), null)
    })
})

describe('manualProblem', () => {
    it('allows a manual run when there is room and no recent one', () => {
        assert.equal(manualProblem([snapshot('aa', 'manual')], [], AT), null)
    })

    it('refuses a sixth manual snapshot', () => {
        const snapshots = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => snapshot(id, 'manual'))
        assert.match(manualProblem(snapshots, [], AT) ?? '', /five manual backups/)
    })

    it('does not count scheduled snapshots towards the cap', () => {
        const snapshots = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => snapshot(id, 'scheduled'))
        assert.equal(manualProblem(snapshots, [], AT), null)
    })

    it('refuses a second manual run inside the cooldown, and allows one after it', () => {
        const runs = [record({ startedAt: new Date(AT - 60_000).toISOString() })]
        assert.match(manualProblem([], runs, AT) ?? '', /10 minutes/)
        assert.equal(manualProblem([], runs, AT + MANUAL_COOLDOWN_MS), null)
    })

    it('ignores scheduled runs when measuring the cooldown', () => {
        const runs = [record({ tag: 'scheduled', startedAt: new Date(AT - 60_000).toISOString() })]
        assert.equal(manualProblem([], runs, AT), null)
    })
})

describe('clampKeep', () => {
    it('holds a client under the operator ceiling and never below zero', () => {
        const max = { daily: 14, weekly: 8, monthly: 12 }
        assert.deepEqual(clampKeep({ daily: 30, weekly: 2, monthly: -1 }, max), { daily: 14, weekly: 2, monthly: 0 })
    })
})

describe('diskProblem', () => {
    it('refuses under a tenth free, allows at a tenth, and refuses an unreadable disk', () => {
        assert.match(diskProblem({ path: '/backups', totalBytes: 1000, usedBytes: 940, freeBytes: 60 }) ?? '', /10% free/)
        assert.equal(diskProblem({ path: '/backups', totalBytes: 1000, usedBytes: 900, freeBytes: 100 }), null)
        assert.match(diskProblem(null) ?? '', /could not be read/)
    })

    it('refuses a zero-total disk', () => {
        assert.match(diskProblem({ path: '/backups', totalBytes: 0, usedBytes: 0, freeBytes: 0 }) ?? '', /could not be read/)
    })
})

// 12:00 UTC is 22:00 in Brisbane on the same day. Every expectation below is written in UTC.
const at = (iso: string) => Date.parse(iso)
const daily = (over: Partial<Schedule> = {}): Schedule =>
    ({ ...defaultSchedule(), mode: 'daily', hour: 2, minute: 30, ...over })

describe('parseSchedule', () => {
    it('reads a valid schedule and clamps its retention to the project ceiling', () => {
        const max = { daily: 14, weekly: 8, monthly: 12 }
        const parsed = parseSchedule({ mode: 'weekly', hour: 3, minute: 0, weekday: 6, keep: { daily: 99, weekly: 4, monthly: 1 } }, max)
        assert.deepEqual(parsed, { ok: true, schedule: { mode: 'weekly', hour: 3, minute: 0, weekday: 6, keep: { daily: 14, weekly: 4, monthly: 1 } } })
    })

    it('refuses anything that is not a schedule', () => {
        const max = { daily: 14, weekly: 8, monthly: 12 }
        assert.equal(parseSchedule({ mode: 'hourly', hour: 2, minute: 0, weekday: 0, keep: max }, max).ok, false)
        assert.equal(parseSchedule({ mode: 'daily', hour: 24, minute: 0, weekday: 0, keep: max }, max).ok, false)
        assert.equal(parseSchedule({ mode: 'daily', hour: 2, minute: 60, weekday: 0, keep: max }, max).ok, false)
        assert.equal(parseSchedule({ mode: 'weekly', hour: 2, minute: 0, weekday: 7, keep: max }, max).ok, false)
        assert.equal(parseSchedule('daily', max).ok, false)
    })
})

describe('isDue', () => {
    it('never fires while the schedule is off', () => {
        assert.equal(isDue(defaultSchedule(), null, at('2026-09-21T16:30:00Z')), false)
    })

    it('fires once the local time has passed and never twice for the same slot', () => {
        // 02:30 Brisbane on the 22nd is 16:30 UTC on the 21st.
        const schedule = daily()
        assert.equal(isDue(schedule, null, at('2026-09-21T16:29:00Z')), false)
        assert.equal(isDue(schedule, null, at('2026-09-21T16:31:00Z')), true)
        assert.equal(isDue(schedule, at('2026-09-21T16:31:00Z'), at('2026-09-21T17:00:00Z')), false)
        // The next day's slot.
        assert.equal(isDue(schedule, at('2026-09-21T16:31:00Z'), at('2026-09-22T16:31:00Z')), true)
    })

    it('catches up a slot that passed while api was down', () => {
        assert.equal(isDue(daily(), at('2026-09-20T16:31:00Z'), at('2026-09-21T22:00:00Z')), true)
    })

    it('fires weekly only on its weekday', () => {
        // 2026-09-21 is a Monday in Brisbane, so weekday 1.
        const monday = daily({ mode: 'weekly', weekday: 1 })
        assert.equal(isDue(monday, null, at('2026-09-20T16:31:00Z')), true)
        assert.equal(isDue(daily({ mode: 'weekly', weekday: 3 }), null, at('2026-09-20T16:31:00Z')), false)
    })

    it('does not fire for an old slot when the schedule has never run', () => {
        // Two hours after the slot, with no history: the backlog is not owed, so it waits for the next one.
        assert.equal(isDue(daily(), null, at('2026-09-21T18:31:00Z')), false)
    })
})
