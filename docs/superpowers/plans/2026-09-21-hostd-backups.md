# hostd Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every registered project a local restic repository, a dump of each of its databases, manual and scheduled runs with retention, and snapshots a client can list, delete and download.

**Architecture:** The agent does the work and owns the run history, in `backups.json` beside `deploys.json` in its state volume. A run takes a per-project lock and a dedi-wide lock, dumps each database through a new `docker exec` into a staging directory, then captures staging plus the storage directories in one `restic backup`. A run is started and not awaited, exactly like a deploy, and api replies 202 with a run id. The schedule is client-set configuration, so it lives in api's `/state` and api's one-minute tick turns a due schedule into a run. Every side effect (restic, Docker, compose, the clock, the filesystem, the disk) is an injected adapter, so the whole suite runs with no restic binary, no Docker and no disk.

**Tech Stack:** Node 22 ESM with tsx, TypeScript, `node --test`, restic, the Docker Engine API over its socket, the Docker Compose CLI.

**Spec:** `docs/superpowers/specs/2026-09-21-hostd-backups-design.md`. Read it before starting any task, along with the **Backups** section of `docs/superpowers/specs/2026-09-20-hostd-design.md` (which it narrows) and the phase 1 sections on the registry, the actor, the two layers of enforcement and the locks.

## Global Constraints

- **No em dashes** (U+2014) in any non-comment text: docs, the runbook, commit messages, PR descriptions. Code comments are exempt.
- **Code style:** 4-space indentation, no semicolons, single quotes, comments that say why. Files sit beside their tests (`x.ts`, `x.test.ts`).
- **Tests:** `node --test` via tsx, `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`. No mocking library: fake the I/O boundary with plain object literals and a local `setup()` factory. Build registries by calling the real `parseRegistry()` on inline YAML.
- **Failures are collected and returned, never thrown.** A run that fails returns a record saying so.
- **The agent repeats every check itself.** Nothing api decided lets the agent skip `checkStructure`, the capability check, the locks or the disk check.
- **Paths never come from the portal.** Every path restic, Docker or the filesystem sees is derived from the registry entry the structural check returned.
- **No value from a request ever reaches a command.** Dump commands are fixed strings; the only registry-driven substitutions are environment variable *names*, validated against `/^[A-Z][A-Z0-9_]*$/`.
- **Secrets never reach a log, an audit entry, an error message or a backup record.** That covers database passwords, `RESTIC_PASSWORD` and anything a command's stderr might carry.
- **A failed dump fails the whole run and records no snapshot.**
- **Live only.** Every path a run reads comes from `environmentOf(project, 'live')` or `project.storage`. Nothing here ever reads the test environment.
- **Commits** end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run everything from `hostd/`: `npm test`, `npm run typecheck`.

## What the design leaves for this plan to decide

Three things the design does not pin down, decided here once rather than guessed at per task.

1. **The agent's stream channel is NDJSON of `LogLine`, and a download is binary.** `Outcome` in `src/agent/agent.ts` has `reply` and `stream`, and `server.ts` writes one JSON line per log line. A tar.gz cannot go down that channel without base64, which would inflate a multi-gigabyte download by a third. Task 9 adds a third outcome, `bytes`: the same `{ ok: true, stream: true }` header line, then raw bytes until the socket ends. api relays those bytes straight into the HTTP response.
2. **`Runner` captures output as text and caps it**, so it cannot carry a dump or a tar. Restic's `dump` and every database dump therefore use a second adapter, `SpawnStream`, which returns stdout as a `Readable` and collects stderr as text. `Runner` stays exactly as it is for every command whose output is small.
3. **Which user the SQL dumps run as.** `--all-databases` needs a superuser, and compose images name that user's credentials differently per engine. The defaults are per engine (postgres `POSTGRES_USER`; mysql user `root` with `MYSQL_ROOT_PASSWORD`; mariadb user `root` with `MARIADB_ROOT_PASSWORD`; mongodb `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD`), and the registry's `dump: { userEnv, passwordEnv }` overrides the *names* for anything that differs. The runbook says so.

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/shared/backups.ts` (new) | The run record, the snapshot and schedule types, and every pure rule over them: the manual cap, the cooldown, retention clamping, the disk threshold, and when a schedule is due |
| `src/agent/backup-state.ts` (new) | The run history on disk: one JSON file, loaded at boot, written atomically per change |
| `src/agent/docker.ts` (modify) | `exec`: create, start, and stream the demultiplexed output |
| `src/agent/restic.ts` (new) | Restic argv builders and the adapter over them, including the streaming dump |
| `src/agent/backup-dumps.ts` (new) | The dump plan per engine (pure) and running one into staging |
| `src/agent/backup-run.ts` (new) | One run end to end: disk, staging, dumps, `restic backup`, retention, cleanup, record |
| `src/agent/backup-runner.ts` (new) | Starts a run without awaiting it, and holds the per-project and dedi-wide locks |
| `src/shared/protocol.ts` (modify) | The `backup` verb, its actions, its replies and its capability |
| `src/agent/agent.ts` (modify) | The verb handler, and the `bytes` outcome |
| `src/agent/server.ts` (modify) | Writing a `bytes` outcome, and the log line for the verb |
| `src/api/agent-client.ts` (modify) | `download()`, the client half of the `bytes` channel |
| `src/api/policy.ts` (modify) | `backup` and `backup-read` |
| `src/api/schedule.ts` (new) | Schedules in `/state`, the one-minute tick, and catch-up at startup |
| `src/api/routes.ts` (modify) | The seven endpoints, and the download relay |
| `src/agent/index.ts` (modify) | Wiring: the backup directory, the store, the runner, the weekly prune |
| `src/api/index.ts` (modify) | Wiring: the schedule store and its tick |
| `docker-compose.yml`, `Dockerfile`, `example.env.agent`, `.gitignore`, `RUNBOOK.md` | The backup mount, restic and sqlite in the image, `RESTIC_PASSWORD`, and how to operate and restore |

---

### Task 1: The run record, the snapshot, and the pure rules

**Files:**
- Create: `src/shared/backups.ts`
- Test: `src/shared/backups.test.ts`

**Interfaces:**
- Consumes: `Keep` from `src/shared/registry.ts`, `DiskUsage` from `src/shared/system.ts`
- Produces: `MAX_MANUAL_SNAPSHOTS`, `MANUAL_COOLDOWN_MS`, `MAX_BACKUP_RECORDS`, `MIN_FREE_FRACTION`, `BackupTag`, `Snapshot`, `BackupRecord`, `ProjectBackups`, `emptyBackups()`, `recordBackup()`, `lastScheduledFailure()`, `clampKeep()`, `manualProblem()`, `diskProblem()`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    MAX_BACKUP_RECORDS, MANUAL_COOLDOWN_MS, clampKeep, diskProblem, emptyBackups, lastScheduledFailure,
    manualProblem, recordBackup, type BackupRecord, type Snapshot,
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="recordBackup|manualProblem|clampKeep|diskProblem|lastScheduledFailure"`
Expected: FAIL, cannot find module `./backups.ts`.

- [ ] **Step 3: Write the implementation**

```ts
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
        return `there are already five manual backups; delete one before taking another`
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
        ? `the backup disk has less than 10% free`
        : null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/backups.ts src/shared/backups.test.ts && git commit -m "Add the backup record and the rules over it" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Schedule rules

**Files:**
- Modify: `src/shared/backups.ts`
- Test: `src/shared/backups.test.ts`

**Interfaces:**
- Consumes: `clampKeep()` from Task 1
- Produces: `SCHEDULE_MODES`, `ScheduleMode`, `Schedule`, `BRISBANE_OFFSET_MS`, `defaultSchedule()`, `parseSchedule()`, `isDue()`

Brisbane is UTC+10 all year, which is why the design chose it: a fixed offset needs no timezone database and has no hour that happens twice. `isDue` compares the local wall clock to the schedule and refuses to fire twice for the same slot, using the last run's own timestamp.

- [ ] **Step 1: Write the failing test**

```ts
import { defaultSchedule, isDue, parseSchedule, type Schedule } from './backups.ts'

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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="parseSchedule|isDue"`
Expected: FAIL, `parseSchedule is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/shared/backups.ts`:

```ts
export const SCHEDULE_MODES = ['off', 'daily', 'weekly'] as const
export type ScheduleMode = typeof SCHEDULE_MODES[number]
// weekday is 0 (Sunday) to 6, read in Brisbane's own week, and is ignored unless mode is weekly.
export type Schedule = { mode: ScheduleMode, hour: number, minute: number, weekday: number, keep: Keep }

// Australia/Brisbane is UTC+10 all year. The design chose it for exactly that: no daylight saving means
// no slot that is skipped and none that happens twice, and a fixed offset needs no timezone database.
export const BRISBANE_OFFSET_MS = 10 * 60 * 60_000

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
    return lastRunAt === null || lastRunAt < slot
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/backups.ts src/shared/backups.test.ts && git commit -m "Add the backup schedule and when it is due" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The run history on disk

**Files:**
- Create: `src/agent/backup-state.ts`
- Test: `src/agent/backup-state.test.ts`

**Interfaces:**
- Consumes: `emptyBackups()`, `recordBackup()`, `lastScheduledFailure()`, `BackupRecord`, `ProjectBackups` from `src/shared/backups.ts`
- Produces: `BackupStateFs` (same shape as `DeployStateFs`), `BackupStore` with `load()`, `warnings()`, `get(id)`, `record(id, record)`, `lastRunAt(id)`, `failures()`

This is `DeployStore` with a different payload, keyed by project id rather than by `id:environment`. Read `src/agent/deploy-state.ts` first and follow it exactly: the same atomic write with `wx` and a random suffix, the same rule that a write failure is logged rather than thrown, and the same tolerance of a missing or unreadable file.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BackupStore, type BackupStateFs } from './backup-state.ts'
import { emptyBackups, type BackupRecord } from '../shared/backups.ts'

const PATH = '/var/lib/hostd/backups.json'

const record = (over: Partial<BackupRecord> = {}): BackupRecord => ({
    run: 'a1b2c3d4', tag: 'scheduled', actor: 'hostd', startedAt: '2026-09-21T02:00:00.000Z',
    durationMs: 1000, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false, ...over,
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const fs: BackupStateFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => {
            store.set(to, store.get(from)!)
            store.delete(from)
        },
        mkdir: async () => {},
    }
    return { fs, files: store }
}

