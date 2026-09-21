import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentClient, socketConnect, AgentUnavailableError, type Connect } from './agent-client.ts'
import { handleConnection, type AgentHandler } from '../agent/server.ts'
import { MAX_BODY_FRAME_BYTES } from '../shared/protocol.ts'
import type { HealthReply, LogLine } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }
const health: HealthReply = { ok: true, warnings: [], invalid: {}, system: { memory: null, cpu: null, disk: null, problems: [] } }

// Each connect() gets a fresh socket pair whose far end is served by the real agent server.
function connectTo(agent: AgentHandler): Connect {
    return () => {
        const [client, server] = duplexPair()
        void handleConnection(server, agent, () => {})
        return client
    }
}

// A far end that does whatever the test says with the raw socket.
function connectRaw(behaviour: (server: Duplex, client: Duplex) => void): Connect {
    return () => {
        const [client, server] = duplexPair()
        behaviour(server, client)
        return client
    }
}

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
    const out: LogLine[] = []
    for await (const item of lines) out.push(item)
    return out
}

describe('call', () => {
    it('returns the agent\'s reply', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: health }) }))
        assert.deepEqual(await client.call({ verb: 'health' }), health)
    })

    it('returns a refusal as a value, not an error', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: false, code: 'busy', message: 'busy' } }) }))
        assert.deepEqual(await client.call({ verb: 'status', project: 'acme' }), { ok: false, code: 'busy', message: 'busy' })
    })

    it('throws AgentUnavailableError when the agent hangs up without answering', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => server.end())
        }))
        await assert.rejects(client.call({ verb: 'health' }), (error: unknown) => {
            assert.ok(error instanceof AgentUnavailableError)
            assert.equal(error.message, 'the agent closed the connection without answering')
            return true
        })
    })

    it('throws AgentUnavailableError when the socket fails', async () => {
        const client = createAgentClient(connectRaw((_server, clientSide) => {
            setImmediate(() => clientSide.destroy(new Error('connect ENOENT /run/hostd/agent.sock')))
        }))
        await assert.rejects(client.call({ verb: 'health' }), /the agent connection failed: connect ENOENT \/run\/hostd\/agent\.sock/)
    })

    it('throws AgentUnavailableError when the agent does not answer in time', async () => {
        const client = createAgentClient(connectRaw(() => {}), { callTimeoutMs: 30 })
        await assert.rejects(client.call({ verb: 'health' }), /the agent did not answer within 0\.03 seconds/)
    })

    it('throws AgentUnavailableError on a reply that is not JSON', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => server.end('garbage\n'))
        }))
        await assert.rejects(client.call({ verb: 'health' }), /the agent sent an unreadable reply/)
    })
})

