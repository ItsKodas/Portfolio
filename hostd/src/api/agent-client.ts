// api's side of the agent socket: one connection per call, one request line, then either one reply line
// or a header line and a stream of log lines. A refusal is an answer; silence, a dropped connection or
// garbage is AgentUnavailableError.

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { isRecord, describeError } from '../shared/formats.ts'
import { MAX_BODY_FRAME_BYTES } from '../shared/protocol.ts'
import type { AgentReply, AgentRequest, LogLine, ProjectRequest, Refusal } from '../shared/protocol.ts'

export class AgentUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentUnavailableError'
    }
}

export type Connect = () => Duplex
export type LogStream = { ok: true, lines: AsyncIterable<LogLine>, close(): void }
export type Download = { ok: true, body: AsyncIterable<Buffer>, close(): void }
export type AgentClient = {
    call(request: AgentRequest): Promise<AgentReply>
    stream(request: ProjectRequest): Promise<LogStream | Refusal>
    download(request: ProjectRequest): Promise<Download | Refusal>
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

// A length line is a run of decimal digits and a newline; MAX_BODY_FRAME_BYTES needs eight of them. Past
// this, whatever is arriving is not a length line, and waiting for a newline that is not coming would
// buffer the whole download looking for one.
const MAX_LENGTH_LINE_BYTES = 16
const EMPTY = Buffer.alloc(0)

// A download's own connection path, apart from open()'s readline one: readline consumes the socket, splits
// it on newlines and decodes every chunk as UTF-8, any one of which would corrupt a tar.gz. This reads raw
// Buffer chunks straight off the socket with plain 'data'/'end'/'error' listeners (no readline, no
// encoding, and no reliance on the socket's own async iterator, whose close() does not reliably unblock a
// pending read), buffers only until the header's own newline is found, and feeds everything after it, in
// the same chunk, to the frame parser as the first body bytes.
//
// The body is framed rather than raw (see MAX_BODY_FRAME_BYTES): the agent writes a byte count, that many
// bytes, and a `0\n` terminator once its source exited cleanly. Completeness is asserted by that
// terminator, never inferred from the socket closing. On a Unix stream socket a peer's destroy() arrives
// here as a plain EOF and raises no 'error' event, so a close on its own cannot tell a finished download
// from a truncated one.
function openBytes(connect: Connect, request: AgentRequest) {
    const socket = connect()
    let failure: Error | null = null
    let ended = false
    let aborted = false
    const queue: Buffer[] = []
    // Holds both sides of a pending read, so a socket error can reject it directly instead of the only
    // path being deliver(null), which a waiting reader cannot tell apart from a clean end.
    let waiting: { resolve: (chunk: Buffer | null) => void, reject: (error: Error) => void } | null = null

    const unavailable = (error: Error) => new AgentUnavailableError(`the agent connection failed: ${describeError(error)}`)

    const deliver = (chunk: Buffer | null) => {
        if (waiting) {
            const { resolve } = waiting
            waiting = null
            resolve(chunk)
        } else if (chunk !== null) {
            queue.push(chunk)
        }
    }
    const onData = (chunk: Buffer) => {
        deliver(chunk)
        // Backpressure: an unconsumed chunk stays queued here rather than the socket piling more of a
        // multi-gigabyte download in behind it. nextChunk() resumes once the consumer drains the queue.
        if (queue.length > 0) socket.pause()
    }
    const onEnd = () => { ended = true; deliver(null) }
    const onError = (error: Error) => {
        failure = error
        ended = true
        // A read already in flight must see the real failure, not a clean end: resolving it with null
        // here would hand the consumer a truncated body with no error to explain the missing bytes.
        if (waiting) {
            const { reject } = waiting
            waiting = null
            reject(unavailable(error))
        }
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('error', onError)
    // The write side stays open: the agent reads the peer leaving as "stop streaming".
    socket.write(`${JSON.stringify(request)}\n`)

    function nextChunk(): Promise<Buffer | null> {
        if (queue.length > 0) {
            const chunk = queue.shift()!
            if (queue.length === 0) socket.resume()
            return Promise.resolve(chunk)
        }
        if (ended) {
            if (failure) return Promise.reject(unavailable(failure))
            return Promise.resolve(null)
        }
        return new Promise((resolve, reject) => { waiting = { resolve, reject } })
    }

    let leftover: Buffer | null = null

    async function readHeader(): Promise<unknown> {
        let buffered = Buffer.alloc(0)
        for (;;) {
            const newline = buffered.indexOf(0x0a)
            if (newline !== -1) {
                const rest = buffered.subarray(newline + 1)
                leftover = rest.length > 0 ? rest : null
                return parseLine(buffered.subarray(0, newline).toString('utf8'))
            }
            const chunk = await nextChunk()
            if (chunk === null) {
                // Mirrors open()'s first(): a clean close and a real failure must not read alike.
                const reason = failure as Error | null
                throw new AgentUnavailableError(reason ? `the agent connection failed: ${reason.message}` : 'the agent closed the connection without answering')
            }
            buffered = Buffer.concat([buffered, chunk])
        }
    }

    // Never echoes the line itself: past the header, every byte on this socket is the client's own backup.
    function frameLength(line: Buffer): number {
        const text = line.toString('latin1')
        if (!/^[0-9]{1,9}$/.test(text)) throw new AgentUnavailableError('the agent sent an unreadable download frame')
        const size = Number(text)
        if (size > MAX_BODY_FRAME_BYTES) {
            throw new AgentUnavailableError(`the agent sent a download frame of ${size} bytes, larger than ${MAX_BODY_FRAME_BYTES}`)
        }
        return size
    }

    // Yields a frame's payload as it arrives rather than collecting the whole frame first, so what is held
    // here never exceeds one socket chunk plus a partial length line, whatever the frame size says.
    async function* body(): AsyncGenerator<Buffer> {
        let buffered = leftover ?? EMPTY
        leftover = null
        // Bytes still owed to the frame in progress; zero means the next thing on the wire is a length line.
        let owed = 0
        for (;;) {
            if (owed > 0) {
                if (buffered.length > 0) {
                    const take = Math.min(owed, buffered.length)
                    yield buffered.subarray(0, take)
                    buffered = buffered.subarray(take)
                    owed -= take
                    continue
                }
            } else {
                const newline = buffered.indexOf(0x0a)
                if (newline !== -1) {
                    const size = frameLength(buffered.subarray(0, newline))
                    buffered = buffered.subarray(newline + 1)
                    // The terminator, and the only way out of this loop that is not a throw.
                    if (size === 0) return
                    owed = size
                    continue
                }
                if (buffered.length > MAX_LENGTH_LINE_BYTES) throw new AgentUnavailableError('the agent sent an unreadable download frame')
            }
            const chunk = await nextChunk()
            if (chunk === null) {
                // An abort is this side's own decision, so it ends the body rather than failing it; the
                // caller that called close() already knows it stopped reading. Anything else reaching EOF
                // without the terminator is a download that stopped short, whether the agent's restic
                // exited non-zero, the agent destroyed the socket, or the connection simply went away.
                if (aborted) return
                throw new AgentUnavailableError('the download ended before it was complete')
            }
            buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
        }
    }

    function close(): void {
        socket.off('data', onData)
        socket.off('end', onEnd)
        socket.off('error', onError)
        // Unblocks a read that is waiting on this connection, exactly as reader.close() does for open():
        // ending locally does not depend on the peer ever acknowledging.
        aborted = true
        ended = true
        deliver(null)
        socket.end()
        // A real socket that never acknowledges the end is torn down anyway.
        setTimeout(() => socket.destroy(), 5_000).unref()
    }

    return { readHeader, body, close }
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

        async download(request) {
            const connection = openBytes(connect, request)
            let header: unknown
            try {
                header = await withTimeout(connection.readHeader(), headerTimeoutMs, connection.close)
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
                throw new AgentUnavailableError('the agent answered a download request without a stream')
            }

            async function* bytes(): AsyncGenerator<Buffer> {
                try {
                    yield* connection.body()
                } finally {
                    connection.close()
                }
            }
            return { ok: true, body: bytes(), close: connection.close }
        },
    }
}
