// The audit log: one JSON line per event, one file per UTC month, twelve months kept. Every mutation,
// every log stream opened and every refusal is recorded; plain reads are not. The agent keeps its own
// record on stdout, which this process cannot reach.

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describeError } from '../shared/formats.ts'

export type AuditOutcome = 'ok' | 'refused' | 'failed'
export type AuditEvent = {
    ts: string
    actor: string
    user: string
    project: string | null
    verb: string
    target: string | null
    outcome: AuditOutcome
    reason?: string
    durationMs: number
    output?: string
}

export const RETENTION_MONTHS = 12
export const MAX_AUDIT_READ = 500
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/

export function monthFile(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

export function filesToPrune(names: string[], now: Date): string[] {
    const current = now.getUTCFullYear() * 12 + now.getUTCMonth()
    return names.filter(name => {
        const match = name.match(MONTH_FILE)
        if (!match) return false
        const index = Number(match[1]) * 12 + Number(match[2]) - 1
        return index <= current - RETENTION_MONTHS
    })
}

export class AuditLog {
    private lastError: string | null = null

    constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

    // Never throws: by the time an event is written, the action it records has already happened.
    async append(event: AuditEvent): Promise<void> {
        try {
            await mkdir(this.dir, { recursive: true })
            await appendFile(join(this.dir, monthFile(new Date(event.ts))), `${JSON.stringify(event)}\n`)
            this.lastError = null
        } catch (error) {
            this.lastError = describeError(error)
            console.error(`[api] ${new Date().toISOString()} audit write failed: ${this.lastError}`)
        }
    }

    async read(options: { project?: string, limit: number }): Promise<AuditEvent[]> {
        let names: string[]
        try {
            names = await readdir(this.dir)
        } catch {
            return []
        }
        const events: AuditEvent[] = []
        for (const name of names.filter(n => MONTH_FILE.test(n)).sort().reverse()) {
            const lines = (await readFile(join(this.dir, name), 'utf8')).split('\n').reverse()
            for (const line of lines) {
                if (line === '') continue
                let parsed: AuditEvent
                try {
                    parsed = JSON.parse(line) as AuditEvent
                } catch {
                    continue
                }
                if (options.project !== undefined && parsed.project !== options.project) continue
                events.push(parsed)
                if (events.length >= options.limit) return events
            }
        }
        return events
    }

    async prune(): Promise<string[]> {
        let names: string[]
        try {
            names = await readdir(this.dir)
        } catch {
            return []
        }
        const expired = filesToPrune(names, this.now())
        for (const name of expired) await rm(join(this.dir, name), { force: true })
        return expired
    }

    warnings(): string[] {
        return this.lastError ? [`the audit log could not be written: ${this.lastError}`] : []
    }
}
