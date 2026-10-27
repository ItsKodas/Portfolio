// The agent's side of the edge socket: one connection per call, one request line, one reply line. It
// has the same shape as fetch-client.ts, kept as its own copy rather than shared.

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { describeError } from '../shared/formats.ts'
import { parseEdgeReply, type EdgeReply, type EdgeRequest } from '../shared/edge-protocol.ts'

export class EdgeUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'EdgeUnavailableError'
    }
}

export type Connect = () => Duplex
export type CallOptions = { timeoutMs?: number }
export type EdgeClient = { call(request: EdgeRequest, options?: CallOptions): Promise<EdgeReply> }

// api gives up on the agent after its own CALL_TIMEOUT_MS (150 seconds), and for an adopt that means
// api never runs its automatic rollback. An apply that times out here is followed by one confirming
// read (confirmApply in domains.ts), so the two together are kept well inside api's window: 100 seconds
// for the apply, which covers the usual few NPM calls with room for one to hang to NPM's own 30 second
// timeout, and 40 seconds for the read. An apply still running in edge when this gives up is what the
// confirming read is for.
export const EDGE_TIMEOUT_MS = 100_000
export const EDGE_CONFIRM_TIMEOUT_MS = 40_000

export function socketConnect(path: string): Connect {
    return () => createConnection(path)
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout()
            reject(new EdgeUnavailableError(`edge did not answer within ${ms / 1000} seconds`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function parseLine(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw new EdgeUnavailableError('edge sent an unreadable reply')
    }
}

function open(connect: Connect, request: EdgeRequest) {
    const socket = connect()
    let failure: Error | null = null
    const reader = createInterface({ input: socket, crlfDelay: Infinity })
    const iterator = reader[Symbol.asyncIterator]()
    // readline does not end on a socket error, so close it by hand; first() then reports the failure.
    socket.on('error', error => {
        failure = error
        reader.close()
    })
    socket.write(`${JSON.stringify(request)}\n`)

    async function first(): Promise<string> {
        let result: IteratorResult<string>
        try {
            result = await iterator.next()
        } catch (error) {
            throw new EdgeUnavailableError(`edge connection failed: ${describeError(error)}`)
        }
        if (!result.done) return result.value
        const reason = failure as Error | null
        throw new EdgeUnavailableError(reason ? `edge connection failed: ${reason.message}` : 'edge closed the connection without answering')
    }

    function close(): void {
        reader.close()
        socket.end()
        // A real socket that never acknowledges the end is torn down anyway.
        setTimeout(() => socket.destroy(), 5_000).unref()
    }

    return { first, close }
}

export function edgeClient(connect: Connect, options: { timeoutMs?: number } = {}): EdgeClient {
    const timeoutMs = options.timeoutMs ?? EDGE_TIMEOUT_MS

    return {
        async call(request, options = {}) {
            const connection = open(connect, request)
            try {
                const reply = parseLine(await withTimeout(connection.first(), options.timeoutMs ?? timeoutMs, connection.close))
                const parsed = parseEdgeReply(reply)
                if (!parsed) throw new EdgeUnavailableError('edge sent an unreadable reply')
                return parsed
            } finally {
                connection.close()
            }
        },
    }
}