describe('BackupStore', () => {
    it('starts empty when the file does not exist yet', async () => {
        const store = new BackupStore(PATH, setup().fs)
        await store.load()
        assert.deepEqual(store.get('acme'), emptyBackups())
        assert.equal(store.lastRunAt('acme'), null)
        assert.deepEqual(store.warnings(), [])
    })

    it('writes a record and reads it back through a second store', async () => {
        const { fs, files } = setup()
        const store = new BackupStore(PATH, fs)
        await store.load()
        await store.record('acme', record())
        const second = new BackupStore(PATH, fs)
        await second.load()
        assert.equal(second.get('acme').runs.length, 1)
        assert.equal(second.lastRunAt('acme'), Date.parse('2026-09-21T02:00:00.000Z'))
        assert.equal([...files.keys()].length, 1, 'the temporary file is renamed away, not left behind')
    })

    it('warns rather than throwing when the file is unreadable', async () => {
        const store = new BackupStore(PATH, setup({ [PATH]: 'not json' }).fs)
        await store.load()
        assert.deepEqual(store.get('acme'), emptyBackups())
        assert.equal(store.warnings().length, 1)
    })

    it('reports projects whose newest scheduled run failed', async () => {
        const store = new BackupStore(PATH, setup().fs)
        await store.load()
        await store.record('acme', record({ outcome: 'failed', snapshot: null, reason: 'the dump failed' }))
        await store.record('widget', record())
        assert.deepEqual(store.failures(), ['acme: the newest scheduled backup failed: the dump failed'])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="BackupStore"`
Expected: FAIL, cannot find module `./backup-state.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// The backup run history on disk: one JSON file for every project, read once at boot and written
// atomically on every change, exactly like deploy-state.ts. Restic holds the snapshots themselves; this
// holds what happened, including the runs that produced no snapshot at all.
//
// A write that fails never costs the caller its record: the run has already happened by the time this is
// called, so the in-memory state is updated first and a failed write is a logged problem, not a thrown one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import { emptyBackups, lastScheduledFailure, recordBackup, type BackupRecord, type ProjectBackups } from '../shared/backups.ts'

export type BackupStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: BackupStateFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { projects: Record<string, ProjectBackups> }

export class BackupStore {
    private projects = new Map<string, ProjectBackups>()
    private problem: string | null = null

    constructor(
        private readonly path: string,
        private readonly fs: BackupStateFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch {
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!saved || typeof saved !== 'object' || !saved.projects) throw new Error('the file is not a backup history')
            this.projects = new Map(Object.entries(saved.projects))
        } catch (error) {
            this.problem = `the backup history at ${this.path} could not be read: ${describeError(error)}`
            this.log(`WARN ${this.problem}`)
        }
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    get(id: string): ProjectBackups {
        return this.projects.get(id) ?? emptyBackups()
    }

    // When this project last had a run of any kind start. The schedule is measured against this, so a
    // manual run also pushes the next scheduled one out, which is what the client would expect.
    lastRunAt(id: string): number | null {
        const newest = this.get(id).runs[0]
        if (!newest) return null
        const at = Date.parse(newest.startedAt)
        return Number.isFinite(at) ? at : null
    }

    // The operator's health signal, one line per project whose newest scheduled run failed.
    failures(): string[] {
        const lines: string[] = []
        for (const [id, state] of this.projects) {
            const failed = lastScheduledFailure(state)
            if (failed) lines.push(`${id}: the newest scheduled backup failed: ${failed.reason ?? 'no reason recorded'}`)
        }
        return lines
    }

    async record(id: string, record: BackupRecord): Promise<void> {
        this.projects.set(id, recordBackup(this.get(id), record))
        await this.save()
    }

    private async save(): Promise<void> {
        const saved: Saved = { projects: Object.fromEntries(this.projects) }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so the
        // temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.log(`WARN the backup history could not be written: ${describeError(error)}`)
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/backup-state.ts src/agent/backup-state.test.ts && git commit -m "Keep the backup run history beside the deploy history" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Docker exec

**Files:**
- Modify: `src/agent/docker.ts`
- Test: `src/agent/docker.test.ts`

**Interfaces:**
- Consumes: `FrameDecoder` from `src/agent/logframes.ts`, the existing `open`/`json` helpers and `checkedId()` in `docker.ts`
- Produces: `ExecResult = { exitCode: number | null, stderr: string }`, `DockerApi.exec(id: string, argv: string[], onStdout: (chunk: Buffer) => Promise<void> | void): Promise<ExecResult>`

The existing client is GET only: `open()` hardcodes `method: 'GET'` and sends no body. Exec needs two POSTs, so this adds a `post<T>(path, body)` helper beside `json<T>(path)` and a raw POST that returns the upgraded stream. stdout is handed to the caller chunk by chunk (it becomes a dump, which can be gigabytes and must never be buffered); stderr is collected as text, capped, and is what explains a failure.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/docker.test.ts`, following the fake `request` function the file already uses for `logs`:

```ts
import { PassThrough } from 'node:stream'
import { createDockerApi } from './docker.ts'

const ID = 'a'.repeat(64)

// One multiplexed frame, exactly as Docker writes them: type, three zero bytes, a big-endian length.
function frame(type: 1 | 2, text: string): Buffer {
    const payload = Buffer.from(text)
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
}

function execSetup(options: { exitCode: number, frames: Buffer[] }) {
    const calls: Array<{ path: string, method: string, body: string }> = []
    const request = (opts: any, callback: (response: any) => void) => {
        let body = ''
        const response = new PassThrough() as any
        response.statusCode = 200
        const req: any = {
            on: () => req,
            setTimeout: () => req,
            write: (chunk: string) => { body += chunk },
            end: (chunk?: string) => {
                if (chunk) body += chunk
                calls.push({ path: opts.path, method: opts.method, body })
                queueMicrotask(() => {
                    if (opts.path === '/containers/' + ID + '/exec') {
                        response.end(JSON.stringify({ Id: 'exec123' }))
                    } else if (opts.path === '/exec/exec123/start') {
                        for (const chunk of options.frames) response.write(chunk)
                        response.end()
                    } else {
                        response.end(JSON.stringify({ ExitCode: options.exitCode, Running: false }))
                    }
                })
                callback(response)
            },
        }
        return req
    }
    return { request, calls }
}

describe('exec', () => {
    it('sends the argv, streams stdout to the caller and returns the exit code', async () => {
        const { request, calls } = execSetup({ exitCode: 0, frames: [frame(1, 'CREATE TABLE'), frame(1, ' one;')] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        const chunks: Buffer[] = []
        const result = await docker.exec(ID, ['sh', '-c', 'pg_dumpall'], chunk => { chunks.push(chunk) })
        assert.equal(Buffer.concat(chunks).toString(), 'CREATE TABLE one;')
        assert.deepEqual(result, { exitCode: 0, stderr: '' })
        assert.deepEqual(JSON.parse(calls[0]!.body), {
            AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: ['sh', '-c', 'pg_dumpall'],
        })
        assert.equal(calls[0]!.method, 'POST')
    })

    it('collects stderr and reports a non-zero exit', async () => {
        const { request } = execSetup({ exitCode: 1, frames: [frame(2, 'could not connect')] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        const result = await docker.exec(ID, ['sh', '-c', 'pg_dumpall'], () => {})
        assert.deepEqual(result, { exitCode: 1, stderr: 'could not connect' })
    })

    it('refuses a malformed container id before it reaches a URL', async () => {
        const { request } = execSetup({ exitCode: 0, frames: [] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        await assert.rejects(() => docker.exec('../../etc', ['sh'], () => {}), /refusing malformed container id/)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="exec"`
Expected: FAIL, `docker.exec is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/agent/docker.ts`: update the file's opening comment (it currently says this client never execs anything), add the type and the two helpers, and add `exec` to the returned object.

```ts
// How much stderr is kept from a failed exec. Enough to explain a failure, small enough that a command
// screaming into stderr cannot exhaust memory.
const MAX_EXEC_STDERR = 4096
export type ExecResult = { exitCode: number | null, stderr: string }
```

Add to `DockerApi`:

```ts
    // Runs argv in an already-running container and hands stdout to the caller chunk by chunk. stdout is
    // never buffered here: it becomes a database dump, which can be larger than this process's memory.
    exec(id: string, argv: string[], onStdout: (chunk: Buffer) => Promise<void> | void): Promise<ExecResult>
```

Inside `createDockerApi`, beside `open` and `json`:

```ts
    function openPost(path: string, body: unknown, timeoutMs: number | null, clearTimeoutOnHeaders = false): Promise<IncomingMessage> {
        const payload = Buffer.from(JSON.stringify(body))
        return new Promise((resolve, reject) => {
            const options: RequestOptions = {
                socketPath, path, method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
            }
            const req = request(options, response => {
                if (clearTimeoutOnHeaders) req.setTimeout(0)
                resolve(response)
            })
            req.on('error', reject)
            if (timeoutMs !== null) req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timed out on ${endpoint(path)}`)))
            req.end(payload)
        })
    }

    async function postJson<T>(path: string, body: unknown): Promise<T> {
        const response = await openPost(path, body, DOCKER_TIMEOUT_MS)
        response.setEncoding('utf8')
        let text = ''
        for await (const chunk of response) text += chunk
        if (response.statusCode !== 200 && response.statusCode !== 201) {
            throw new Error(`Docker API ${endpoint(path)} answered ${response.statusCode}: ${text.slice(0, 200)}`)
        }
        return JSON.parse(text) as T
    }
```

And the method itself:

```ts
        async exec(id, argv, onStdout) {
            const checked = checkedId(id)
            const created = await postJson<{ Id: string }>(`/containers/${checked}/exec`, {
                AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: argv,
            })
            const execId = checkedId(created.Id)
            // Tty is false above, so the output is multiplexed and the frame decoder that reads logs reads
            // this too. The header wait is bounded; the body is not, because a dump of a large database is
            // legitimately slow and must not be killed for taking its time.
            const stream = await openPost(`/exec/${execId}/start`, { Detach: false, Tty: false }, DOCKER_TIMEOUT_MS, true)
            if (stream.statusCode !== 200) {
                stream.resume()
                throw new Error(`Docker API exec start answered ${stream.statusCode}`)
            }
            const decoder = new FrameDecoder()
            let stderr = ''
            for await (const chunk of stream) {
                for (const frame of decoder.push(chunk as Buffer)) {
                    if (frame.stream === 'stdout') await onStdout(frame.data)
                    else if (stderr.length < MAX_EXEC_STDERR) stderr += frame.data.toString('utf8')
                }
            }
            const inspected = await json<{ ExitCode: number | null }>(`/exec/${execId}/json`)
            return { exitCode: inspected.ExitCode, stderr: stderr.slice(0, MAX_EXEC_STDERR).trim() }
        },
```

Import `FrameDecoder` at the top: `import { FrameDecoder } from './logframes.ts'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS. Every existing `DockerApi` fake in the suite now needs an `exec` member; add `exec: async () => ({ exitCode: 0, stderr: '' })` to each one the typecheck names.

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker.ts src/agent/docker.test.ts && git commit -m "Let the agent exec in a container" -m "The dumps need it: every one of them runs a fixed command inside the database's own container, using credentials from that container's environment." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The restic adapter

**Files:**
- Create: `src/agent/restic.ts`
- Test: `src/agent/restic.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunResult`, `tail()` from `src/agent/compose.ts`; `Keep` from `src/shared/registry.ts`; `Snapshot`, `BackupTag` from `src/shared/backups.ts`
- Produces: `RESTIC_TIMEOUT_MS`, `repoPath()`, `stagingPath()`, `initArgv()`, `backupArgv()`, `snapshotsArgv()`, `forgetArgv()`, `retentionArgv()`, `pruneArgv()`, `dumpArgv()`, `SpawnStream`, `nodeSpawnStream()`, `Restic`, `createRestic(run, spawnStream)`

`RESTIC_PASSWORD` is never passed as an argument: restic reads it from the agent's own environment, which a spawned child inherits. Nothing in this file names it, so it cannot reach a log.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { backupArgv, createRestic, dumpArgv, repoPath, retentionArgv, snapshotsArgv, stagingPath, type SpawnStream } from './restic.ts'
import type { Runner } from './compose.ts'

const REPO = '/backups/acme'

describe('argv builders', () => {
    it('puts the repository behind -r and never names a password', () => {
        assert.deepEqual(repoPath('/backups', 'acme'), '/backups/acme')
        assert.deepEqual(stagingPath('/backups', 'acme', 'run1'), '/backups/.staging/acme/run1')
        assert.deepEqual(backupArgv(REPO, ['/backups/.staging/acme/run1', '/var/www/acme/uploads'], 'manual'), [
            '-r', REPO, 'backup', '--json', '--tag', 'manual', '/backups/.staging/acme/run1', '/var/www/acme/uploads',
        ])
        assert.deepEqual(snapshotsArgv(REPO), ['-r', REPO, 'snapshots', '--json'])
        assert.deepEqual(dumpArgv(REPO, 'deadbeef'), ['-r', REPO, 'dump', '--archive', 'tar', 'deadbeef', '/'])
        assert.equal(backupArgv(REPO, [], 'manual').join(' ').includes('password'), false)
    })

    it('forgets scheduled snapshots only, by the client retention' , () => {
        assert.deepEqual(retentionArgv(REPO, { daily: 7, weekly: 4, monthly: 3 }), [
            '-r', REPO, 'forget', '--tag', 'scheduled', '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '3',
        ])
    })
})

function setup(results: Record<string, Partial<RunResult>>) {
    const calls: Array<{ command: string, args: string[] }> = []
    const run: Runner = async (command, args) => {
        calls.push({ command, args })
        const key = args.find(arg => ['backup', 'snapshots', 'forget', 'prune', 'init'].includes(arg)) ?? ''
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results[key] ?? {}) }
    }
    return { run, calls }
}

describe('createRestic', () => {
    it('reads the snapshot id out of restic\'s own json summary', async () => {
        const summary = JSON.stringify({ message_type: 'summary', snapshot_id: 'deadbeefcafe', total_bytes_processed: 2048 })
        const { run } = setup({ backup: { stdout: `{"message_type":"status"}\n${summary}\n` } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/backups/.staging/acme/run1'], 'manual')
        assert.deepEqual(result, { ok: true, snapshot: 'deadbeefcafe', sizeBytes: 2048 })
    })

    it('returns a failure with the tail of stderr rather than throwing', async () => {
        const { run } = setup({ backup: { exitCode: 1, stderr: 'repository is locked' } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/staging'], 'scheduled')
        assert.deepEqual(result, { ok: false, reason: 'restic backup exited with code 1', output: 'repository is locked' })
    })

    it('parses snapshots into the portal shape, newest first', async () => {
        const stdout = JSON.stringify([
            { short_id: 'aaaa1111', time: '2026-09-20T02:00:00.000000+10:00', tags: ['scheduled'] },
            { short_id: 'bbbb2222', time: '2026-09-21T02:00:00.000000+10:00', tags: ['manual'] },
        ])
        const { run } = setup({ snapshots: { stdout } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.snapshots(REPO)
        assert.equal(result.ok, true)
        assert.deepEqual(result.ok && result.snapshots.map(s => s.id), ['bbbb2222', 'aaaa1111'])
        assert.equal(result.ok && result.snapshots[0]?.tag, 'manual')
    })

    it('streams a dump without buffering it', async () => {
        const stdout = new PassThrough()
        const spawnStream: SpawnStream = (command, args) => {
            assert.equal(command, 'restic')
            assert.ok(args.includes('dump'))
            queueMicrotask(() => stdout.end(Buffer.from('tar bytes')))
            return { stdout, exit: Promise.resolve({ exitCode: 0, stderr: '' }) }
        }
        const { run } = setup({})
        const restic = createRestic(run, spawnStream)
        const chunks: Buffer[] = []
        const stream = restic.dump(REPO, 'deadbeef')
        for await (const chunk of stream.stdout) chunks.push(chunk as Buffer)
        assert.equal(Buffer.concat(chunks).toString(), 'tar bytes')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="argv builders|createRestic"`
Expected: FAIL, cannot find module `./restic.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// Every restic command the agent runs, and the argv that builds them. Two adapters, for two reasons: most
// commands produce a few kilobytes of JSON and go through Runner, which captures output as text, while a
// dump is a tar of the whole snapshot and goes through SpawnStream, which never holds it in memory.
//
// RESTIC_PASSWORD is deliberately absent from every line here. restic reads it from the agent's own
// environment, which a spawned child inherits, so it can never appear in an argv, a log or an error.

import { spawn as nodeSpawn } from 'node:child_process'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'

import { tail, type Runner } from './compose.ts'
import type { Keep } from '../shared/registry.ts'
import type { BackupTag, Snapshot } from '../shared/backups.ts'

// A backup of a large site is minutes, and a prune of a large repository can be longer. Nothing here is
// on a request's critical path: the run was started, not awaited.
export const RESTIC_TIMEOUT_MS = 60 * 60_000
export const OUTPUT_TAIL = 500

export const repoPath = (backupDir: string, id: string): string => posix.join(backupDir, id)
export const stagingPath = (backupDir: string, id: string, run: string): string => posix.join(backupDir, '.staging', id, run)

const base = (repo: string): string[] => ['-r', repo]

export const initArgv = (repo: string): string[] => [...base(repo), 'init']
export const backupArgv = (repo: string, paths: string[], tag: BackupTag): string[] =>
    [...base(repo), 'backup', '--json', '--tag', tag, ...paths]
export const snapshotsArgv = (repo: string): string[] => [...base(repo), 'snapshots', '--json']
export const forgetArgv = (repo: string, snapshot: string): string[] => [...base(repo), 'forget', snapshot]
// scheduled only: a manual snapshot is kept until the client deletes it, and retention must never take one.
export const retentionArgv = (repo: string, keep: Keep): string[] => [
    ...base(repo), 'forget', '--tag', 'scheduled',
    '--keep-daily', String(keep.daily), '--keep-weekly', String(keep.weekly), '--keep-monthly', String(keep.monthly),
]
export const pruneArgv = (repo: string): string[] => [...base(repo), 'prune']
export const dumpArgv = (repo: string, snapshot: string): string[] => [...base(repo), 'dump', '--archive', 'tar', snapshot, '/']

export type StreamHandle = { stdout: Readable, exit: Promise<{ exitCode: number | null, stderr: string }> }
export type SpawnStream = (command: string, args: string[]) => StreamHandle

export function nodeSpawnStream(spawn: typeof nodeSpawn = nodeSpawn): SpawnStream {
    return (command, args) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
        const exit = new Promise<{ exitCode: number | null, stderr: string }>(resolve => {
            child.on('close', code => resolve({ exitCode: code, stderr: stderr.trim() }))
            child.on('error', error => resolve({ exitCode: null, stderr: error.message }))
        })
        return { stdout: child.stdout!, exit }
    }
}

export type ResticFailure = { ok: false, reason: string, output: string }
export type Restic = {
    init(repo: string): Promise<{ ok: true } | ResticFailure>
    backup(repo: string, paths: string[], tag: BackupTag): Promise<{ ok: true, snapshot: string, sizeBytes: number | null } | ResticFailure>
    snapshots(repo: string): Promise<{ ok: true, snapshots: Snapshot[] } | ResticFailure>
    forget(repo: string, snapshot: string): Promise<{ ok: true } | ResticFailure>
    retention(repo: string, keep: Keep): Promise<{ ok: true } | ResticFailure>
    prune(repo: string): Promise<{ ok: true } | ResticFailure>
    dump(repo: string, snapshot: string): StreamHandle
}

type Summary = { message_type?: string, snapshot_id?: string, total_bytes_processed?: number }
type ResticSnapshot = { short_id?: string, id?: string, time?: string, tags?: string[] }

export function createRestic(run: Runner, spawnStream: SpawnStream): Restic {
    // Every failure is returned, never thrown, and carries the tail of stderr so a broken repository is
    // diagnosable from the portal. stderr from restic names paths and exit codes, never the password.
    const failed = (what: string, result: { exitCode: number | null, stderr: string, timedOut: boolean }): ResticFailure => ({
        ok: false,
        reason: result.timedOut ? `restic ${what} timed out` : `restic ${what} exited with code ${result.exitCode}`,
        output: tail(result.stderr.trim(), OUTPUT_TAIL),
    })

    async function simple(what: string, args: string[]): Promise<{ ok: true } | ResticFailure> {
        const result = await run('restic', args, RESTIC_TIMEOUT_MS)
        return result.exitCode === 0 && !result.timedOut ? { ok: true } : failed(what, result)
    }

    return {
        init: repo => simple('init', initArgv(repo)),
        forget: (repo, snapshot) => simple('forget', forgetArgv(repo, snapshot)),
        retention: (repo, keep) => simple('forget', retentionArgv(repo, keep)),
        prune: repo => simple('prune', pruneArgv(repo)),

        async backup(repo, paths, tag) {
            const result = await run('restic', backupArgv(repo, paths, tag), RESTIC_TIMEOUT_MS)
            if (result.exitCode !== 0 || result.timedOut) return failed('backup', result)
            // --json writes one object per line and ends with a summary. The summary is the only line that
            // names the snapshot, so a run whose output we cannot read is a failed run: without an id there
            // is nothing to record, delete or download.
            for (const line of result.stdout.split('\n').reverse()) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line) as Summary
                    if (parsed.message_type === 'summary' && parsed.snapshot_id) {
                        return { ok: true, snapshot: parsed.snapshot_id, sizeBytes: parsed.total_bytes_processed ?? null }
                    }
                } catch {
                    // Not JSON: restic writes progress lines too. Keep looking.
                }
            }
            return { ok: false, reason: 'restic backup did not report a snapshot id', output: tail(result.stdout.trim(), OUTPUT_TAIL) }
        },

        async snapshots(repo) {
            const result = await run('restic', snapshotsArgv(repo), RESTIC_TIMEOUT_MS)
            if (result.exitCode !== 0 || result.timedOut) return failed('snapshots', result)
            try {
                const parsed = JSON.parse(result.stdout) as ResticSnapshot[]
                const snapshots = parsed
                    .map(entry => ({
                        id: entry.short_id ?? entry.id ?? '',
                        at: new Date(entry.time ?? 0).toISOString(),
                        tag: (entry.tags ?? []).includes('manual') ? 'manual' as const : 'scheduled' as const,
                        sizeBytes: null,
                    }))
                    .filter(snapshot => snapshot.id !== '')
                    .sort((a, b) => b.at.localeCompare(a.at))
                return { ok: true, snapshots }
            } catch {
                return { ok: false, reason: 'restic snapshots returned unreadable output', output: '' }
            }
        },

        dump: (repo, snapshot) => spawnStream('restic', dumpArgv(repo, snapshot)),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/restic.ts src/agent/restic.test.ts && git commit -m "Add the restic adapter" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The dump plan per engine

**Files:**
- Create: `src/agent/backup-dumps.ts`
- Test: `src/agent/backup-dumps.test.ts`

**Interfaces:**
- Consumes: `ProjectEntry`, `ServiceEntry`, `Engine` from `src/shared/registry.ts`
- Produces: `ENV_NAME_PATTERN`, `DumpPlan`, `dumpPlan(service, entry)`, `dumpPlans(project)`

This task is the pure half: what command each engine runs and what file it writes. Running it is Task 7. Keeping them apart is what lets the command strings be asserted as strings, which is the only way to be sure no request value ever reaches one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dumpPlan, dumpPlans } from './backup-dumps.ts'
import { parseRegistry } from '../shared/registry.ts'

const registry = (services: string) => parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services:
${services}
`)

describe('dumpPlan', () => {
    it('dumps postgres as the container\'s own superuser', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.sql',
            argv: ['sh', '-c', 'pg_dumpall -U "$POSTGRES_USER"'],
        })
    })

    it('honours a registry override of the variable name, never a value', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'PGUSER' } })
        assert.deepEqual(plan && 'argv' in plan && plan.argv, ['sh', '-c', 'pg_dumpall -U "$PGUSER"'])
    })

    it('refuses an override that is not an environment variable name', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'X"; rm -rf /; #' } })
        assert.deepEqual(plan, { problem: 'db: dump.userEnv is not an environment variable name' })
    })

    it('passes the mysql password through MYSQL_PWD so it never reaches a process list', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'mysql', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.sql',
            argv: ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --all-databases --single-transaction --routines --events -u root'],
        })
        const mariadb = dumpPlan('db', { role: 'database', engine: 'mariadb', dump: {} })
        assert.ok(mariadb && 'argv' in mariadb && mariadb.argv[2]!.startsWith('MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump'))
    })

    it('authenticates mongodump only when the image sets credentials', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'mongodb', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.archive.gz',
            argv: ['sh', '-c', 'mongodump --archive --gzip ${MONGO_INITDB_ROOT_USERNAME:+-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}'],
        })
    })

    it('streams a redis rdb out through a temporary file inside the container', () => {
        const plan = dumpPlan('cache', { role: 'database', engine: 'redis', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'cache', file: 'dump.rdb',
            argv: ['sh', '-c', 'redis-cli --rdb /tmp/hostd-dump.rdb >/dev/null && cat /tmp/hostd-dump.rdb; rm -f /tmp/hostd-dump.rdb'],
        })
    })

    it('copies a sqlite file with sqlite3 rather than reading it under a writer', () => {
        const plan = dumpPlan('app', { role: 'database', engine: 'sqlite', file: 'data/app.db' })
        assert.deepEqual(plan, { kind: 'sqlite', service: 'app', source: 'data/app.db', file: 'dump.db' })
    })

    it('falls back to stopping an unknown engine', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'generic', dump: {} })
        assert.deepEqual(plan, { kind: 'generic', service: 'db', file: 'data' })
    })

    it('has nothing to do for a site service', () => {
        assert.equal(dumpPlan('web', { role: 'site' }), null)
    })
})

