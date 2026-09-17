// Desired versus actual, writing only the difference. Runs every cycle, so the code path that sets the zone
// up initially is the same one that repairs it after an unattended IP change at 3am.

import { isManaged, matches, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'

export type ReconcileResult = {
    created: string[]
    updated: string[]
    unchanged: string[]
    conflicts: string[]
}

const label = (record: { type: string, name: string }) => `${record.type} ${record.name}`

export async function reconcile(api: DnsApi, desired: DesiredRecord[]): Promise<ReconcileResult> {
    const result: ReconcileResult = { created: [], updated: [], unchanged: [], conflicts: [] }

    for (const want of desired) {
        const existing: CloudflareRecord[] = await api.list(want.name, want.type)
        const ours = existing.find(isManaged)

        if (ours) {
            if (matches(ours, want)) result.unchanged.push(label(want))
            else {
                await api.update(ours, want)
                result.updated.push(label(want))
            }
            continue
        }

        // Something is already at this name and type that we did not create. Adopting it would mean editing
        // a record a human put there deliberately, so surface it and leave it completely alone.
        if (existing.length > 0) {
            result.conflicts.push(label(want))
            continue
        }

        await api.create(want)
        result.created.push(label(want))
    }

    return result
}
