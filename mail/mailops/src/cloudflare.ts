// The Cloudflare DNS client. The token can edit every record in the zone, including the ones serving the
// live site, so the guard lives here at the edge rather than in the caller: update and delete refuse any
// record that does not carry our comment, and no request is sent when they refuse.

import type { DesiredRecord } from './desired.ts'

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

export function matches(existing: CloudflareRecord, desired: DesiredRecord): boolean {
    return existing.content === desired.content
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
        const response = await fetchImpl(url, { ...init, headers })
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