describe('dumpPlans', () => {
    it('returns one plan per database service and no plan for the site', () => {
        const parsed = registry('      web: { role: site }\n      db: { role: database, engine: postgres }')
        const project = parsed.projects.get('acme')!
        const plans = dumpPlans(project)
        assert.equal(plans.ok, true)
        assert.deepEqual(plans.ok && plans.plans.map(plan => plan.service), ['db'])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="dumpPlan"`
Expected: FAIL, cannot find module `./backup-dumps.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// What each database engine's dump is: a fixed command string, a file name in the staging directory, and
// nothing that came from a request. The only registry-driven part of any command is an environment
// variable NAME, checked against ENV_NAME_PATTERN below, so the worst a bad registry entry can do is name
// a variable that does not exist. Values are never read here: the command reads them inside the container,
// from that container's own environment, which is why no password ever reaches an argv or a process list.
//
// Running these is backup-dumps' other half, in backup-run.ts. Keeping the strings pure is what lets the
// tests assert them exactly.

import type { ProjectEntry, ServiceEntry } from '../shared/registry.ts'

export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export type DumpPlan =
    // Run argv through docker exec in `service` and write its stdout to `file` under the staging directory.
    | { kind: 'exec', service: string, argv: string[], file: string }
    // The agent copies the sqlite file itself: sqlite3's own .backup is safe against a concurrent writer.
    | { kind: 'sqlite', service: string, source: string, file: string }
    // Stop the service, copy its bind-mounted data, start it again. Briefly disruptive, and the record says so.
    | { kind: 'generic', service: string, file: string }

export type PlanProblem = { problem: string }

const named = (service: string, override: string | undefined, fallback: string): string | PlanProblem => {
    if (override === undefined) return fallback
    return ENV_NAME_PATTERN.test(override) ? override : { problem: `${service}: dump.userEnv is not an environment variable name` }
}

const passwordNamed = (service: string, override: string | undefined, fallback: string): string | PlanProblem => {
    if (override === undefined) return fallback
    return ENV_NAME_PATTERN.test(override) ? override : { problem: `${service}: dump.passwordEnv is not an environment variable name` }
}

const isProblem = (value: unknown): value is PlanProblem => typeof value === 'object' && value !== null && 'problem' in value

export function dumpPlan(service: string, entry: ServiceEntry): DumpPlan | PlanProblem | null {
    if (entry.role !== 'database') return null
    if (entry.engine === 'sqlite') return { kind: 'sqlite', service, source: entry.file, file: 'dump.db' }

    const exec = (argv: string[], file: string): DumpPlan => ({ kind: 'exec', service, argv, file })

    switch (entry.engine) {
        case 'postgres': {
            const user = named(service, entry.dump.userEnv, 'POSTGRES_USER')
            if (isProblem(user)) return user
            return exec(['sh', '-c', `pg_dumpall -U "$${user}"`], 'dump.sql')
        }
        case 'mysql':
        case 'mariadb': {
            const command = entry.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump'
            const defaultPassword = entry.engine === 'mysql' ? 'MYSQL_ROOT_PASSWORD' : 'MARIADB_ROOT_PASSWORD'
            const password = passwordNamed(service, entry.dump.passwordEnv, defaultPassword)
            if (isProblem(password)) return password
            // --all-databases needs a superuser, which in both images is root unless the registry says
            // otherwise. MYSQL_PWD rather than -p, so the password never appears in the container's process
            // list; mariadb-dump reads the same variable.
            const user = entry.dump.userEnv === undefined ? 'root' : named(service, entry.dump.userEnv, 'root')
            if (isProblem(user)) return user
            const userArg = entry.dump.userEnv === undefined ? '-u root' : `-u "$${user}"`
            return exec(['sh', '-c', `MYSQL_PWD="$${password}" ${command} --all-databases --single-transaction --routines --events ${userArg}`], 'dump.sql')
        }
        case 'mongodb': {
            const user = named(service, entry.dump.userEnv, 'MONGO_INITDB_ROOT_USERNAME')
            if (isProblem(user)) return user
            const password = passwordNamed(service, entry.dump.passwordEnv, 'MONGO_INITDB_ROOT_PASSWORD')
            if (isProblem(password)) return password
            // ${VAR:+...} expands to the credentials only when the image sets them, so an unauthenticated
            // development mongo and a credentialed production one both dump with one command string.
            return exec(['sh', '-c', `mongodump --archive --gzip \${${user}:+-u "$${user}" -p "$${password}" --authenticationDatabase admin}`], 'dump.archive.gz')
        }
        case 'redis':
            // --rdb writes to a file rather than stdout, so it goes to the container's own /tmp and is then
            // streamed out and removed. The rm runs even if cat fails, hence ';' rather than '&&'.
            return exec(['sh', '-c', 'redis-cli --rdb /tmp/hostd-dump.rdb >/dev/null && cat /tmp/hostd-dump.rdb; rm -f /tmp/hostd-dump.rdb'], 'dump.rdb')
        case 'generic':
            return { kind: 'generic', service, file: 'data' }
    }
}

export function dumpPlans(project: ProjectEntry): { ok: true, plans: DumpPlan[] } | { ok: false, problem: string } {
    const plans: DumpPlan[] = []
    for (const [service, entry] of Object.entries(project.services)) {
        const plan = dumpPlan(service, entry)
        if (plan === null) continue
        if (isProblem(plan)) return { ok: false, problem: plan.problem }
        plans.push(plan)
    }
    return { ok: true, plans }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/backup-dumps.ts src/agent/backup-dumps.test.ts && git commit -m "Write the dump command for every engine" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: One run, end to end

**Files:**
- Create: `src/agent/backup-run.ts`
- Test: `src/agent/backup-run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 5 and 6; `DockerApi` and `pickPerService()` from `src/agent/docker.ts`; `resolveCompose()`, `lifecycleArgv()`, `Runner` from `src/agent/compose.ts`; `environmentOf()` from `src/shared/registry.ts`; `readSystemUsage()` shape from `src/shared/system.ts`
- Produces: `BackupFs`, `BackupDeps`, `BackupRequest = { tag: BackupTag, actor: string, run: string, keep: Keep | null }`, `runBackup(project, request, deps): Promise<BackupRecord>`

`runBackup` never throws: every failure becomes a record whose outcome is `failed`. It is also the only place that writes to the staging directory, and it removes that directory in a `finally`, whatever happened.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { runBackup, type BackupDeps, type BackupFs } from './backup-run.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Restic } from './restic.ts'

const YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      media: { path: uploads, mode: rw }
`

const project = () => parseRegistry(YAML).projects.get('acme')!

function setup(over: Partial<BackupDeps> = {}) {
    const written = new Map<string, string>()
    const removed: string[] = []
    const made: string[] = []
    const fs: BackupFs = {
        mkdir: async dir => { made.push(dir) },
        writeStream: path => {
            const sink = new PassThrough()
            let text = ''
            sink.on('data', (chunk: Buffer) => { text += chunk.toString() })
            const done = new Promise<void>(resolve => sink.on('finish', () => { written.set(path, text); resolve() }))
            return { sink, done }
        },
        remove: async path => { removed.push(path) },
        copy: async (from, to) => { written.set(to, `copy of ${from}`) },
        exists: async () => true,
    }
    const backups: Array<{ paths: string[], tag: string }> = []
    const restic: Restic = {
        init: async () => ({ ok: true }),
        backup: async (_repo, paths, tag) => {
            backups.push({ paths, tag })
            return { ok: true, snapshot: 'deadbeef', sizeBytes: 100 }
        },
        snapshots: async () => ({ ok: true, snapshots: [] }),
        forget: async () => ({ ok: true }),
        retention: async () => ({ ok: true }),
        prune: async () => ({ ok: true }),
        dump: () => { throw new Error('not used') },
    }
    const execs: Array<{ id: string, argv: string[] }> = []
    const deps: BackupDeps = {
        backupDir: '/backups',
        restic,
        docker: {
            ping: async () => true,
            listProjectContainers: async () => [{ Id: 'c'.repeat(64), State: 'running', Labels: { 'com.docker.compose.service': 'db' } }],
            listAllContainers: async () => [],
            inspect: async () => { throw new Error('not used') },
            logs: async () => { throw new Error('not used') },
            exec: async (id, argv, onStdout) => {
                execs.push({ id, argv })
                await onStdout(Buffer.from('CREATE TABLE one;'))
                return { exitCode: 0, stderr: '' }
            },
        },
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        fs,
        disk: async () => ({ path: '/backups', totalBytes: 1000, usedBytes: 500, freeBytes: 500 }),
        now: () => Date.parse('2026-09-21T02:00:00.000Z'),
        log: () => {},
        ...over,
    }
    return { deps, written, removed, made, backups, execs }
}

describe('runBackup', () => {
    it('dumps the database into staging, captures staging and storage, and records the snapshot', async () => {
        const { deps, written, backups, execs, removed } = setup()
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)

        assert.equal(record.outcome, 'ok')
        assert.equal(record.snapshot, 'deadbeef')
        assert.equal(record.disruptive, false)
        assert.equal(written.get('/backups/.staging/acme/run1/db/db/dump.sql'), 'CREATE TABLE one;')
        assert.deepEqual(execs[0]?.argv, ['sh', '-c', 'pg_dumpall -U "$POSTGRES_USER"'])
        assert.deepEqual(backups, [{ paths: ['/backups/.staging/acme/run1', '/var/www/acme/uploads'], tag: 'manual' }])
        assert.ok(removed.includes('/backups/.staging/acme/run1'), 'staging is always cleared')
    })

    it('refuses before touching anything when the disk is nearly full', async () => {
        const { deps, execs } = setup({ disk: async () => ({ path: '/backups', totalBytes: 1000, usedBytes: 950, freeBytes: 50 }) })
        const record = await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /10% free/)
        assert.equal(execs.length, 0)
    })

    it('fails the whole run when a dump fails, and records no snapshot', async () => {
        const { deps, backups } = setup()
        deps.docker.exec = async () => ({ exitCode: 1, stderr: 'could not connect to server' })
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.snapshot, null)
        assert.match(record.reason ?? '', /could not connect to server/)
        assert.deepEqual(backups, [], 'nothing is captured when a dump failed')
    })

    it('applies the client retention after a scheduled run only', async () => {
        const retentions: unknown[] = []
        const { deps } = setup()
        deps.restic.retention = async (_repo, keep) => { retentions.push(keep); return { ok: true } }
        await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [])
        await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run2', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [{ daily: 7, weekly: 4, monthly: 3 }])
    })

    it('marks a generic dump disruptive and puts the service back up', async () => {
        const commands: string[][] = []
        const { deps } = setup({ runner: async (command, args) => { commands.push([command, ...args]); return { exitCode: 0, stdout: '{"name":"acme","services":{"db":{"volumes":[{"type":"bind","source":"/var/www/acme/dbdata"}]}}}', stderr: '', timedOut: false } } })
        const generic = parseRegistry(YAML.replace('engine: postgres', 'engine: generic')).projects.get('acme')!
        const record = await runBackup(generic, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok')
        assert.equal(record.disruptive, true)
        const joined = commands.map(command => command.join(' '))
        assert.ok(joined.some(line => line.includes('stop db')), 'the service is stopped')
        assert.ok(joined.some(line => line.includes('start db')), 'and started again')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="runBackup"`
Expected: FAIL, cannot find module `./backup-run.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// One backup run, end to end. Never throws: a failure is a record saying so, because the run has already
// happened by the time anything can react to it.
//
// Live only. Every path here comes from environmentOf(project, 'live') or project.storage, both of which
// the registry derived; nothing a request carried ever becomes a path.

import { posix } from 'node:path'
import type { Writable } from 'node:stream'

import { diskProblem, type BackupRecord, type BackupTag } from '../shared/backups.ts'
import { describeError } from '../shared/formats.ts'
import { environmentOf, type Keep, type ProjectEntry } from '../shared/registry.ts'
import type { DiskUsage } from '../shared/system.ts'
import { composeBase, resolveCompose, tail, type Runner } from './compose.ts'
import { pickPerService, type DockerApi } from './docker.ts'
import { dumpPlans, type DumpPlan } from './backup-dumps.ts'
import { repoPath, stagingPath, type Restic } from './restic.ts'

export const LIFECYCLE_TIMEOUT_MS = 120_000

export type BackupFs = {
    mkdir(dir: string): Promise<void>
    // A sink to stream a dump into, and a promise that resolves once it is on disk. Streamed, never
    // buffered: a dump is as large as the database.
    writeStream(path: string): { sink: Writable, done: Promise<void> }
    remove(path: string): Promise<void>
    copy(from: string, to: string): Promise<void>
    exists(path: string): Promise<boolean>
}

export type BackupDeps = {
    backupDir: string
    restic: Restic
    docker: DockerApi
    runner: Runner
    fs: BackupFs
    disk: () => Promise<DiskUsage | null>
    now: () => number
    log(message: string): void
}

export type BackupRequest = { tag: BackupTag, actor: string, run: string, keep: Keep | null }

export async function runBackup(project: ProjectEntry, request: BackupRequest, deps: BackupDeps): Promise<BackupRecord> {
    const startedAt = deps.now()
    let disruptive = false

    const record = (outcome: 'ok' | 'failed', snapshot: string | null, reason: string | null): BackupRecord => ({
        run: request.run, tag: request.tag, actor: request.actor,
        startedAt: new Date(startedAt).toISOString(), durationMs: deps.now() - startedAt,
        outcome, snapshot, reason, disruptive,
    })

    const problem = diskProblem(await deps.disk())
    if (problem) return record('failed', null, problem)

    const live = environmentOf(project, 'live')
    if (!live) return record('failed', null, `${project.id} has no live environment`)

    const staging = stagingPath(deps.backupDir, project.id, request.run)
    const repo = repoPath(deps.backupDir, project.id)

    try {
        const planned = dumpPlans(project)
        if (!planned.ok) return record('failed', null, planned.problem)

        await deps.fs.mkdir(staging)
        // restic init on an existing repository exits non-zero, which is why this asks first rather than
        // treating a failure as proof it was already there.
        if (!(await deps.fs.exists(posix.join(repo, 'config')))) {
            const started = await deps.restic.init(repo)
            if (!started.ok) return record('failed', null, `${started.reason}: ${started.output}`)
        }

        const containers = pickPerService(await deps.docker.listProjectContainers(project.id))
        for (const plan of planned.plans) {
            const target = posix.join(staging, 'db', plan.service)
            await deps.fs.mkdir(target)
            const failure = await dump(plan, posix.join(target, plan.file), project, live.dir, containers, deps)
            if (failure) return record('failed', null, failure)
            if (plan.kind === 'generic') disruptive = true
        }

        // One capture of staging and every storage directory, whatever its mode: hidden storage is backed
        // up and simply never exposed through the file API.
        const paths = [staging, ...Object.values(project.storage).map(entry => entry.absolute)]
        const captured = await deps.restic.backup(repo, paths, request.tag)
        if (!captured.ok) return record('failed', null, `${captured.reason}: ${captured.output}`)

        // Retention is the client's, and applies to scheduled snapshots only. A manual snapshot is kept
        // until the client deletes it.
        if (request.tag === 'scheduled' && request.keep) {
            const forgotten = await deps.restic.retention(repo, request.keep)
            if (!forgotten.ok) deps.log(`WARN backup ${project.id}: retention failed: ${forgotten.reason}`)
        }

        return record('ok', captured.snapshot, null)
    } catch (error) {
        return record('failed', null, describeError(error))
    } finally {
        // Whatever happened: a dump left behind is a copy of the client's database sitting outside the
        // repository, and the next run would capture it again.
        await deps.fs.remove(staging).catch(error => deps.log(`WARN backup ${project.id}: staging could not be cleared: ${describeError(error)}`))
    }
}

// Returns null on success, or why the dump failed.
async function dump(
    plan: DumpPlan,
    target: string,
    project: ProjectEntry,
    dir: string,
    containers: ReadonlyMap<string, { Id: string, State: string }>,
    deps: BackupDeps,
): Promise<string | null> {
    if (plan.kind === 'sqlite') {
        // sqlite3's own .backup is safe against a concurrent writer, which copying the file is not.
        const source = posix.join(dir, plan.source)
        const result = await deps.runner('sqlite3', [source, `.backup ${target}`], LIFECYCLE_TIMEOUT_MS)
        return result.exitCode === 0 && !result.timedOut ? null : `${plan.service}: sqlite3 exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 500)}`
    }

    if (plan.kind === 'generic') {
        // The fallback for an engine with no dump method: stop it, copy what it has bind-mounted, start it
        // again. Briefly disruptive, and the caller marks the record so the portal can say so.
        const resolved = await resolveCompose({ dir, composePaths: project.composePaths }, deps.runner)
        if (!resolved.ok) return `${plan.service}: ${resolved.problem}`
        const sources = (resolved.resolved.services[plan.service]?.volumes ?? [])
            .filter(volume => volume.type === 'bind' && typeof volume.source === 'string')
            .map(volume => volume.source!)
        if (sources.length === 0) return `${plan.service}: a generic engine needs a bind-mounted data directory to copy`
        const base = composeBase({ dir, composePaths: project.composePaths })
        const stopped = await deps.runner('docker', [...base, 'stop', plan.service], LIFECYCLE_TIMEOUT_MS)
        if (stopped.exitCode !== 0) return `${plan.service}: could not be stopped to copy its data`
        try {
            for (const source of sources) await deps.fs.copy(source, posix.join(target, posix.basename(source)))
        } finally {
            const started = await deps.runner('docker', [...base, 'start', plan.service], LIFECYCLE_TIMEOUT_MS)
            if (started.exitCode !== 0) deps.log(`WARN backup ${project.id}: ${plan.service} did not start again after a generic dump`)
        }
        return null
    }

    const container = containers.get(plan.service)
    if (!container) return `${plan.service}: no container is running to dump from`
    if (container.State !== 'running') return `${plan.service}: the container is ${container.State}, so there is nothing to dump from`
    const { sink, done } = deps.fs.writeStream(target)
    try {
        const result = await deps.docker.exec(container.Id, plan.argv, chunk => {
            if (!sink.write(chunk)) return new Promise<void>(resolve => sink.once('drain', () => resolve()))
        })
        sink.end()
        await done
        if (result.exitCode !== 0) return `${plan.service}: the dump exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`
        return null
    } catch (error) {
        sink.end()
        return `${plan.service}: ${describeError(error)}`
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/backup-run.ts src/agent/backup-run.test.ts && git commit -m "Run one backup end to end" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Starting a run, and the locks

**Files:**
- Create: `src/agent/backup-runner.ts`
- Test: `src/agent/backup-runner.test.ts`

**Interfaces:**
- Consumes: `runBackup()`, `BackupDeps` from Task 7; `BackupStore` from Task 3; `refuse()`, `Refusal` from `src/shared/protocol.ts`
- Produces: `BackupRunnerDeps = BackupDeps & { store: BackupStore, deployRunning: (id: string) => boolean }`, `BackupStartedReply = { ok: true, started: { run: string, tag: BackupTag } }`, `BackupRunner` with `isRunning(id)`, `isBusy()`, `start(project, request)`, `settle()`

Read `src/agent/deploy-runner.ts` first: this is the same pattern with two extra refusals. The per-project lock and the dedi-wide lock are both taken before any `await`, so two requests arriving together cannot both see a free slot. The third refusal is the spec's: a run is refused while a deploy is in flight for that project, because a deploy renames the whole directory and a backup started mid-swap would read a tree that is moving. `deployRunning` is injected rather than reached for, so this file never depends on the deploy runner itself.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BackupRunner } from './backup-runner.ts'
import { BackupStore } from './backup-state.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { BackupRecord } from '../shared/backups.ts'

const YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services: { web: { role: site } }
  widget:
    client: cl_2
    name: Widget
    dir: /var/www/widget
    upstream: 127.0.0.1:5011
    capabilities: [backups]
    services: { web: { role: site } }
`

const registry = parseRegistry(YAML)
const acme = registry.projects.get('acme')!
const widget = registry.projects.get('widget')!

function setup() {
    const store = new BackupStore('/state/backups.json', {
        readFile: async () => { throw new Error('ENOENT') },
        writeFile: async () => {}, rename: async () => {}, mkdir: async () => {},
    })
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const backup = async (project: { id: string }): Promise<BackupRecord> => {
        started.push(project.id)
        await held
        return {
            run: 'run1', tag: 'manual', actor: 'client', startedAt: '2026-09-21T02:00:00.000Z',
            durationMs: 1, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false,
        }
    }
    const deps = { store, log: () => {}, now: () => 0, deployRunning: () => false } as never
    return { runner: new BackupRunner(deps, backup as never), release, started, store }
}

describe('BackupRunner', () => {
    it('answers at once and records the outcome later', async () => {
        const { runner, release, store } = setup()
        const reply = runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        assert.deepEqual(reply, { ok: true, started: { run: 'run1', tag: 'manual' } })
        release()
        await runner.settle()
        assert.equal(store.get('acme').runs[0]?.snapshot, 'deadbeef')
    })

    it('refuses a second run for the same project', async () => {
        const { runner, release } = setup()
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        const second = runner.start(acme, { tag: 'manual', actor: 'client', run: 'run2', keep: null })
        assert.equal(second.ok, false)
        assert.equal(!second.ok && second.code, 'busy')
        release()
        await runner.settle()
    })

    it('refuses a run on another project while one is running anywhere', async () => {
        const { runner, release, started } = setup()
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        const other = runner.start(widget, { tag: 'scheduled', actor: 'hostd', run: 'run2', keep: null })
        assert.equal(other.ok, false)
        assert.match(!other.ok ? other.message : '', /another backup is running/)
        assert.deepEqual(started, ['acme'])
        release()
        await runner.settle()
    })

    it('refuses while a deploy is in flight for that project', async () => {
        const { store } = setup()
        const runner = new BackupRunner({ store, log: () => {}, now: () => 0, deployRunning: (id: string) => id === 'acme' } as never, (async () => {
            throw new Error('the backup should never have started')
        }) as never)
        const refused = runner.start(acme, { tag: 'scheduled', actor: 'hostd', run: 'run1', keep: null })
        assert.equal(refused.ok, false)
        assert.match(!refused.ok ? refused.message : '', /deploying/)
        assert.equal(runner.start(widget, { tag: 'manual', actor: 'client', run: 'run2', keep: null }).ok, true)
        await runner.settle()
    })

    it('records a run that crashed rather than losing it', async () => {
        const { store } = setup()
        const runner = new BackupRunner({ store, log: () => {}, now: () => 0, deployRunning: () => false } as never, (async () => { throw new Error('restic is not installed') }) as never)
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        await runner.settle()
        assert.equal(store.get('acme').runs[0]?.outcome, 'failed')
        assert.match(store.get('acme').runs[0]?.reason ?? '', /restic is not installed/)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="BackupRunner"`
Expected: FAIL, cannot find module `./backup-runner.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// Starts a backup and answers immediately. A backup is minutes of dumping and uploading; api's own call
// timeout is 150 seconds, so a verb that waited for one would always time out. The reply says the run
// started, and the run history is where the outcome shows up.
//
// Two locks, both from the design: one backup per project, and one backup across the whole dedi, so a
// scheduled sweep can never saturate the disk. Both are taken before any await, so two requests arriving
// together cannot both see a free slot.
//
// And one refusal that is not a lock: a deploy in flight for this project. A deploy renames the directory
// the storage lives under, so a backup started mid-swap would walk a tree that is moving. The reverse is
// deliberately not enforced (see the design): by the time a deploy could start mid-backup, the dumps are
// already in staging, so the one thing that cannot be re-read is never torn.

import { describeError } from '../shared/formats.ts'
import type { BackupRecord, BackupTag } from '../shared/backups.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { ProjectEntry } from '../shared/registry.ts'
import { runBackup, type BackupDeps, type BackupRequest } from './backup-run.ts'
import type { BackupStore } from './backup-state.ts'

export type BackupRunnerDeps = BackupDeps & { store: BackupStore, deployRunning: (id: string) => boolean }
export type BackupStartedReply = { ok: true, started: { run: string, tag: BackupTag } }
type Backup = (project: ProjectEntry, request: BackupRequest, deps: BackupDeps) => Promise<BackupRecord>

export class BackupRunner {
    private readonly running = new Map<string, Promise<void>>()

    // `backup` is injected only so the tests can hold a run open and watch the locking; everything else
    // passes the real one.
    constructor(private readonly deps: BackupRunnerDeps, private readonly backup: Backup = runBackup) {}

    isRunning(id: string): boolean {
        return this.running.has(id)
    }

    isBusy(): boolean {
        return this.running.size > 0
    }

    start(project: ProjectEntry, request: BackupRequest): BackupStartedReply | Refusal {
        if (this.running.has(project.id)) return refuse('busy', `${project.id} already has a backup running`)
        if (this.running.size > 0) return refuse('busy', 'another backup is running; only one runs on the dedi at a time')
        if (this.deps.deployRunning(project.id)) return refuse('busy', `${project.id} is deploying; a backup waits until that has finished`)

        this.running.set(project.id, this.run(project, request))
        return { ok: true, started: { run: request.run, tag: request.tag } }
    }

    // For the tests, and for a clean shutdown: nothing in production awaits a run.
    async settle(): Promise<void> {
        await Promise.all([...this.running.values()])
    }

    private async run(project: ProjectEntry, request: BackupRequest): Promise<void> {
        try {
            let record: BackupRecord
            try {
                record = await this.backup(project, request, this.deps)
            } catch (error) {
                // runBackup returns its failures rather than throwing, so this is the unforeseen kind. It
                // still has to be recorded, or a run that crashed would look like one that never happened.
                record = {
                    run: request.run, tag: request.tag, actor: request.actor,
                    startedAt: new Date(this.deps.now()).toISOString(), durationMs: 0,
                    outcome: 'failed', snapshot: null, reason: describeError(error), disruptive: false,
                }
            }
            await this.deps.store.record(project.id, record)
            if (record.outcome === 'failed') this.deps.log(`backup ${project.id} failed: ${record.reason}`)
        } finally {
            this.running.delete(project.id)
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/backup-runner.ts src/agent/backup-runner.test.ts && git commit -m "Start a backup without waiting for it" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The backup verb on the wire

**Files:**
- Modify: `src/shared/protocol.ts`
- Test: `src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `BackupRecord`, `BackupTag` from `src/shared/backups.ts`
- Produces: `BackupRunArgs`, `BackupListArgs`, `BackupGetRunArgs`, `BackupDeleteArgs`, `BackupDownloadArgs`, `BackupArgs`, `BackupRequest`, `BackupStartedReply`, `BackupListReply`, `BackupRunReply`, and `backup: 'backups'` in `VERB_CAPABILITY`

Snapshot ids are validated here, where every other request shape is validated, so a malformed id never reaches restic or a path. Read the existing `parseAgentRequest` and follow the same per-verb validation style.

- [ ] **Step 1: Write the failing test**

```ts
import { parseAgentRequest, SNAPSHOT_ID, VERB_CAPABILITY } from './protocol.ts'

describe('the backup verb', () => {
    it('needs the backups capability', () => {
        assert.equal(VERB_CAPABILITY.backup, 'backups')
    })

    it('accepts the five actions', () => {
        for (const args of [
            { action: 'run', tag: 'manual' },
            { action: 'list' },
            { action: 'get-run', run: 'a1b2c3d4' },
            { action: 'delete', snapshot: 'deadbeef' },
            { action: 'download', snapshot: 'deadbeef' },
        ]) {
            const parsed = parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args }))
            assert.equal(parsed.ok, true, `${args.action} should parse`)
        }
    })

    it('refuses a snapshot id that is not hex', () => {
        for (const snapshot of ['../../etc/passwd', 'deadbeef; rm -rf /', '', 'g'.repeat(8)]) {
            const parsed = parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'delete', snapshot } }))
            assert.equal(parsed.ok, false, `${snapshot} should be refused`)
        }
        assert.equal(SNAPSHOT_ID.test('deadbeefcafe1234'), true)
    })

    it('refuses an unknown tag and an unknown action', () => {
        assert.equal(parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'hourly' } })).ok, false)
        assert.equal(parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'restore' } })).ok, false)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="the backup verb"`
Expected: FAIL, `VERB_CAPABILITY.backup` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/shared/protocol.ts`:

```ts
// Restic's own short ids are hex, and this is checked here, where every other request shape is checked,
// so a malformed id can never reach a repository path or a command.
export const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/
// The agent's own run id, which it generates; validated on the way back in for the same reason.
export const RUN_ID = /^[0-9a-f]{8,32}$/

export type BackupRunArgs = { action: 'run', tag: BackupTag, keep?: Keep }
export type BackupListArgs = { action: 'list' }
export type BackupGetRunArgs = { action: 'get-run', run: string }
export type BackupDeleteArgs = { action: 'delete', snapshot: string }
export type BackupDownloadArgs = { action: 'download', snapshot: string }
export type BackupArgs = BackupRunArgs | BackupListArgs | BackupGetRunArgs | BackupDeleteArgs | BackupDownloadArgs
export type BackupRequest = { verb: 'backup', project: string, args: BackupArgs }

export type BackupStartedReply = { ok: true, started: { run: string, tag: BackupTag } }
export type BackupListReply = { ok: true, snapshots: Snapshot[], runs: BackupRecord[], running: boolean }
export type BackupRunReply = { ok: true, run: BackupRecord | null, running: boolean }
```

Add `BackupRequest` to `ProjectRequest`, the three replies to `AgentReply`, and `backup: 'backups'` to `VERB_CAPABILITY`. In `parseAgentRequest`, add the `backup` case:

```ts
        case 'backup': {
            if (!isRecord(args)) return refuse('bad-request', 'backup needs args')
            switch (args.action) {
                case 'run': {
                    if (!(BACKUP_TAGS as readonly unknown[]).includes(args.tag)) return refuse('bad-request', 'backup run needs a tag of manual or scheduled')
                    // keep is the client's retention, which api clamped to the registry ceiling before it
                    // ever got here; the agent re-clamps when it applies it.
                    if (args.keep !== undefined && !isKeep(args.keep)) return refuse('bad-request', 'keep must hold whole daily, weekly and monthly counts')
                    return { ok: true, request: { verb: 'backup', project, args: { action: 'run', tag: args.tag as BackupTag, ...(args.keep ? { keep: args.keep as Keep } : {}) } } }
                }
                case 'list':
                    return { ok: true, request: { verb: 'backup', project, args: { action: 'list' } } }
                case 'get-run':
                    if (typeof args.run !== 'string' || !RUN_ID.test(args.run)) return refuse('bad-request', 'get-run needs a run id')
                    return { ok: true, request: { verb: 'backup', project, args: { action: 'get-run', run: args.run } } }
                case 'delete':
                case 'download':
                    if (typeof args.snapshot !== 'string' || !SNAPSHOT_ID.test(args.snapshot)) return refuse('bad-request', 'a snapshot id must be hex')
                    return { ok: true, request: { verb: 'backup', project, args: { action: args.action, snapshot: args.snapshot } } }
                default:
                    return refuse('bad-request', 'backup action must be run, list, get-run, delete or download')
            }
        }
```

Add a local `isKeep` helper beside the other guards in the file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS. The typecheck will name `src/agent/server.ts`'s `describe()` switch as non-exhaustive; Task 11 adds that case, so add it now as `case 'backup': return \`backup ${request.args.action} ${request.project}\`` to keep the tree building.

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts src/shared/protocol.test.ts src/agent/server.ts && git commit -m "Put the backup verb on the wire" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: A binary channel for downloads

**Files:**
- Modify: `src/agent/agent.ts` (the `Outcome` type only), `src/agent/server.ts`, `src/api/agent-client.ts`
- Test: `src/agent/server.test.ts`, `src/api/agent-client.test.ts`

**Interfaces:**
- Consumes: the existing `{ ok: true, stream: true }` header line and `waitForDrain()` in `server.ts`
- Produces: `Outcome` gains `{ kind: 'bytes', body: AsyncIterable<Buffer>, close: () => void }`; `AgentClient` gains `download(request: ProjectRequest): Promise<{ ok: true, body: AsyncIterable<Buffer>, close(): void } | Refusal>`

The existing stream channel is NDJSON of `LogLine`, which a tar.gz cannot use without base64 inflating it by a third. This adds a third outcome that writes the same header line and then raw bytes until the socket ends, which is unambiguous because nothing else follows the header on that connection.

- [ ] **Step 1: Write the failing test**

In `src/agent/server.test.ts`, beside the existing stream tests:

```ts
it('writes a bytes outcome as a header line then raw bytes', async () => {
    const { socket, written } = fakeSocket('{"verb":"backup","project":"acme","args":{"action":"download","snapshot":"deadbeef"}}\n')
    const agent = { handle: async () => ({ kind: 'bytes' as const, body: (async function* () { yield Buffer.from('tar') ; yield Buffer.from(' bytes') })(), close: () => {} }) }
    await handleConnection(socket, agent, () => {})
    const output = Buffer.concat(written)
    const newline = output.indexOf(0x0a)
    assert.deepEqual(JSON.parse(output.subarray(0, newline).toString()), { ok: true, stream: true })
    assert.equal(output.subarray(newline + 1).toString(), 'tar bytes')
})
```

In `src/api/agent-client.test.ts`:

```ts
it('reads a download as raw bytes after the header line', async () => {
    const client = createAgentClient(fakeConnect('{"ok":true,"stream":true}\ntar bytes'))
    const result = await client.download({ verb: 'backup', project: 'acme', args: { action: 'download', snapshot: 'deadbeef' } })
    assert.equal(result.ok, true)
    const chunks: Buffer[] = []
    if (result.ok) for await (const chunk of result.body) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), 'tar bytes')
})

it('returns the refusal when the agent refuses a download', async () => {
    const client = createAgentClient(fakeConnect('{"ok":false,"code":"unknown-project","message":"no project acme"}\n'))
    const result = await client.download({ verb: 'backup', project: 'acme', args: { action: 'download', snapshot: 'deadbeef' } })
    assert.deepEqual(result, { ok: false, code: 'unknown-project', message: 'no project acme' })
})
```

Reuse whatever `fakeSocket`/`fakeConnect` helpers those two test files already define rather than writing new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="bytes outcome|raw bytes after the header"`
Expected: FAIL, `client.download is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/agent/agent.ts`:

```ts
export type Outcome =
    | { kind: 'reply', reply: AgentReply }
    | { kind: 'stream', lines: AsyncIterable<LogLine>, close: () => void }
    // A backup download: the same header line as a stream, then raw bytes until the socket ends. Its own
    // kind rather than a stream of lines because a tar.gz through NDJSON would need base64, which inflates
    // a multi-gigabyte download by a third for nothing.
    | { kind: 'bytes', body: AsyncIterable<Buffer>, close: () => void }
```

In `src/agent/server.ts`, after the `reply` branch and before the existing stream handling, add the bytes branch. It is the stream branch with `socket.write(chunk)` in place of `lineOf`:

```ts
    if (outcome.kind === 'bytes') {
        const bytes = outcome
        if (gone) {
            stopWatching()
            log(`${what} download abandoned before it started`)
            bytes.close()
            return
        }
        log(`${what} downloading`)
        let closed = false
        const abort = () => { closed = true; bytes.close() }
        stopWatching()
        socket.once('end', abort)
        socket.once('close', abort)
        try {
            if (!socket.write(lineOf({ ok: true, stream: true }))) await waitForDrain(socket)
            for await (const chunk of bytes.body) {
                if (closed) break
                if (!socket.write(chunk)) await waitForDrain(socket)
            }
            if (!closed) socket.end()
        } catch (error) {
            log(`${what} download failed: ${describeError(error)}`)
            socket.destroy()
        } finally {
            socket.off('end', abort)
            socket.off('close', abort)
            bytes.close()
            log(`${what} download ended`)
        }
        return
    }
```

In `src/api/agent-client.ts`, add `download` beside `stream`. It sends the request, reads the first line exactly as `stream` does, and then yields the remainder of the socket as buffers instead of parsing lines. Follow the existing `stream` implementation for the header timeout, the refusal path and `close()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts src/agent/server.ts src/agent/server.test.ts src/api/agent-client.ts src/api/agent-client.test.ts && git commit -m "Let the agent answer with raw bytes" -m "A backup download is a tar.gz. The stream channel carries JSON lines, and base64 would inflate a multi-gigabyte download by a third." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The agent's backup handler

**Files:**
- Modify: `src/agent/agent.ts`
- Test: `src/agent/agent.test.ts`

**Interfaces:**
- Consumes: `BackupRunner`, `BackupStore`, `Restic`, `manualProblem()`, `repoPath()`, `SNAPSHOT_ID`
- Produces: `AgentDeps.backups?: { runner: Pick<BackupRunner, 'start' | 'isRunning'>, store: Pick<BackupStore, 'get'>, restic: Restic, backupDir: string, newRunId: () => string }`, and the `backup` case in `handle()`

Absent `deps.backups`, the verb refuses `unavailable`, exactly as `deploy` and `provision` already do when their wiring is missing. The agent checks the manual cap itself: api may have checked first, but the agent never trusts that.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/agent.test.ts`, following its existing `setup()` factory:

```ts
describe('backup', () => {
    it('refuses when backups are not configured', async () => {
        const agent = makeAgent()   // the file's existing factory, with no backups wiring
        const outcome = await agent.handle({ verb: 'backup', project: 'acme', args: { action: 'list' } })
        assert.equal(outcome.kind === 'reply' && outcome.reply.ok, false)
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'unavailable')
    })

    it('lists the snapshots and the run history together', async () => {
        const agent = makeAgent({ backups: backupsWiring({ snapshots: [{ id: 'deadbeef', at: '2026-09-21T02:00:00.000Z', tag: 'manual', sizeBytes: null }] }) })
        const outcome = await agent.handle({ verb: 'backup', project: 'acme', args: { action: 'list' } })
        assert.equal(outcome.kind === 'reply' && outcome.reply.ok && outcome.reply.snapshots.length, 1)
    })

    it('refuses a sixth manual run itself, whatever api decided', async () => {
        const snapshots = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => ({ id: id.padEnd(8, '0'), at: '2026-09-21T02:00:00.000Z', tag: 'manual' as const, sizeBytes: null }))
        const agent = makeAgent({ backups: backupsWiring({ snapshots }) })
        const outcome = await agent.handle({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual' } })
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'bad-request')
    })

    it('refuses to delete a snapshot that is not in this project\'s repository', async () => {
        const agent = makeAgent({ backups: backupsWiring({ snapshots: [] }) })
        const outcome = await agent.handle({ verb: 'backup', project: 'acme', args: { action: 'delete', snapshot: 'deadbeef' } })
        assert.equal(outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code, 'bad-request')
    })

    it('answers a download with bytes', async () => {
        const agent = makeAgent({ backups: backupsWiring({ snapshots: [{ id: 'deadbeef', at: '2026-09-21T02:00:00.000Z', tag: 'manual', sizeBytes: null }] }) })
        const outcome = await agent.handle({ verb: 'backup', project: 'acme', args: { action: 'download', snapshot: 'deadbeef' } })
        assert.equal(outcome.kind, 'bytes')
    })
})
```

Write `backupsWiring()` as a local factory in the test file: a `BackupRunner`-shaped object whose `start` records the request and returns `{ ok: true, started: { run: 'run1', tag: 'manual' } }`, a store that returns `emptyBackups()`, and a `Restic` whose `snapshots` returns the given list and whose `dump` returns a `PassThrough`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="backup"`
Expected: FAIL, the `backup` verb falls through the switch.

- [ ] **Step 3: Write the implementation**

Add to `AgentDeps`:

```ts
    // Absent until the production entrypoint wires the backup directory, the store and the runner: the
    // backup verb then refuses unavailable instead of crashing, exactly like deploys and provision do.
    backups?: {
        runner: Pick<BackupRunner, 'start' | 'isRunning'>
        store: Pick<BackupStore, 'get'>
        restic: Restic
        backupDir: string
        newRunId: () => string
    }
```

Add `case 'backup': return this.backup(checked.project, request.args)` to `handle()`, returning its `Outcome` directly (the download action returns `bytes`, the rest return replies), and the method:

```ts
    private async backup(project: ProjectEntry, args: BackupArgs): Promise<Outcome> {
        if (!this.deps.backups) return reply(refuse('unavailable', 'backups are not configured'))
        const { runner, store, restic, backupDir, newRunId } = this.deps.backups
        const repo = repoPath(backupDir, project.id)
        const state = store.get(project.id)

        if (args.action === 'list') {
            const listed = await restic.snapshots(repo)
            // A repository that does not exist yet is not an error: it is a project that has never been
            // backed up, and the portal draws an empty list for it.
            const snapshots = listed.ok ? listed.snapshots : []
            return reply({ ok: true, snapshots, runs: state.runs, running: runner.isRunning(project.id) })
        }

        if (args.action === 'get-run') {
            return reply({ ok: true, run: state.runs.find(run => run.run === args.run) ?? null, running: runner.isRunning(project.id) })
        }

        if (args.action === 'run') {
            const listed = await restic.snapshots(repo)
            if (args.tag === 'manual') {
                // Checked here as well as in api: the agent never lets api's decision stand in for its own.
                const problem = manualProblem(listed.ok ? listed.snapshots : [], state.runs, Date.now())
                if (problem) return reply(refuse('bad-request', problem))
            }
            return reply(runner.start(project, {
                tag: args.tag, actor: args.tag === 'scheduled' ? 'hostd' : 'admin',
                run: newRunId(), keep: args.keep ?? null,
            }))
        }

        // delete and download both name a snapshot, and both look it up in this project's own repository
        // first: a hex id is not proof that it belongs to this client.
        const listed = await restic.snapshots(repo)
        if (!listed.ok) return reply(refuse('failed', listed.reason, listed.output))
        const snapshot = listed.snapshots.find(entry => entry.id === args.snapshot || entry.id.startsWith(args.snapshot))
        if (!snapshot) return reply(refuse('bad-request', `no backup ${args.snapshot} for ${project.id}`))

        if (args.action === 'delete') {
            const forgotten = await restic.forget(repo, snapshot.id)
            return reply(forgotten.ok ? { ok: true, output: `backup ${snapshot.id} deleted` } : refuse('failed', forgotten.reason, forgotten.output))
        }

        const handle = restic.dump(repo, snapshot.id)
        return { kind: 'bytes', body: handle.stdout, close: () => handle.stdout.destroy() }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts src/agent/agent.test.ts && git commit -m "Handle the backup verb in the agent" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: The policy split

**Files:**
- Modify: `src/api/policy.ts`
- Test: `src/api/policy.test.ts`

**Interfaces:**
- Consumes: the existing `authorize()` and `PolicyVerb`
- Produces: `PolicyVerb` gains `'backup' | 'backup-read'`, both mapped to the `backups` capability, and neither added to `ADMIN_ONLY`

Unlike deploys, both halves are available to the owning client: the design says so, and the portal screens design shows clients running and deleting their own backups. The split exists so the audit log distinguishes reading from acting.

- [ ] **Step 1: Write the failing test**

```ts
describe('backups', () => {
    const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services: { web: { role: site } }
  plain:
    client: cl_1
    name: Plain
    dir: /var/www/plain
    upstream: 127.0.0.1:5011
    capabilities: [lifecycle]
    services: { web: { role: site } }
`)
    const owner = { kind: 'client', client: 'cl_1', label: 'client:cl_1', user: 'u1' } as const
    const stranger = { kind: 'client', client: 'cl_2', label: 'client:cl_2', user: 'u2' } as const

    it('lets the owner read and act on their own backups', () => {
        assert.equal(authorize(registry, owner, 'acme', 'backup-read').ok, true)
        assert.equal(authorize(registry, owner, 'acme', 'backup').ok, true)
    })

    it('refuses a project whose backups capability is off, without confirming it exists', () => {
        const decision = authorize(registry, owner, 'plain', 'backup')
        assert.equal(decision.ok, false)
        assert.equal(!decision.ok && decision.code, 'capability-disabled')
    })

    it('gives a stranger the same 404 as a missing project', () => {
        assert.deepEqual(authorize(registry, stranger, 'acme', 'backup-read'), authorize(registry, stranger, 'nosuch', 'backup-read'))
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="backups"`
Expected: FAIL, `'backup-read'` is not a `PolicyVerb`.

- [ ] **Step 3: Write the implementation**

Extend `PolicyVerb` and `POLICY_CAPABILITY` with `backup: 'backups'` and `'backup-read': 'backups'`, and extend the comment above `PolicyVerb` to say why this one is not admin-only while `deploy` is: the client owns the data, and phase 1's backups section is written from their side.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/policy.ts src/api/policy.test.ts && git commit -m "Let a client act on their own backups" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The schedule store

**Files:**
- Create: `src/api/schedule.ts`
- Test: `src/api/schedule.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `defaultSchedule()`, `parseSchedule()`, `isDue()` from `src/shared/backups.ts`; `Registry` from `src/shared/registry.ts`
- Produces: `ScheduleFs`, `ScheduleStore` with `load()`, `warnings()`, `get(id)`, `set(id, schedule)`, `due(registry, lastRunAt, now)`

Schedules are client-set configuration, so they live in api's `/state`, not in the operator's registry. `due()` takes the last run time as a function rather than holding it, because the agent owns the run history and api asks for it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ScheduleStore, type ScheduleFs } from './schedule.ts'
import { defaultSchedule } from '../shared/backups.ts'
import { parseRegistry } from '../shared/registry.ts'

const PATH = '/state/schedules.json'
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services: { web: { role: site } }
  nobackups:
    client: cl_1
    name: Plain
    dir: /var/www/plain
    upstream: 127.0.0.1:5011
    capabilities: [lifecycle]
    services: { web: { role: site } }
`)

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const fs: ScheduleFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error('ENOENT')
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => { store.set(to, store.get(from)!); store.delete(from) },
        mkdir: async () => {},
    }
    return { fs, files: store }
}

describe('ScheduleStore', () => {
    it('gives a project with no schedule the off default', async () => {
        const store = new ScheduleStore(PATH, setup().fs)
        await store.load()
        assert.deepEqual(store.get('acme'), defaultSchedule())
    })

    it('persists a schedule and reads it back', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const second = new ScheduleStore(PATH, fs)
        await second.load()
        assert.equal(second.get('acme').mode, 'daily')
    })

    it('names only projects that are due, and never one without the capability', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        await store.set('nobackups', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const due = store.due(registry, () => null, Date.parse('2026-09-21T16:31:00Z'))
        assert.deepEqual(due.map(entry => entry.id), ['acme'])
        assert.deepEqual(due[0]?.schedule.keep, { daily: 7, weekly: 4, monthly: 3 })
    })

    it('does not name a project that already ran for this slot', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const due = store.due(registry, () => Date.parse('2026-09-21T16:31:00Z'), Date.parse('2026-09-21T17:00:00Z'))
        assert.deepEqual(due, [])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="ScheduleStore"`
Expected: FAIL, cannot find module `./schedule.ts`.

- [ ] **Step 3: Write the implementation**

Write `ScheduleStore` as `BackupStore`'s twin: the same `load`/`warnings`/atomic `save` shape (copy the structure from `src/agent/backup-state.ts`), holding `Record<string, Schedule>` under a `schedules` key, plus:

```ts
    get(id: string): Schedule {
        return this.schedules.get(id) ?? defaultSchedule()
    }

    async set(id: string, schedule: Schedule): Promise<void> {
        this.schedules.set(id, schedule)
        await this.save()
    }

    // Which projects should have a scheduled run started now. The registry is consulted every tick rather
    // than cached, so a capability the operator switches off stops the schedule immediately, and a project
    // removed from the registry stops being named without its schedule having to be cleaned up.
    due(registry: Registry, lastRunAt: (id: string) => number | null, now: number): Array<{ id: string, schedule: Schedule }> {
        const due: Array<{ id: string, schedule: Schedule }> = []
        for (const [id, schedule] of this.schedules) {
            const project = registry.projects.get(id)
            if (!project || !project.capabilities.has('backups')) continue
            if (isDue(schedule, lastRunAt(id), now)) due.push({ id, schedule })
        }
        return due
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/schedule.ts src/api/schedule.test.ts && git commit -m "Keep backup schedules in api's own state" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: The seven endpoints

**Files:**
- Modify: `src/api/routes.ts`
- Test: `src/api/routes.test.ts`

**Interfaces:**
- Consumes: `matchRoute()`, `createHandler()`, `AGENT_STATUS`, `authorize()`, the audit log, `AgentClient.download()` from Task 10, `ScheduleStore` from Task 13
- Produces: `Route` gains `backups`, `backup-run`, `backup-run-status`, `backup-delete`, `backup-download`, `backup-schedule`; `HandlerDeps` gains `schedules?: ScheduleStore`

`schedule` and `runs` sit in the same path position as a snapshot id, and are disambiguated by name before the hex check, so a snapshot can never be called either.

- [ ] **Step 1: Write the failing test**

```ts
describe('matchRoute for backups', () => {
    it('matches every backup path', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups'), { verb: 'backups', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/backups'), { verb: 'backup-run', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/runs/a1b2c3d4'), { verb: 'backup-run-status', project: 'acme', run: 'a1b2c3d4' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/deadbeef'), { verb: 'backup-delete', project: 'acme', snapshot: 'deadbeef' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/deadbeef/download'), { verb: 'backup-download', project: 'acme', snapshot: 'deadbeef' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/backups/schedule'), { verb: 'backup-schedule', project: 'acme', write: false })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/backups/schedule'), { verb: 'backup-schedule', project: 'acme', write: true })
    })

    it('does not mistake schedule or runs for a snapshot id', () => {
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/schedule'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/backups/not-hex'), { verb: 'not-found' })
    })
})

describe('the backup endpoints', () => {
    it('answers 202 with the run id when a run starts', async () => {
        const { handler, calls } = handlerSetup({ reply: { ok: true, started: { run: 'a1b2c3d4', tag: 'manual' } } })
        const response = await request(handler, 'POST', '/projects/acme/backups')
        assert.equal(response.status, 202)
        assert.deepEqual(JSON.parse(response.body), { ok: true, run: 'a1b2c3d4' })
        assert.deepEqual(calls[0], { verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual' } })
    })

    it('streams a download with a filename naming the project and the date', async () => {
        const { handler } = handlerSetup({ download: 'tar bytes' })
        const response = await request(handler, 'GET', '/projects/acme/backups/deadbeef/download')
        assert.equal(response.status, 200)
        assert.equal(response.headers['content-type'], 'application/gzip')
        assert.match(response.headers['content-disposition'] ?? '', /attachment; filename="acme-\d{4}-\d{2}-\d{2}\.tar\.gz"/)
        assert.equal(response.body, 'tar bytes')
    })

    it('clamps a written schedule to the project ceiling and gives it back', async () => {
        const { handler } = handlerSetup({})
        const response = await request(handler, 'PUT', '/projects/acme/backups/schedule', JSON.stringify({
            mode: 'daily', hour: 2, minute: 0, weekday: 0, keep: { daily: 999, weekly: 1, monthly: 1 },
        }))
        assert.equal(response.status, 200)
        assert.equal(JSON.parse(response.body).schedule.keep.daily, 14)
    })

    it('refuses a schedule that is not one', async () => {
        const { handler } = handlerSetup({})
        const response = await request(handler, 'PUT', '/projects/acme/backups/schedule', JSON.stringify({ mode: 'hourly' }))
        assert.equal(response.status, 400)
    })
})
```

Extend the file's existing handler-setup helper with a `download` option that makes `agent.download()` return those bytes, and with a `ScheduleStore` built on an in-memory `ScheduleFs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="matchRoute for backups|the backup endpoints"`
Expected: FAIL, `matchRoute` returns `not-found` for every backup path.

- [ ] **Step 3: Write the implementation**

In `matchRoute`, inside the existing `parts.length === 3` block add `if (segment === 'backups') { if (method === 'GET') return { verb: 'backups', project }; if (method === 'POST') return { verb: 'backup-run', project }; return { verb: 'method-not-allowed' } }`, and before the environment block add:

```ts
    if (segment === 'backups') {
        const next = parts[3] ?? ''
        if (parts.length === 4) {
            // Named before the hex check below, so a snapshot can never be called 'schedule'.
            if (next === 'schedule') {
                if (method === 'GET') return { verb: 'backup-schedule', project, write: false }
                if (method === 'PUT') return { verb: 'backup-schedule', project, write: true }
                return { verb: 'method-not-allowed' }
            }
            if (!SNAPSHOT_ID.test(next)) return { verb: 'not-found' }
            return only('DELETE', { verb: 'backup-delete', project, snapshot: next })
        }
        if (parts.length === 5) {
            if (next === 'runs') {
                const run = parts[4] ?? ''
                if (!RUN_ID.test(run)) return { verb: 'not-found' }
                return only('GET', { verb: 'backup-run-status', project, run })
            }
            if (!SNAPSHOT_ID.test(next) || parts[4] !== 'download') return { verb: 'not-found' }
            return only('GET', { verb: 'backup-download', project, snapshot: next })
        }
        return { verb: 'not-found' }
    }
```

In the handler switch, add the six cases. `backups`, `backup-run`, `backup-run-status` and `backup-delete` follow the existing non-streaming pattern exactly: `decide(project, verb, target)`, then `deps.agent.call(...)`, then `sendJson`. Use `'backup-read'` for the two reads and `'backup'` for the three writes. `backup-run` replies 202: `sendJson(res, 202, { ok: true, run: reply.started.run })`.

`backup-download` mirrors the `logs` case, with `deps.agent.download()` in place of `deps.agent.stream()` and these headers:

```ts
                res.writeHead(200, {
                    'content-type': 'application/gzip',
                    // The client sees a file named for their site and the day they took it, never a
                    // snapshot id or a path on the dedi.
                    'content-disposition': `attachment; filename="${route.project}-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
                    'cache-control': 'no-store',
                })
```

then `for await (const chunk of stream.body) { if (!res.write(chunk)) await waitForDrain(res); if (res.destroyed) break }` with the same `res.on('close', stop)` and `finally` shape as `logs`.

`backup-schedule` needs no agent call at all:

```ts
            case 'backup-schedule': {
                if (!deps.schedules) return refuseRoute(503, 'unavailable', 'backup schedules are not configured', route.project, 'backup-read')
                const decision = await decide(route.project, route.write ? 'backup' : 'backup-read', 'schedule')
                if (!decision) return
                if (!route.write) return sendJson(res, 200, { ok: true, schedule: deps.schedules.get(route.project) })
                const body = await readJsonBody(req, res)
                if (!body.ok) return
                // The ceiling is the operator's, from the registry, so a client can ask for less than it
                // and never more. Clamped rather than refused, and the reply says what it settled on.
                const parsed = parseSchedule(body.value, decision.project.backups.maxKeep)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.problem, route.project, 'backup', 'schedule')
                await deps.schedules.set(route.project, parsed.schedule)
                return sendJson(res, 200, { ok: true, schedule: parsed.schedule })
            }
```

`decide` currently returns a boolean; where the schedule case needs the project entry for `maxKeep`, use whatever the file's existing helper hands back (it already carries the `Decision`), following the pattern the `env-file` case uses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts src/api/routes.test.ts && git commit -m "Serve the backup endpoints" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Health, and the two new signals

**Files:**
- Modify: `src/agent/agent.ts` (the `health()` method)
- Test: `src/agent/agent.test.ts`

**Interfaces:**
- Consumes: `diskProblem()` from Task 1, `BackupStore.failures()` from Task 3
- Produces: no new exports; `HealthReply.warnings` gains the backup disk warning and one line per project whose newest scheduled run failed

The design defers exactly two signals to this phase. Both are warnings, not failures: a full backup disk and a failed scheduled run are things the operator must see, and neither makes hostd itself unhealthy.

- [ ] **Step 1: Write the failing test**

```ts
it('warns when the backup disk is nearly full', async () => {
    const agent = makeAgent({ backups: backupsWiring({ snapshots: [], disk: { path: '/backups', totalBytes: 1000, usedBytes: 950, freeBytes: 50 } }) })
    const outcome = await agent.handle({ verb: 'health' })
    const warnings = outcome.kind === 'reply' && outcome.reply.ok ? outcome.reply.warnings : []
    assert.ok(warnings.some(warning => /backup disk has less than 10% free/.test(warning)))
})

it('warns once per project whose newest scheduled backup failed', async () => {
    const agent = makeAgent({ backups: backupsWiring({ snapshots: [], failures: ['acme: the newest scheduled backup failed: the dump failed'] }) })
    const outcome = await agent.handle({ verb: 'health' })
    const warnings = outcome.kind === 'reply' && outcome.reply.ok ? outcome.reply.warnings : []
    assert.ok(warnings.includes('acme: the newest scheduled backup failed: the dump failed'))
})

it('says nothing about backups when they are not configured', async () => {
    const agent = makeAgent()
    const outcome = await agent.handle({ verb: 'health' })
    const warnings = outcome.kind === 'reply' && outcome.reply.ok ? outcome.reply.warnings : []
    assert.equal(warnings.some(warning => /backup/.test(warning)), false)
})
```

Extend `backupsWiring()` with optional `disk` and `failures`, and add `backupDisk: () => Promise<DiskUsage | null>` and `store.failures()` to the wiring object.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="backup disk|scheduled backup failed"`
Expected: FAIL, no such warnings.

- [ ] **Step 3: Write the implementation**

Add `backupDisk: () => Promise<DiskUsage | null>` and widen `store` to `Pick<BackupStore, 'get' | 'failures'>` in `AgentDeps.backups`, then in `health()`, after the existing warnings are collected:

```ts
        if (this.deps.backups) {
            // Two signals the design defers to the backups phase. Warnings, not failures: a full backup
            // disk and a failed scheduled run are the operator's to act on, and neither means hostd itself
            // is unhealthy.
            const problem = diskProblem(await this.deps.backups.backupDisk())
            if (problem) warnings.push(problem)
            warnings.push(...this.deps.backups.store.failures())
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts src/agent/agent.test.ts && git commit -m "Shout about a full backup disk and a failed schedule" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Wiring both processes

**Files:**
- Modify: `src/agent/index.ts`, `src/api/index.ts`
- Test: none new; this is composition of parts that are each already tested. `npm test` and `npm run typecheck` must both stay green.

**Interfaces:**
- Consumes: everything built above
- Produces: `HOSTD_BACKUP_DIR` (default `/backups`) and `HOSTD_BACKUP_STATE_FILE` (default `/var/lib/hostd/backups.json`) in the agent; the schedule tick in api

- [ ] **Step 1: Wire the agent**

In `src/agent/index.ts`, beside the deploy wiring:

```ts
const BACKUP_DIR = process.env.HOSTD_BACKUP_DIR ?? '/backups'
const BACKUP_STATE_FILE = process.env.HOSTD_BACKUP_STATE_FILE ?? '/var/lib/hostd/backups.json'
const PRUNE_MS = 7 * 24 * 60 * 60_000
```

Then the adapters and the wiring, beside the deploy wiring already there:

```ts
const backupFs: BackupFs = {
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
    writeStream: path => {
        const sink = createWriteStream(path)
        const done = new Promise<void>((resolve, reject) => {
            sink.on('finish', resolve)
            sink.on('error', reject)
        })
        return { sink, done }
    },
    remove: async path => { await rm(path, { recursive: true, force: true }) },
    copy: async (from, to) => { await cp(from, to, { recursive: true }) },
    exists: async path => {
        try {
            await stat(path)
            return true
        } catch {
            return false
        }
    },
}

const backupStore = new BackupStore(BACKUP_STATE_FILE, undefined, log)
await backupStore.load()
const restic = createRestic(runner, nodeSpawnStream())
const backupDeps: BackupRunnerDeps = {
    backupDir: BACKUP_DIR,
    restic,
    docker,
    runner,
    fs: backupFs,
    disk: async () => (await readSystemUsage(systemSource(), BACKUP_DIR)).disk,
    now: () => Date.now(),
    log,
    store: backupStore,
    // Both environments: a deploy of either renames a directory beside the one being backed up, and the
    // live tree is what a backup reads.
    deployRunning: id => ENVIRONMENTS.some(environment => deployRunner.isRunning(deployKey(id, environment))),
}
const backupRunner = new BackupRunner(backupDeps)
```

and in the `AgentDeps` passed to `new Agent(...)`:

```ts
    backups: {
        runner: backupRunner,
        store: backupStore,
        restic,
        backupDir: BACKUP_DIR,
        // Six bytes of hex, which is what RUN_ID accepts.
        newRunId: () => randomBytes(6).toString('hex'),
        backupDisk: async () => (await readSystemUsage(systemSource(), BACKUP_DIR)).disk,
    },
```

- [ ] **Step 2: Add the weekly prune to the agent's main loop**

Following the shape of api's existing audit prune, once a week per repository, skipped entirely while `runner.isBusy()`:

```ts
        // Prunes are expensive and take the repository lock, so they never run while a backup might want
        // it, and they are skipped rather than queued: next week is soon enough.
        if (Date.now() - lastPrune >= PRUNE_MS && !backupRunner.isBusy()) {
            for (const project of registry().projects.values()) {
                if (!project.capabilities.has('backups')) continue
                const pruned = await restic.prune(repoPath(BACKUP_DIR, project.id))
                if (!pruned.ok) log(`WARN prune of ${project.id} failed: ${pruned.reason}`)
            }
            lastPrune = Date.now()
        }
```

- [ ] **Step 3: Wire api's schedule tick**

In `src/api/index.ts`, build the `ScheduleStore` on `join(STATE_DIR, 'schedules.json')`, load it before the server starts, pass it to `createHandler` as `schedules`, and add a one-minute tick to the main loop. The tick asks the agent for each due project's history to find its last run, so the catch-up rule needs no state of its own:

```ts
        // One minute, as the design says. A slot that fell due while api was down is caught by isDue
        // comparing against the last run rather than against the tick, so this also covers startup.
        if (Date.now() - lastTick >= SCHEDULE_TICK_MS) {
            lastTick = Date.now()
            try {
                const registry = store.current()
                const lastRuns = new Map<string, number | null>()
                for (const id of registry.projects.keys()) {
                    const reply = await agent.call({ verb: 'backup', project: id, args: { action: 'list' } })
                    const newest = reply.ok && 'runs' in reply ? reply.runs[0] : undefined
                    lastRuns.set(id, newest ? Date.parse(newest.startedAt) : null)
                }
                for (const { id, schedule } of schedules.due(registry, id => lastRuns.get(id) ?? null, Date.now())) {
                    const started = await agent.call({ verb: 'backup', project: id, args: { action: 'run', tag: 'scheduled', keep: schedule.keep } })
                    // A refusal here is ordinary: another backup may hold the dedi-wide lock, and the next
                    // tick tries again because the slot is still unsatisfied.
                    if (!started.ok) log(`scheduled backup for ${id} was not started: ${started.message}`)
                    else log(`scheduled backup for ${id} started`)
                }
            } catch (error) {
                log(`WARN the backup schedule tick failed: ${describeError(error)}`)
            }
        }
```

- [ ] **Step 4: Run everything**

Run: `npm test` then `npm run typecheck`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add src/agent/index.ts src/api/index.ts && git commit -m "Wire backups into both processes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 17: The image, the compose file and the runbook

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `RUNBOOK.md`, `.gitignore`
- Create: `example.env.agent`

**Interfaces:**
- Consumes: `HOSTD_BACKUP_DIR` and `HOSTD_BACKUP_STATE_FILE` from Task 16
- Produces: nothing in code; this is what makes the phase deployable

- [ ] **Step 1: Add restic and sqlite to the agent image**

In `Dockerfile`, the agent target only. api and fetcher must not gain either.

```dockerfile
FROM base AS agent
# restic takes the backups; sqlite3 is how a sqlite database is copied safely under a concurrent writer.
# Neither belongs in api or fetcher: only the agent ever runs them.
RUN apk add --no-cache docker-cli docker-cli-compose restic sqlite
CMD ["node", "--import", "tsx", "src/agent/index.ts"]
```

- [ ] **Step 2: Mount the backup directory and give the agent an env file**

In `docker-compose.yml`, under `agent`:

```yaml
    # RESTIC_PASSWORD, and nothing else. The agent's other settings are inline below because this file is
    # committed; a password cannot be.
    env_file: .env.agent
    environment:
      ...
      HOSTD_BACKUP_DIR: /backups
      HOSTD_BACKUP_STATE_FILE: /var/lib/hostd/backups.json
    volumes:
      ...
      # The host's backup disk. Its own bind mount rather than a volume: the operator chooses which disk
      # this is, and a restore has to be able to reach these files without Docker.
      - ${HOSTD_BACKUP_DIR:-/srv/backups/hostd}:/backups
```

- [ ] **Step 3: Write `example.env.agent` and ignore the filled copy**

```
# Copy to hostd/.env.agent on the dedi and fill in. Never commit the filled-in copy.
# Generate the password on the dedi with:  openssl rand -hex 32
#
# KEEP A COPY OF THIS SOMEWHERE THAT IS NOT THE DEDI. Without it every backup repository is unreadable,
# and a lost dedi is exactly the situation the backups exist for.
RESTIC_PASSWORD=
```

Add `.env.agent` to `.gitignore` beside the existing `.env` entries.

- [ ] **Step 4: Write the runbook sections**

Add to `RUNBOOK.md`, in its existing voice:

1. **Setting backups up**: create the backup directory on the host, generate `RESTIC_PASSWORD`, where to keep the copy of it, and how to switch the `backups` capability on for a project.
2. **What is and is not backed up**: databases and storage directories of the live environment; not test, not the compose file, not env files, not source. And plainly: **backups are local to the dedi until the offsite phase lands, so a lost dedi loses them.**
3. **Restoring**, per engine, written out as commands: find the snapshot with `restic -r /srv/backups/hostd/<id> snapshots`, restore it to a staging path with `restic restore`, stop the site with `docker compose stop`, put the storage directories back, load the dump (`psql -f`, `mysql <`, `mongorestore --archive --gzip`, copy the sqlite file, copy the rdb into place), then start the site. Say at the top that this is deliberately manual, and why.
4. **When a backup is refused**: the disk under 10% free, the five manual snapshot cap, the 10-minute cooldown, and another backup holding the dedi-wide lock.
5. **The generic engine**: it stops the database service briefly, which is why writing a dump method for a new engine is worth doing.

- [ ] **Step 5: Verify and commit**

Run: `npm test` then `npm run typecheck`
Expected: PASS.

Check the docs carry no em dashes: `grep -c $'\xe2\x80\x94' RUNBOOK.md example.env.agent` must print 0 for both.

```bash
git add Dockerfile docker-compose.yml example.env.agent .gitignore RUNBOOK.md && git commit -m "Make the backups phase deployable" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done means

- `npm test` and `npm run typecheck` both pass from `hostd/`.
- A project with the `backups` capability can be listed, run manually, have that run's record read back, have a snapshot deleted, and have one downloaded as a tar.gz.
- A schedule can be read and written, is clamped to the registry ceiling, and a due slot starts a run within a minute of falling due.
- A failed dump leaves no snapshot and a record saying why.
- Health warns about a backup disk under 10% free and about a project whose newest scheduled run failed.
- `RUNBOOK.md` carries the restore procedure and says that backups are local until the offsite phase lands.

## Deliberately not built here, and named in the PR

- **The offsite copy to R2**, with `restic copy`, offsite retention, deletion tombstones and offsite prunes. The agent has no network namespace, so it is its own design; see the spec's "Why offsite is not here".
- **Restore from the portal.** A runbook procedure by design.
- **The portal's Backups tab**, which is the next slice on top of these endpoints.
- **Storage directories inside a deployed tree.** The spec's "A hazard this work does not fix": a deploy renames the directory storage lives under. It belongs to provisioning and deploys, and no project is in that position yet.
