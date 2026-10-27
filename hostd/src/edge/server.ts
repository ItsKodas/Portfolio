// The edge process's socket server: one JSON request line per connection, one reply line back, the same
// shape as the fetcher's. handleEdge is the verb dispatch; handleEdgeConnection is the wire around it.

import type { Duplex } from 'node:stream'
import { readRequestLine } from '../agent/server.ts'
import { parseEdgeRequest, type EdgeRequest, type EdgeReply } from '../shared/edge-protocol.ts'
import { describeError } from '../shared/formats.ts'
import { applyHosts, findHosts, getHosts, removeHosts, type HostsDeps } from './hosts.ts'

// The hosts functions, overridable so a test can watch the order they run in without faking NPM.
export type HostFns = { apply: typeof applyHosts, remove: typeof removeHosts }
export type EdgeDeps = HostsDeps & { npmAge(): number | null, hosts?: Partial<HostFns> }

// One queue per deps object. Every apply and remove goes through it: hosts.ts checks for a conflicting
// host and then writes, and only running one write at a time closes the gap between the two. Reads do
// not queue, since they change nothing.
const queues = new WeakMap<object, Promise<unknown>>()

function serialised<T>(deps: object, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(deps) ?? Promise.resolve()).then(run)
    // The queue must not reject, or every later write inherits the failure (as ApacheRail.send does).
    queues.set(deps, result.catch(() => undefined))
    return result
}

async function dispatch(request: EdgeRequest, deps: EdgeDeps): Promise<EdgeReply> {
    switch (request.verb) {
        case 'health': return { ok: true, verb: 'health', npmAge: deps.npmAge() }
        case 'certificates': return { ok: true, verb: 'certificates', ids: await deps.npm.certificateIds() }
        case 'find': return findHosts(deps, request.domains)
        case 'get': return getHosts(deps, request.owner, request.ids)
        case 'apply': return serialised(deps, () => (deps.hosts?.apply ?? applyHosts)(deps, request.owner, request.ids, request.spec, request.adopt))
        case 'remove': return serialised(deps, () => (deps.hosts?.remove ?? removeHosts)(deps, request.owner, request.ids))
    }
}

export async function handleEdge(request: EdgeRequest, deps: EdgeDeps): Promise<EdgeReply> {
    try {
        return await dispatch(request, deps)
    } catch (error) {
        // An exception message, never the request, and NpmClient keeps its secret out of every message.
        return { ok: false, problem: describeError(error) }
    }
}

function describe(request: EdgeRequest): string {
    switch (request.verb) {
        case 'health':
        case 'certificates': return request.verb
        case 'find': return `find ${request.domains.join(',')}`
        default: return `${request.verb} ${request.owner.project}/${request.owner.environment}`
    }
}

const lineOf = (value: unknown) => `${JSON.stringify(value)}\n`

export async function handleEdgeConnection(
    socket: Duplex,
    run: (request: EdgeRequest) => Promise<EdgeReply>,
    log: (message: string) => void,
): Promise<void> {
    socket.on('error', () => socket.destroy())

    const result = await readRequestLine(socket)
    socket.resume()

    if (result.line === null) {
        // A bare connect-and-close is a probe of the socket, not a request.
        if (result.reason === 'empty') {
            socket.end()
            return
        }
        log('refused: no request line')
        socket.end(lineOf({ ok: false, problem: 'expected one request line of at most 64 KB' }))
        return
    }

    let value: unknown
    try {
        value = JSON.parse(result.line)
    } catch {
        value = null
    }
    const request = parseEdgeRequest(value)
    if (!request) {
        log('refused: unreadable request')
        socket.end(lineOf({ ok: false, problem: 'the request was not understood' }))
        return
    }

    const what = describe(request)
    let reply: EdgeReply
    try {
        reply = await run(request)
    } catch (error) {
        reply = { ok: false, problem: describeError(error) }
    }
    log(`${what} ${reply.ok ? 'ok' : 'refused'}`)
    socket.end(lineOf(reply))
}
