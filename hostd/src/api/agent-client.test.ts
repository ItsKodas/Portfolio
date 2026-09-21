import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createAgentClient, AgentUnavailableError, type Connect } from './agent-client.ts'
import { handleConnection, type AgentHandler } from '../agent/server.ts'
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

    it('yields body bytes that arrive in the same chunk as the header line', async () => {
        // The case that catches a swallowed remainder: nothing must be lost between the header's
        // newline and the rest of a chunk that arrived alongside it.
        const body = Buffer.from('tar bytes')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.end(Buffer.concat([Buffer.from('{"ok":true,"stream":true}\n'), body]))
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        const chunks: Buffer[] = []
        if (result.ok) for await (const chunk of result.body) chunks.push(chunk)
        assert.deepEqual(Buffer.concat(chunks), body)
    })

    it('parses the header even when a chunk boundary falls inside the header line', async () => {
        const body = Buffer.from('tar bytes')
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write('{"ok":true,"str')
                server.write('eam":true}\n')
                server.end(body)
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        const chunks: Buffer[] = []
        if (result.ok) for await (const chunk of result.body) chunks.push(chunk)
        assert.deepEqual(Buffer.concat(chunks), body)
    })

    it('passes through body bytes that are not valid UTF-8, byte for byte', async () => {
        // A gzip magic number followed by bytes no UTF-8 decoder round-trips. This is the case that
        // catches string decoding: a readline-based path would corrupt these into replacement characters.
        const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80])
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => {
                server.write('{"ok":true,"stream":true}\n')
                server.end(body)
            })
        }))
        const result = await client.download(backup)
        assert.ok(result.ok)
        const chunks: Buffer[] = []
        if (result.ok) for await (const chunk of result.body) chunks.push(chunk)
        assert.deepEqual(Buffer.concat(chunks), body)
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
        assert.equal((await iterator.next()).done, true)
    })

    it('rejects the header read with the real failure reason, not the generic closed-without-answering message', async () => {
        const client = createAgentClient(connectRaw((_server, clientSide) => {
            setImmediate(() => clientSide.destroy(new Error('read ECONNRESET')))
        }))
        await assert.rejects(client.download(backup), /the agent connection failed: read ECONNRESET/)
    })

    it('rejects a pending body read with the real failure, rather than ending the body silently', async () => {
        // A truncated body that ends quietly is indistinguishable from a complete one until someone tries
        // to restore it. A socket failure mid-download must reject, not resolve as a clean end.
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
        server.write('first')
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
        // paused rather than piling more of a multi-gigabyte download into an unbounded array.
        server.write(Buffer.from('chunk1'))
        server.write(Buffer.from('chunk2'))
        server.end()
        await new Promise(resolve => setImmediate(resolve))
        assert.ok(pauseCalls > 0, 'expected the socket to be paused while chunks were unconsumed')

        const chunks: Buffer[] = []
        for await (const chunk of result.body) chunks.push(chunk)
        assert.equal(Buffer.concat(chunks).toString(), 'chunk1chunk2')
        assert.ok(resumeCalls > 0, 'expected the socket to resume once the queue was drained')
    })
})
