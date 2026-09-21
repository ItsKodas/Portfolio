// Decides which domains are due to be checked, and what a check's outcome does to a record.
//
// A pending domain is checked every minute for its first hour, then every fifteen minutes, and gives up
// after 72 hours measured from firstSeenAt. An active domain is checked once a day. A broken domain, one
// that was active and stopped answering, is checked forever at the same pending cadence: it must come
// back on its own when a DNS blip passes, without a client having to click a retry button. An unmanaged
// record (no vhost written for it yet) and a failed one (already gave up; only a manual retry revives it)
// are never scheduled at all.

import { domainKey, type DomainRecord } from './domain-state.ts'
import { verifyHostname, type VerifyOutcome } from './verify.ts'

export const FAST_EVERY_MS = 60_000
export const SLOW_EVERY_MS = 15 * 60_000
export const FAST_FOR_MS = 60 * 60_000
export const GIVE_UP_AFTER_MS = 72 * 60 * 60_000
export const ACTIVE_EVERY_MS = 24 * 60 * 60_000

// Exported so a test can advance a mocked clock by exactly the interval `start()` schedules on, rather
// than duplicating the number and risking it drifting from the real one.
export const CHECK_INTERVAL_MS = 30_000

// The cadence for a record that is still being proved: fast while it is young, then slow, for as long as
// it takes. Used by both `pending` (racing the 72 hour clock) and `broken` (which never races anything).
function cadence(record: DomainRecord): number {
    const checkedAt = record.checkedAt === null ? Date.parse(record.firstSeenAt) : Date.parse(record.checkedAt)
    const age = checkedAt - Date.parse(record.firstSeenAt)
    return age < FAST_FOR_MS ? FAST_EVERY_MS : SLOW_EVERY_MS
}

// Derives the next check time from what is on disk (`checkedAt`, `firstSeenAt`) and nothing else. No
// timer is kept per record, because `api` restarts, and a timer that started counting again on every
// restart would restart the very 72 hour countdown a client is waiting out while their DNS propagates. A
// record that has never been checked is due immediately, at the moment it was first seen.
export function nextCheckAt(record: DomainRecord): number | null {
    if (record.state === 'unmanaged' || record.state === 'failed') return null
    if (record.checkedAt === null) return Date.parse(record.firstSeenAt)

    const checkedAt = Date.parse(record.checkedAt)
    if (record.state === 'active') return checkedAt + ACTIVE_EVERY_MS
    return checkedAt + cadence(record)
}

export function dueNow(records: DomainRecord[], now: number): DomainRecord[] {
    return records.filter(record => {
        const due = nextCheckAt(record)
        return due !== null && due <= now
    })
}

// Applies a single check's outcome to a record. `now` is the moment the check completed, always recorded
// as `checkedAt` whichever way it went.
export function afterCheck(record: DomainRecord, outcome: VerifyOutcome, now: string): DomainRecord {
    if (outcome.ok) {
        return { ...record, state: 'active', checkedAt: now, error: null, attempts: 0 }
    }

    // An active site that stops answering goes to `broken`, not `pending`: `pending` would restart the
    // 72 hour countdown and eventually give up on a site that is merely having a bad afternoon.
    if (record.state === 'active') {
        return { ...record, state: 'broken', checkedAt: now, error: outcome.client, attempts: record.attempts + 1 }
    }

    // A broken record never ages out, however long it has been broken: it must come back by itself.
    if (record.state === 'broken') {
        return { ...record, checkedAt: now, error: outcome.client, attempts: record.attempts + 1 }
    }

    // Otherwise it is `pending`, racing the 72 hour clock from firstSeenAt.
    const age = Date.parse(now) - Date.parse(record.firstSeenAt)
    const state = age >= GIVE_UP_AFTER_MS ? 'failed' : 'pending'
    return { ...record, state, checkedAt: now, error: outcome.client, attempts: record.attempts + 1 }
}

// What a record needs verified against: the scheme to request and whether the CNAME is expected to be
// proxied, both a function of the environment's certificate mode rather than anything a DomainRecord
// carries itself.
export type VerifyTarget = { scheme: 'http' | 'https', proxied: boolean }

// The slice of DomainStore the Verifier actually needs. Structural rather than importing the class
// itself, so a test can hand it a plain in-memory fake instead of a real DomainStore backed by a
// filesystem; a real DomainStore still satisfies this shape, so production wiring is unaffected.
export type RecordStore = {
    get(key: string): DomainRecord | undefined
    all(): DomainRecord[]
    put(record: DomainRecord): Promise<void>
}

// One interval over disk state, rather than a timer per record. `api` restarts (a deploy, a crash, an
// operator's Ctrl-C), and a per-record timer would begin the 72 hours again every time it did, which is
// exactly the situation a client is in while they wait for their DNS to propagate: they would never see
// their site marked `failed`, but they would also never see hostd give up gracefully and tell them so.
// Deriving `nextCheckAt` from what is on disk instead means a restart resumes the same schedule it left,
// and a single 30 second interval asking `dueNow` for the work is the whole scheduler.
export class Verifier {
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(
        private readonly store: RecordStore,
        private readonly fetchImpl: typeof fetch,
        private readonly target: (record: DomainRecord) => VerifyTarget,
        private readonly log: (message: string) => void = () => {},
        private readonly now: () => number = Date.now,
    ) {}

    start(): void {
        if (this.timer !== null) return
        this.timer = setInterval(() => { this.tick().catch(error => this.log(`verifier tick failed: ${String(error)}`)) }, CHECK_INTERVAL_MS)
    }

    stop(): void {
        if (this.timer === null) return
        clearInterval(this.timer)
        this.timer = null
    }

    // Forces one record regardless of schedule. A `failed` record is reset to `pending` first, with a
    // fresh `firstSeenAt`, or a manual retry would have nothing to schedule: dueNow would still see the
    // original 72 hours as spent and the very next tick would fail it right back.
    //
    // Resetting `firstSeenAt` (not just `state`) is deliberate and easy to mistake for redundant: a
    // record only reaches `failed` once its `firstSeenAt` is already at least 72 hours old, by
    // construction (see afterCheck). Flip the state back to `pending` without also moving `firstSeenAt`
    // and the very next check reads an age that is still past GIVE_UP_AFTER_MS, failing it right back
    // before the client's retry has had a single chance to succeed. Do not remove this line.
    async checkNow(key: string): Promise<void> {
        const record = this.store.get(key)
        if (record === undefined) return

        const target = record.state === 'failed'
            ? { ...record, state: 'pending' as const, attempts: 0, error: null, firstSeenAt: new Date(this.now()).toISOString() }
            : record
        await this.check(target)
    }

    // Exposed (rather than private) so a test can drive one pass directly against an injected clock and
    // fake store/fetch, with no real timer involved. `start()` still schedules it the same way in
    // production; this only widens who is allowed to call it.
    async tick(): Promise<void> {
        const due = dueNow(this.store.all(), this.now())
        for (const record of due) {
            await this.check(record).catch(error => this.log(`check failed for ${domainKey(record.project, record.environment, record.hostname)}: ${String(error)}`))
        }
    }

    private async check(record: DomainRecord): Promise<void> {
        if (record.token === null) return // nothing to prove without a token; there is no vhost to reach yet
        const { scheme, proxied } = this.target(record)
        const outcome = await verifyHostname(this.fetchImpl, record.hostname, record.token, scheme, proxied)
        const updated = afterCheck(record, outcome, new Date(this.now()).toISOString())
        await this.store.put(updated)
    }
}
