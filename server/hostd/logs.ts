// Opening hostd's log stream. Unlike every other call this returns the Response itself, because the body
// is a stream the route handler pipes to the browser rather than something to parse. No timeout either:
// a follow stream is meant to stay open, and hostd closes it after an hour.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'

export type LogQuery = {
    service: string
    tail?: number
    since?: string
    follow?: boolean
}

export type LogStream =
    | { ok: true, response: Response }
    | { ok: false, code: string, message: string }

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// Shared by every caller that opens a stream on hostd (logs, deploy watch, ...), so a change to how hostd
// is addressed or how it reports a refusal cannot reach one caller and miss another.
export async function fetchHostdStream(
    config: HostdConfig,
    caller: Caller,
    path: string,
    fetchImpl: typeof fetch,
): Promise<LogStream> {
    let response: Response
    try {
        response = await fetchImpl(`${config.url}${path}`, {
            headers: {
                Authorization: `Bearer ${config.token}`,
                'X-Hostd-Actor': caller.actor,
                'X-Hostd-User': caller.user,
            },
            cache: 'no-store',
        })
    } catch {
        return { ok: false, code: 'unavailable', message: 'hostd is not answering' }
    }

    if (!response.ok) {
        let refusal: { code?: unknown, message?: unknown } = {}
        try {
            refusal = await response.json() as typeof refusal
        } catch {
            // hostd answered with something that is not a refusal document
        }
        return {
            ok: false,
            code: typeof refusal.code === 'string' ? refusal.code : 'failed',
            message: typeof refusal.message === 'string' ? refusal.message : `hostd returned ${response.status}`,
        }
    }

    return { ok: true, response }
}

export async function openLogStream(
    config: HostdConfig,
    caller: Caller,
    id: string,
    query: LogQuery,
    fetchImpl: typeof fetch = fetch,
): Promise<LogStream> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }

    const params = new URLSearchParams({ service: query.service })
    if (query.tail !== undefined) params.set('tail', String(query.tail))
    if (query.since) params.set('since', query.since)
    if (query.follow) params.set('follow', '1')

    return fetchHostdStream(config, caller, `/projects/${id}/logs?${params}`, fetchImpl)
}
