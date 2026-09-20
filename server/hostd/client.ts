// One request function, so the headers are built in one place and a caller cannot forget one. Failures are
// returned rather than thrown: hostd being down makes a control unavailable, it does not stop a page
// rendering.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'

export type HostdResult<T> =
    | { ok: true, value: T }
    | { ok: false, code: string, message: string }

const TIMEOUT_MS = 10_000

export async function hostdRequest<T>(
    config: HostdConfig,
    caller: Caller,
    path: string,
    init: RequestInit = {},
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<T>> {
    let response: Response
    try {
        response = await fetchImpl(`${config.url}${path}`, {
            ...init,
            headers: {
                ...(init.headers as Record<string, string> | undefined),
                Authorization: `Bearer ${config.token}`,
                'X-Hostd-Actor': caller.actor,
                'X-Hostd-User': caller.user,
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
    } catch {
        // A refused connection, a DNS failure or the timeout above all mean the same thing to a caller.
        return { ok: false, code: 'unavailable', message: 'hostd is not answering' }
    }

    let body: unknown
    try {
        body = await response.json()
    } catch {
        return { ok: false, code: 'unavailable', message: 'hostd answered with something unreadable' }
    }

    if (!response.ok) {
        const refusal = body as { code?: unknown, message?: unknown }
        return {
            ok: false,
            code: typeof refusal.code === 'string' ? refusal.code : 'failed',
            message: typeof refusal.message === 'string' ? refusal.message : `hostd returned ${response.status}`,
        }
    }

    return { ok: true, value: body as T }
}
