// status.json, written by each process and read by its Docker healthcheck. Environmental problems never
// stop the service; they land here instead, so the operator sees them without anything going down.

import { writeFile, rename } from 'node:fs/promises'

export type Status = { ok: boolean, checkedAt: string, warnings: string[] }

// A process that hangs stops writing its status. Without an age limit its last ok: true would stand
// forever, which is the failure the mail stack's healthcheck had.
export const HEALTHCHECK_MAX_AGE_MS = 180_000

export function buildStatus(warnings: string[], now: Date): Status {
    return { ok: warnings.length === 0, checkedAt: now.toISOString(), warnings }
}

// Write then rename, so the healthcheck never reads a half-written file.
export async function writeStatus(path: string, status: Status): Promise<void> {
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(status, null, 2))
    await rename(temporary, path)
}

export function isHealthy(text: string, now: number): boolean {
    try {
        const status = JSON.parse(text) as Partial<Status>
        return status.ok === true
            && typeof status.checkedAt === 'string'
            && now - Date.parse(status.checkedAt) < HEALTHCHECK_MAX_AGE_MS
    } catch {
        return false
    }
}
