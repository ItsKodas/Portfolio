// Relays hostd's log stream to a browser. The browser names a project and a service and nothing else: the
// caller comes from the session, the token never leaves the server, and a client's ownership is checked
// here before hostd is asked.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'
import { forClient } from './errors'
import type { LogStream } from './logs'

export type RelayDeps = {
    config: HostdConfig
    caller: Caller
    // null when the caller is the operator, who owns everything
    clientId: string | null
    assertOwned: (clientId: string, projectId: string) => Promise<boolean>
    openLogStream: (
        config: HostdConfig,
        caller: Caller,
        id: string,
        query: { service: string, tail?: number, since?: string, follow?: boolean },
    ) => Promise<LogStream>
}

const STATUS: Record<string, number> = {
    'not-found': 404,
    forbidden: 403,
    'bad-request': 400,
    'agent-unavailable': 503,
    unavailable: 503,
}

function problem(code: string): Response {
    return Response.json({ code, message: forClient(code) }, { status: STATUS[code] ?? 500 })
}

export async function relayLogs(deps: RelayDeps, id: string, params: URLSearchParams): Promise<Response> {
    const service = params.get('service')
    if (!service) return problem('bad-request')

    // A client may only watch their own site. Answering 404 rather than 403 means the portal does not
    // confirm that a project id exists to somebody who has no business knowing.
    if (deps.clientId && !(await deps.assertOwned(deps.clientId, id))) return problem('not-found')

    const tailText = params.get('tail')
    const tail = tailText === null ? undefined : Number(tailText)
    if (tail !== undefined && (!Number.isInteger(tail) || tail < 1)) return problem('bad-request')

    const stream = await deps.openLogStream(deps.config, deps.caller, id, {
        service,
        tail,
        since: params.get('since') ?? undefined,
        follow: params.get('follow') === '1',
    })

    if (!stream.ok) return problem(stream.code)

    return new Response(stream.response.body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            // Stops a proxy buffering the stream into uselessness
            'x-accel-buffering': 'no',
        },
    })
}
