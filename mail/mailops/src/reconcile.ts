// Desired versus actual, writing only the difference. Runs every cycle, so the code path that sets the zone
// up initially is the same one that repairs it after an unattended IP change at 3am.

import { isManaged, matches, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'

export type ReconcileResult = {
    created: string[]
    updated: string[]
    unchanged: string[]
    conflicts: string[]
    loops: string[]
}

const label = (record: { type: string, name: string }) => `${record.type} ${record.name}`

// After this many consecutive cycles of writing the same desired content to the same record without it
// ever coming back as a match, stop writing it. A write that never converges is a bug somewhere, and
// the cost of leaving it running is an unbounded stream of PATCHes against the token that can edit the
// production zone, signalled only by a log line an operator learns to ignore. This guards against every
// future normalisation surprise, not just the chunked-TXT one that prompted it.
export const MAX_CONSECUTIVE_UPDATES = 3

export type WriteTracker = Map<string, { content: string, updates: number }>

// reconcile is otherwise pure and called fresh each cycle, so the counter has to be owned by the caller.
// Passing it in keeps reconcile testable with no network and no module-level state.
export function createWriteTracker(): WriteTracker {
    return new Map()
}

export async function reconcile(api: DnsApi, desired: DesiredRecord[], tracker: WriteTracker = createWriteTracker()): Promise<ReconcileResult> {
    const result: ReconcileResult = { created: [], updated: [], unchanged: [], conflicts: [], loops: [] }

    for (const want of desired) {
        const key = label(want)
        const returned: CloudflareRecord[] = await api.list(want.name, want.type)

        // The name and type go to the API as query parameters, and the result of that server-side
        // filter is what we pick a record to PATCH from. Cloudflare's v4 API has grown name.exact /
        // name.contains / name.endswith variants, and our SPF record (dev.horizons.gg TXT) is a
        // suffix of our DMARC record (_dmarc.dev.horizons.gg TXT). If that filter's semantics ever
        // loosen, the wrong record is the one we overwrite. Re-check locally; it costs nothing.
        const existing = returned.filter(r => r.name === want.name && r.type === want.type)
        const ours = existing.find(isManaged)

        if (ours) {
            if (matches(ours, want)) {
                result.unchanged.push(key)
                tracker.delete(key)
                continue
            }

            const seen = tracker.get(key)
            const repeat = seen && seen.content === want.content
            if (repeat && seen.updates >= MAX_CONSECUTIVE_UPDATES) {
                result.loops.push(key)
                continue
            }

            await api.update(ours, want)
            result.updated.push(key)
            tracker.set(key, { content: want.content, updates: repeat ? seen.updates + 1 : 1 })
            continue
        }

        // Something is already at this name and type that we did not create. Adopting it would mean editing
        // a record a human put there deliberately, so surface it and leave it completely alone.
        if (existing.length > 0) {
            result.conflicts.push(key)
            tracker.delete(key)
            continue
        }

        await api.create(want)
        result.created.push(key)
        tracker.delete(key)
    }

    return result
}