describe('stream', () => {
    const logs = { verb: 'logs' as const, project: 'acme', args: { service: 'web', tail: 10, since: null, follow: true } }

    it('yields each log line and ends with the agent\'s stream', async () => {
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'stream',
                lines: (async function* () { yield line; yield { ...line, text: 'again' } })(),
                close: () => {},
            }),
        }))
        const result = await client.stream(logs)
        assert.ok(result.ok)
        assert.deepEqual(await collect(result.lines), [line, { ...line, text: 'again' }])
    })

    it('returns a refusal instead of a stream', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: false, code: 'busy', message: 'acme already has 4 log streams open' } }) }))
        assert.deepEqual(await client.stream(logs), { ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
    })

    it('closing the stream makes the agent close its end', async () => {
        let agentClosed: () => void = () => {}
        const closedOnAgent = new Promise<void>(resolve => { agentClosed = resolve })
        let wake: () => void = () => {}
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'stream',
                lines: (async function* () {
                    yield line
                    await new Promise<void>(resolve => { wake = resolve })
                })(),
                close: () => {
                    agentClosed()
                    wake()
                },
            }),
        }))
        const result = await client.stream(logs)
        assert.ok(result.ok)
        const iterator = result.lines[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, line)
        result.close()
        await closedOnAgent
        assert.equal((await iterator.next()).done, true)
    })

    it('rejects with AgentUnavailableError when the socket fails before the agent ends the stream', async () => {
        // A genuine mid-stream failure: the agent never gets to end the stream cleanly, so readline is
        // still forwarding the raw socket's own 'error' event into a rejection of the iterator itself.
        let server!: Duplex
        let clientSide!: Duplex
        const connect: Connect = () => {
            const pair = duplexPair()
            clientSide = pair[0]
            server = pair[1]
            return clientSide
        }
        const client = createAgentClient(connect)
        const resultPromise = client.stream(logs)
        await new Promise<void>(resolve => server.once('data', () => resolve()))
        server.write(`${JSON.stringify({ ok: true, stream: true })}\n`)
        server.write(`${JSON.stringify(line)}\n`)
        const result = await resultPromise
        assert.ok(result.ok)
        const iterator = result.lines[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, line)
        clientSide.destroy(new Error('read ECONNRESET'))
        await assert.rejects(iterator.next(), /the agent connection failed: read ECONNRESET/)
    })

    it('ends the stream normally when a socket error arrives only after the agent already ended it', async () => {
        // A delayed ECONNRESET after the peer's own FIN is a normal TCP artifact, not a real failure.
        // Once the agent has cleanly ended the stream, readline has already self-closed once and no
        // longer forwards a further socket error into the iterator, so the stream must still end quietly.
        let server!: Duplex
        let clientSide!: Duplex
        const connect: Connect = () => {
            const pair = duplexPair()
            clientSide = pair[0]
            server = pair[1]
            return clientSide
        }
        const client = createAgentClient(connect)
        const resultPromise = client.stream(logs)
        await new Promise<void>(resolve => server.once('data', () => resolve()))
        server.write(`${JSON.stringify({ ok: true, stream: true })}\n`)
        server.write(`${JSON.stringify(line)}\n`)
        const result = await resultPromise
        assert.ok(result.ok)
        const iterator = result.lines[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, line)
        server.end()
        // Give the graceful end time to fully close the reader before the socket fails.
        await new Promise<void>(resolve => setImmediate(resolve))
        clientSide.destroy(new Error('read ECONNRESET'))
        // Let the destroy's own 'error' emission (scheduled, not synchronous) land before asking for more.
        await new Promise<void>(resolve => setImmediate(resolve))
        await assert.doesNotReject(async () => {
            assert.equal((await iterator.next()).done, true)
        })
    })
})

