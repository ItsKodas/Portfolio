// The agent's side of the fetcher socket: one connection per call, one request line, one reply line. It
// is api's agent-client.ts with the streaming half removed, since the fetcher's protocol has none.

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { isRecord, describeError } from '../shared/formats.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

export class FetcherUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FetcherUnavailableError'
    }
}

export type Connect = () => Duplex
export type FetchClient = { call(request: FetchRequest): Promise<FetchReply> }

// Longer than the fetcher's own GIT_TIMEOUT_MS, so the fetcher's answer always arrives first, the same
// margin api's own CALL_TIMEOUT_MS keeps over the agent's lifecycle timeout.
export const FETCH_TIMEOUT_MS = 330_000

export function socketConnect(path: string): Connect {
    return () => createConnection(path)
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout()
            reject(new FetcherUnavailableError(`the fetcher did not answer within ${ms / 1000} seconds`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function parseLine(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw new FetcherUnavailableError('the fetcher sent an unreadable reply')
    }
}

function open(connect: Connect, request: FetchRequest) {
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
            throw new FetcherUnavailableError(`the fetcher connection failed: ${describeError(error)}`)
        }
        if (!result.done) return result.value
        const reason = failure as Error | null
        throw new FetcherUnavailableError(reason ? `the fetcher connection failed: ${reason.message}` : 'the fetcher closed the connection without answering')
    }

    function close(): void {
        reader.close()
        socket.end()
        // A real socket that never acknowledges the end is torn down anyway.
        setTimeout(() => socket.destroy(), 5_000).unref()
    }

    return { first, close }
}

export function createFetchClient(connect: Connect, options: { timeoutMs?: number } = {}): FetchClient {
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS

    return {
        async call(request) {
            const connection = open(connect, request)
            try {
                const reply = parseLine(await withTimeout(connection.first(), timeoutMs, connection.close))
                if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new FetcherUnavailableError('the fetcher sent an unreadable reply')
                return reply as FetchReply
            } finally {
                connection.close()
            }
        },
    }
}
