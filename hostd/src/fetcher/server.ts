// One request per connection on the fetcher's Unix socket: read a single JSON line, run it, and write
// one JSON line back. There is no streaming in this protocol, so this is the simpler half of the agent's
// own server.ts, and it reuses that file's readRequestLine (and the request size it bounds) rather than
// copying it, since parseFetchRequest has no size guard of its own.

import type { Duplex } from 'node:stream'
import { readRequestLine } from '../agent/server.ts'
import { parseFetchRequest, type FetchRequest, type FetchReply } from '../shared/fetch-protocol.ts'
import { describeError } from '../shared/formats.ts'

function describe(request: FetchRequest): string {
    switch (request.verb) {
        case 'clone': return `clone ${request.dir} ${request.branch}`
        case 'fetch': return `fetch ${request.dir}`
        case 'checkout': return `checkout ${request.dir} ${request.commit}`
        case 'log': return `log ${request.dir} ${request.branch}`
        case 'tip': return `tip ${request.dir} ${request.branch}`
        // No dir to log it by, unlike every other verb here: branches has none. The repo is safe to log,
        // never a credential, because GIT_REPO (checked before this is ever reached) admits no userinfo.
        case 'branches': return `branches ${request.repo}`
    }
}

const lineOf = (value: unknown) => `${JSON.stringify(value)}\n`

export async function handleFetchConnection(
    socket: Duplex,
    run: (request: FetchRequest) => Promise<FetchReply>,
    log: (message: string) => void,
): Promise<void> {
    socket.on('error', () => socket.destroy())

    const result = await readRequestLine(socket)
    // Anything after the request line is ignored, but the socket keeps reading so a peer leaving is seen.
    socket.resume()

    if (result.line === null) {
        if (result.reason === 'empty') {
            // A bare connect-and-close, like the agent's own fetcherReachable probe of this socket, is not
            // a request: end quietly rather than logging a refusal for every probe tick.
            socket.end()
            return
        }
        log('refused bad-request: no request line')
        socket.end(lineOf({ ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' }))
        return
    }

    const parsed = parseFetchRequest(result.line)
    if (!parsed.ok) {
        log(`refused ${parsed.code}: ${parsed.message}`)
        socket.end(lineOf(parsed))
        return
    }
    // parseFetchRequest's own success type is declared as `{ ok: true, request } | FetchReply`, and
    // FetchReply's success variant also carries ok: true, so the compiler cannot tell the two apart by
    // that field alone. In practice parseFetchRequest only ever returns a request here, never a bare
    // reply, so this cast just states what parsed.ok === true already means for this function.
    const { request } = parsed as { ok: true, request: FetchRequest }

    const what = describe(request)
    let reply: FetchReply
    try {
        reply = await run(request)
    } catch (error) {
        // describeError(error) is an exception message, never the request itself, so this cannot be the
        // path a credential leaks by; the token never appears in an Error's message in this codebase.
        log(`${what} unavailable: ${describeError(error)}`)
        socket.end(lineOf({ ok: false, code: 'unavailable', message: describeError(error) }))
        return
    }

    // Only the verb, its path arguments and the outcome's code are logged, never a reply's message: that
    // is where a remote's own error text (redacted by git.ts, but not guaranteed to stay that way) lives.
    log(`${what} ${reply.ok ? 'ok' : reply.code}`)
    socket.end(lineOf(reply))
}
