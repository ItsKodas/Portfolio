// api's side of the agent socket: one connection per call, one request line, then either one reply line
// or a header line and a stream of log lines. A refusal is an answer; silence, a dropped connection or
// garbage is AgentUnavailableError.

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { isRecord, describeError } from '../shared/formats.ts'
import type { AgentReply, AgentRequest, LogLine, ProjectRequest, Refusal } from '../shared/protocol.ts'

export class AgentUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentUnavailableError'
    }
}

export type Connect = () => Duplex
export type LogStream = { ok: true, lines: AsyncIterable<LogLine>, close(): void }
export type AgentClient = {
    call(request: AgentRequest): Promise<AgentReply>
    stream(request: ProjectRequest): Promise<LogStream | Refusal>
}

// Longer than the agent's own 120 second lifecycle timeout, so the agent's answer always arrives first.
export const CALL_TIMEOUT_MS = 150_000
export const STREAM_HEADER_TIMEOUT_MS = 30_000

export function socketConnect(path: string): Connect {
    return () => createConnection(path)
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout()
            reject(new AgentUnavailableError(`the agent did not answer within ${ms / 1000} seconds`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function parseLine(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw new AgentUnavailableError('the agent sent an unreadable reply')
    }
}

function open(connect: Connect, request: AgentRequest) {
    const socket = connect()
    let failure: Error | null = null
    const reader = createInterface({ input: socket, crlfDelay: Infinity })
    const iterator = reader[Symbol.asyncIterator]()
    // readline does not end on a socket error, so close it by hand; next() then reports the failure.
    socket.on('error', error => {
        failure = error
        reader.close()
    })
    // The write side stays open: the agent reads the peer leaving as "stop streaming".
    socket.write(`${JSON.stringify(request)}\n`)

    async function next(): Promise<string | null> {
        let result: IteratorResult<string>
        try {
            result = await iterator.next()
        } catch (error) {
            throw new AgentUnavailableError(`the agent connection failed: ${describeError(error)}`)
        }
        return result.done ? null : result.value
    }

    async function first(): Promise<string> {
        const value = await next()
        if (value !== null) return value
        const reason = failure as Error | null
        throw new AgentUnavailableError(reason ? `the agent connection failed: ${reason.message}` : 'the agent closed the connection without answering')
    }

    function close(): void {
        reader.close()
        socket.end()
        // A real socket that never acknowledges the end is torn down anyway.
        setTimeout(() => socket.destroy(), 5_000).unref()
    }

    return { first, next, close }
}

export function createAgentClient(
    connect: Connect,
    options: { callTimeoutMs?: number, headerTimeoutMs?: number } = {},
): AgentClient {
    const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    const headerTimeoutMs = options.headerTimeoutMs ?? STREAM_HEADER_TIMEOUT_MS

    return {
        async call(request) {
            const connection = open(connect, request)
            try {
                const reply = parseLine(await withTimeout(connection.first(), callTimeoutMs, connection.close))
                if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new AgentUnavailableError('the agent sent an unreadable reply')
                return reply as AgentReply
            } finally {
                connection.close()
            }
        },

        async stream(request) {
            const connection = open(connect, request)
            let header: unknown
            try {
                header = parseLine(await withTimeout(connection.first(), headerTimeoutMs, connection.close))
            } catch (error) {
                connection.close()
                throw error
            }
            if (isRecord(header) && header.ok === false) {
                connection.close()
                return header as Refusal
            }
            if (!isRecord(header) || header.ok !== true || header.stream !== true) {
                connection.close()
                throw new AgentUnavailableError('the agent answered a stream request without a stream')
            }

            async function* lines(): AsyncGenerator<LogLine> {
                try {
                    for (;;) {
                        const text = await connection.next()
                        if (text === null) return
                        yield parseLine(text) as LogLine
                    }
                } finally {
                    connection.close()
                }
            }
            return { ok: true, lines: lines(), close: connection.close }
        },
    }
}
