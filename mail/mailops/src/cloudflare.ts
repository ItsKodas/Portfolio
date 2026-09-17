// The Cloudflare DNS client. The token can edit every record in the zone, including the ones serving the
// live site, so the guard lives here at the edge rather than in the caller: update and delete refuse any
// record that does not carry our comment, and no request is sent when they refuse.

import type { DesiredRecord } from './desired.ts'
import { REQUEST_TIMEOUT_MS } from './adapters.ts'

export const MANAGED_COMMENT = 'managed-by:mailops'

export type CloudflareRecord = {
    id: string
    type: string
    name: string
    content: string
    ttl: number
    proxied?: boolean
    priority?: number
    comment?: string
}

export class UnmanagedRecordError extends Error {
    constructor(record: CloudflareRecord) {
        super(`Refusing to modify ${record.type} ${record.name}: it is not stamped ${MANAGED_COMMENT}`)
        this.name = 'UnmanagedRecordError'
    }
}

export function isManaged(record: CloudflareRecord): boolean {
    return record.comment === MANAGED_COMMENT
}

// DNS splits a TXT string longer than 255 characters into multiple strings, and Cloudflare hands the
// result back in `content` as `"chunk one" "chunk two"` rather than as the concatenated value that was
// sent. A 2048-bit DKIM record is roughly 430 characters, so it always comes back chunked. Comparing
// the raw strings means the record never agrees with itself and reconcile PATCHes it every cycle,
// forever, using the token that can edit the production zone. Compare the values, not the wire form.
export function normaliseTxtContent(raw: string): string {
    const trimmed = raw.trim()
    // Only a fully quoted value is in the chunked wire form. Anything else is returned untouched, so a
    // plain value that merely happens to contain a quote cannot be mangled.
    if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return raw
    const chunks = trimmed.match(/"[^"]*"/g)
    if (!chunks) return raw
    return chunks.map(chunk => chunk.slice(1, -1)).join('')
}

function contentMatches(existing: CloudflareRecord, desired: DesiredRecord): boolean {
    if (desired.type !== 'TXT') return existing.content === desired.content
    return normaliseTxtContent(existing.content) === normaliseTxtContent(desired.content)
}

export function matches(existing: CloudflareRecord, desired: DesiredRecord): boolean {
    return contentMatches(existing, desired)
        && existing.ttl === desired.ttl
        && (existing.proxied ?? false) === (desired.proxied ?? false)
        && (existing.priority ?? null) === (desired.priority ?? null)
}

export interface DnsApi {
    list(name: string, type: string): Promise<CloudflareRecord[]>
    create(desired: DesiredRecord): Promise<void>
    update(existing: CloudflareRecord, desired: DesiredRecord): Promise<void>
}

function body(desired: DesiredRecord) {
    return JSON.stringify({
        type: desired.type,
        name: desired.name,
        content: desired.content,
        ttl: desired.ttl,
        ...(desired.proxied !== undefined && { proxied: desired.proxied }),
        ...(desired.priority !== undefined && { priority: desired.priority }),
        comment: MANAGED_COMMENT,
    })
}

export function createCloudflareApi(token: string, zoneId: string, fetchImpl: typeof fetch = fetch): DnsApi {
    const root = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    async function call(url: string, init?: RequestInit): Promise<unknown> {
        // Without this, undici's 300 second default means a stalled request freezes the whole cycle for
        // five intervals: no log line, no status write, and a healthcheck reading a stale ok: true.
        const response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        const payload = await response.json() as { success: boolean, errors?: { message: string }[], result: unknown }
        if (!payload.success) {
            throw new Error(`Cloudflare API error: ${payload.errors?.map(e => e.message).join('; ') || response.status}`)
        }
        return payload.result
    }

    return {
        async list(name, type) {
            const query = new URLSearchParams({ name, type })
            return await call(`${root}?${query}`) as CloudflareRecord[]
        },
        async create(desired) {
            await call(root, { method: 'POST', body: body(desired) })
        },
        async update(existing, desired) {
            // Checked before the request is built, so a refusal cannot race a partially formed write.
            if (!isManaged(existing)) throw new UnmanagedRecordError(existing)
            await call(`${root}/${existing.id}`, { method: 'PATCH', body: body(desired) })
        },
    }
}