describe('download', () => {
    const backup = { verb: 'backup' as const, project: 'acme', args: { action: 'download' as const, snapshot: 'deadbeef' } }

    // The body is framed: a decimal byte count, a newline, exactly that many bytes, and a final `0\n`
    // terminator. Nothing below builds a raw body, because a raw body is no longer a body.
    const frame = (bytes: Buffer | string) => {
        const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
        return Buffer.concat([Buffer.from(`${data.length}\n`), data])
    }
    const TERMINATOR = Buffer.from('0\n')
    const HEADER = Buffer.from('{"ok":true,"stream":true}\n')

    async function drain(body: AsyncIterable<Buffer>): Promise<Buffer> {
        const chunks: Buffer[] = []
        for await (const chunk of body) chunks.push(chunk)
        return Buffer.concat(chunks)
    }

    it('yields body bytes that arrive in the same chunk as the header line', async () => {
        // The case that catches a swallowed remainder: the header, the first length line and the first
        // frame's bytes all arrive together, and nothing after the header's newline may be lost.
        const body = Buffer.from('tar bytes')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end(Buffer.concat([HEADER, frame(body), TERMINATOR]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    it('parses the header even when a chunk boundary falls inside the header line', async () => {
        const body = Buffer.from('tar bytes')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write('{"ok":true,"str')
                server.write('eam":true}\n')
                server.end(Buffer.concat([frame(body), TERMINATOR]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    it('passes through a complete body of bytes that are not valid UTF-8, byte for byte', async () => {
        // A gzip magic number followed by bytes no UTF-8 decoder round-trips. This is the case that
        // catches string decoding: a readline-based path would corrupt these into replacement characters.
        // It is also the happy path for the terminator: every byte arrives and the body ends normally.
        const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80])
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write(HEADER)
                server.end(Buffer.concat([frame(body.subarray(0, 3)), frame(body.subarray(3)), TERMINATOR]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    it('reassembles a frame whose payload is split across chunks', async () => {
        const body = Buffer.from('a tar.gz long enough to straddle a chunk boundary')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write(HEADER)
                server.write(Buffer.concat([Buffer.from(`${body.length}\n`), body.subarray(0, 7)]))
                server.write(body.subarray(7, 20))
                server.end(Buffer.concat([body.subarray(20), TERMINATOR]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    it('reads a length line that is split across chunks', async () => {
        // A three digit length arriving one digit at a time, and the terminator split in two as well: a
        // length line is bytes on a socket like any other, and gets no say in where a chunk boundary falls.
        const body = Buffer.alloc(120, 0x7a)
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write(HEADER)
                server.write('1')
                server.write('2')
                server.write('0\n')
                server.write(body)
                server.write('0')
                server.end('\n')
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    it('rejects a body that ends mid-frame with no terminator', async () => {
        // The socket simply ends, with no error event anywhere: exactly what a peer's destroy() looks
        // like on a Unix stream socket. A frame promised 9 bytes and 4 arrived.
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end(Buffer.concat([HEADER, Buffer.from('9\ntar ')]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        await assert.rejects(drain(result.body), /the download ended before it was complete/)
    })

    it('rejects a body whose frames are all complete but which never sent the terminator', async () => {
        // The restic dump failure exactly: whole frames, a clean EOF, and no terminator. Every byte on
        // the wire is a real byte of the archive, which is why nothing but the terminator can say the
        // archive is whole. Before framing this reached the client as a successful, truncated download.
        const body = Buffer.from('tar bytes')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end(Buffer.concat([HEADER, frame(body)]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        const iterator = result.body[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, body)
        await assert.rejects(iterator.next(), /the download ended before it was complete/)
    })

    it('still fails a truncated body when close() is called after the socket already ended', async () => {
        // Ordering matters, and only one order is a clean end. Here the download breaks first and the
        // abort follows it, which is what happens when the agent gives up and only then does the reader
        // tear its side down: a late close() must not launder a truncation into a success. The opposite
        // order, close() first, is the test below that asserts a deliberate abort ends quietly.
        // Registered inside connect(), before a byte moves, so the EOF cannot be missed.
        let sawEnd: () => void = () => {}
        const ended = new Promise<void>(resolve => { sawEnd = resolve })
        const client = createAgentClient(connectRaw((server, clientSide) => {
            clientSide.on('end', () => sawEnd())
            server.once('data', () => {
                server.end(Buffer.concat([HEADER, Buffer.from('9\ntar ')]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        const iterator = result.body[Symbol.asyncIterator]()
        // A frame that promised 9 bytes and delivered 4. The 4 are real and arrive.
        assert.deepEqual((await iterator.next()).value, Buffer.from('tar '))
        // The EOF lands with nobody reading; the abort comes after it and must not excuse it. Without
        // the latch being conditional on the stream still being live, the read below ends cleanly and
        // the caller keeps 4 bytes of a 9 byte archive believing it has all of them.
        await ended
        result.close()
        await assert.rejects(iterator.next(), /the download ended before it was complete/)
    })

    it('rejects a length line that is not a run of digits rather than buffering towards a newline', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end(Buffer.concat([HEADER, Buffer.from('not-a-length\ntar bytes')]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        await assert.rejects(drain(result.body), /unreadable download frame/)
    })

    it('rejects a length line with no newline in sight rather than buffering the whole download', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write(HEADER)
                server.write(Buffer.alloc(4096, 0x39))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        await assert.rejects(drain(result.body), /unreadable download frame/)
    })

    it('rejects a frame larger than the cap rather than buffering towards it', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write(HEADER)
                server.write(`${MAX_BODY_FRAME_BYTES + 1}\n`)
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        await assert.rejects(drain(result.body), new RegExp(`larger than ${MAX_BODY_FRAME_BYTES}`))
    })

    it('returns the refusal when the agent refuses a download, with no body', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end('{"ok":false,"code":"unknown-project","message":"no project acme"}\n')
            })
        }))
        const result = await client.download(backup)
        assert.deepEqual(result, { ok: false, code: 'unknown-project', message: 'no project acme' })
    })

    it('carries a real download end to end through the agent server, terminator included', async () => {
        const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80])
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'bytes',
                body: (async function* () { yield body.subarray(0, 2); yield body.subarray(2) })(),
                close: () => {},
            }),
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        assert.deepEqual(await drain(result.body), body)
    })

    // A duplexPair cannot host these two: destroying one of its sides leaves the other waiting forever,
    // so an in-process pair cannot show what the peer sees when the agent gives up. An actual kernel
    // socket can, and what it shows is exactly the defect: the agent's destroy() arrives here as a plain
    // EOF with no 'error' event, and the only thing separating a whole archive from a truncated one is
    // whether the terminator came first.
    async function overRealSocket(agent: AgentHandler, use: (connect: Connect) => Promise<void>): Promise<void> {
        const name = `hostd-dl-${process.pid}-${Math.random().toString(36).slice(2)}`
        const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
        const accepted: Socket[] = []
        const server = createServer(socket => {
            accepted.push(socket)
            void handleConnection(socket, agent, () => {})
        })
        await new Promise<void>(resolve => server.listen(path, resolve))
        try {
            await use(socketConnect(path))
        } finally {
            for (const socket of accepted) socket.destroy()
            await new Promise(resolve => server.close(resolve))
        }
    }

    it('carries a download over a real socket, byte for byte', async () => {
        const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80])
        await overRealSocket({
            handle: async () => ({
                kind: 'bytes',
                body: (async function* () { yield body.subarray(0, 2); yield body.subarray(2) })(),
                close: () => {},
            }),
        }, async connect => {
            const result = await createAgentClient(connect).download(backup)
            assert.ok(result.ok)
            if (!result.ok) return
            assert.deepEqual(await drain(result.body), body)
        })
    })

    it('rejects over a real socket when the agent body throws part way, rather than delivering a short archive', async () => {
        // The whole defect in one test, both real implementations, a real socket and no fabricated error
        // event: the agent's body throws the way restic dump exiting non-zero makes it throw, the agent
        // destroys the socket, and the missing terminator is the only reason this is not a clean success.
        await overRealSocket({
            handle: async () => ({
                kind: 'bytes',
                body: (async function* () {
                    yield Buffer.from('partial')
                    throw new Error('restic dump exited with code 1')
                })(),
                close: () => {},
            }),
        }, async connect => {
            const result = await createAgentClient(connect).download(backup)
            assert.ok(result.ok)
            if (!result.ok) return
            await assert.rejects(drain(result.body), /the download ended before it was complete|the agent connection failed/)
        })
    })

    it('closing the download makes the agent close its end', async () => {
        let agentClosed: () => void = () => {}
        const closedOnAgent = new Promise<void>(resolve => { agentClosed = resolve })
        let wake: () => void = () => {}
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'bytes',
                body: (async function* () {
                    yield Buffer.from('first')
                    await new Promise<void>(resolve => { wake = resolve })
                })(),
                close: () => {
                    agentClosed()
                    wake()
                },
            }),
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        if (!result.ok) return
        const iterator = result.body[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, Buffer.from('first'))
        result.close()
        await closedOnAgent
        // An abort is this side's own decision, so the body ends rather than failing: the caller that
        // called close() is the one that stopped the download and needs no error to tell it so.
        assert.equal((await iterator.next()).done, true)
    })

    it('rejects the header read with the real failure reason, not the generic closed-without-answering message', async () => {
        const client = createAgentClient(connectRaw((_server, clientSide) => {
            setImmediate(() => clientSide.destroy(new Error('connect ENOENT /run/hostd/agent.sock')))
        }))
        await assert.rejects(client.download(backup), /the agent connection failed: connect ENOENT/)
    })

    it('rejects a pending body read with the real failure, rather than ending the body silently', async () => {
        // A genuine socket error, which destroy(new Error(...)) fabricates here. Worth keeping: a reset
        // by the kernel, a broken bind mount or a container restart really does raise 'error' on this
        // socket, and that failure must not read as a clean end. It is NOT the production truncation
        // path, though: a real Unix socket close, including the agent's own destroy(), delivers a plain
        // EOF and produces no 'error' event at all. The tests above that simply end the socket are the
        // ones covering a restic dump that failed part way, so do not delete those in favour of this.
        let server!: Duplex
        let clientSide!: Duplex
        const connect: Connect = () => {
            const pair = duplexPair()
            clientSide = pair[0]
            server = pair[1]
            return clientSide
        }
        const client = createAgentClient(connect)
        const resultPromise = client.download(backup)
        await new Promise<void>(resolve => server.once('data', () => resolve()))
        server.write('{"ok":true,"stream":true}\n')
        const result = await resultPromise
        assert.ok(result.ok)
        if (!result.ok) return
        const iterator = result.body[Symbol.asyncIterator]()
        const first = iterator.next()
        server.write(frame('first'))
        assert.deepEqual((await first).value, Buffer.from('first'))
        const failing = iterator.next()
        clientSide.destroy(new Error('read ECONNRESET'))
        await assert.rejects(failing, /the agent connection failed: read ECONNRESET/)
    })

    it('applies backpressure while chunks are queued, and resumes once the consumer drains them', async () => {
        // A duplexPair, not a single PassThrough: PassThrough echoes writes straight back to its own
        // reads, which would loop the client's own request line back as if the agent had sent it.
        const [clientSide, server] = duplexPair()
        let pauseCalls = 0
        let resumeCalls = 0
        const originalPause = clientSide.pause.bind(clientSide)
        const originalResume = clientSide.resume.bind(clientSide)
        clientSide.pause = () => { pauseCalls += 1; return originalPause() }
        clientSide.resume = () => { resumeCalls += 1; return originalResume() }

        const client = createAgentClient(() => clientSide)
        const resultPromise = client.download(backup)
        await new Promise<void>(resolve => server.once('data', () => resolve()))
        server.write('{"ok":true,"stream":true}\n')
        const result = await resultPromise
        assert.ok(result.ok)
        if (!result.ok) return

        // Two chunks arrive before anyone reads the body: they queue up locally, and the socket is
        // paused rather than piling more of a multi-gigabyte download into an unbounded array. Framing
        // changed what the bytes mean, not where they wait: the queue is still the only place an
        // unconsumed chunk sits, and the parser holds at most one chunk beyond it.
        server.write(frame('chunk1'))
        server.write(frame('chunk2'))
        server.end(TERMINATOR)
        await new Promise(resolve => setImmediate(resolve))
        assert.ok(pauseCalls > 0, 'expected the socket to be paused while chunks were unconsumed')

        assert.equal((await drain(result.body)).toString(), 'chunk1chunk2')
        assert.ok(resumeCalls > 0, 'expected the socket to resume once the queue was drained')
    })
})
