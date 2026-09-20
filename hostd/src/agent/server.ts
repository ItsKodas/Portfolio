// One request per connection on the agent's Unix socket: read a single JSON line, dispatch it, and write
// either one JSON line or a header line followed by one JSON line per log line. Every verb the agent
// executes is logged to stdout, a record api cannot reach or rewrite.

import type { Duplex, Readable } from 'node:stream'
import { parseAgentRequest, refuse, MAX_REQUEST_BYTES, type AgentRequest } from '../shared/protocol.ts'
import { describeError } from '../shared/formats.ts'
import type { Outcome } from './agent.ts'

export type AgentHandler = { handle(request: AgentRequest): Promise<Outcome> }

// Resolves with the first line, or with why there wasn't one: 'empty' means the peer left without sending
// a byte (a bare connect-and-close, such as a health probe), 'incomplete' means it sent some bytes then
// left before a newline arrived, and 'oversize' means it sent more than maxBytes without a newline. The
// three are indistinguishable from a raw null, which is why fetcher/server.ts needs this split: an empty
// close is not a request at all, while the other two are malformed requests worth refusing and logging.
export type RequestLineResult = { line: string } | { line: null, reason: 'empty' | 'incomplete' | 'oversize' }

export function readRequestLine(input: Readable, maxBytes = MAX_REQUEST_BYTES): Promise<RequestLineResult> {
    return new Promise(resolve => {
        const chunks: Buffer[] = []
        let size = 0
        let sawData = false
        const finish = (value: RequestLineResult) => {
            input.off('data', onData)
            input.off('end', onEnd)
            input.off('error', onEnd)
            resolve(value)
        }
        const onData = (chunk: Buffer | string) => {
            sawData = true
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            const newline = bytes.indexOf(0x0a)
            if (newline !== -1) {
                chunks.push(bytes.subarray(0, newline))
                size += newline
                finish(size > maxBytes ? { line: null, reason: 'oversize' } : { line: Buffer.concat(chunks).toString('utf8') })
                return
            }
            chunks.push(bytes)
            size += bytes.length
            if (size > maxBytes) finish({ line: null, reason: 'oversize' })
        }
        const onEnd = () => finish({ line: null, reason: sawData ? 'incomplete' : 'empty' })
        input.on('data', onData)
        input.on('end', onEnd)
        input.on('error', onEnd)
    })
}

function describe(request: AgentRequest): string {
    switch (request.verb) {
        case 'health': return 'health'
        case 'status': return `status ${request.project}`
        case 'lifecycle': return `lifecycle ${request.project} ${request.args.action}`
        case 'logs': return `logs ${request.project} ${request.args.service}${request.args.follow ? ' follow' : ''}`
        // Never the repo URL, a branch or a domain here: this line is exactly what reaches the log.
        case 'provision': return 'project' in request ? `provision ${request.args.action} ${request.project}` : `provision create ${request.args.id}`
        // Never args.text: that is the one place an env write carries the file's own contents.
        case 'env': return `env ${request.args.action} ${request.project} ${request.args.environment}`
    }
}

function waitForDrain(socket: Duplex): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            socket.off('drain', done)
            socket.off('close', done)
            resolve()
        }
        socket.on('drain', done)
        socket.on('close', done)
    })
}

const lineOf = (value: unknown) => `${JSON.stringify(value)}\n`

export async function handleConnection(socket: Duplex, agent: AgentHandler, log: (message: string) => void): Promise<void> {
    socket.on('error', () => socket.destroy())

    // A peer can leave at any point from the very first byte onward, including before its request line has
    // even finished arriving (the 'end' event can fire in the same tick the line does). This marker goes on
    // before anything else is awaited, so a logs follow request, which can make several Docker round trips
    // before its outcome is known, never loses track of an early departure while waiting on that outcome.
    let gone = false
    const markGone = () => { gone = true }
    socket.once('end', markGone)
    socket.once('close', markGone)
    const stopWatching = () => {
        socket.off('end', markGone)
        socket.off('close', markGone)
    }

    const result = await readRequestLine(socket)
    // Anything after the request line is ignored, but the socket keeps reading so the peer leaving is seen.
    socket.resume()

    if (result.line === null) {
        stopWatching()
        // Every reason is logged and refused here, including an empty close: unlike the fetcher, nothing
        // probes this socket with a bare connect-and-close (api always sends a real health verb), so a
        // silent connection to the agent is unexpected and worth keeping in the log.
        log('refused bad-request: no request line')
        socket.end(lineOf(refuse('bad-request', 'expected one request line of at most 64 KB')))
        return
    }
    const line = result.line

    const parsed = parseAgentRequest(line)
    if (!parsed.ok) {
        stopWatching()
        log(`refused ${parsed.code}: ${parsed.message}`)
        socket.end(lineOf(parsed))
        return
    }

    const what = describe(parsed.request)
    let outcome: Outcome
    try {
        outcome = await agent.handle(parsed.request)
    } catch (error) {
        stopWatching()
        log(`${what} unavailable: ${describeError(error)}`)
        socket.end(lineOf(refuse('unavailable', describeError(error))))
        return
    }

    if (outcome.kind === 'reply') {
        stopWatching()
        log(`${what} ${outcome.reply.ok ? 'ok' : outcome.reply.code}`)
        socket.end(lineOf(outcome.reply))
        return
    }

    const stream = outcome
    if (gone) {
        // The peer left while the handler was still working; there is no one to write the stream to.
        stopWatching()
        log(`${what} stream abandoned before it started`)
        stream.close()
        return
    }

    log(`${what} streaming`)
    let closed = false
    const abort = () => {
        closed = true
        stream.close()
    }
    stopWatching()
    socket.once('end', abort)
    socket.once('close', abort)
    try {
        if (!socket.write(lineOf({ ok: true, stream: true }))) await waitForDrain(socket)
        for await (const logLine of stream.lines) {
            if (closed) break
            if (!socket.write(lineOf(logLine))) await waitForDrain(socket)
        }
        if (!closed) socket.end()
    } catch (error) {
        log(`${what} stream failed: ${describeError(error)}`)
        socket.destroy()
    } finally {
        socket.off('end', abort)
        socket.off('close', abort)
        stream.close()
        log(`${what} stream ended`)
    }
}
