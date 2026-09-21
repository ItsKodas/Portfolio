import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createAgentClient, AgentUnavailableError, type Connect } from './agent-client.ts'
import { handleConnection, type AgentHandler } from '../agent/server.ts'
import type { HealthReply, LogLine } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }
const health: HealthReply = { ok: true, warnings: [], invalid: {}, system: { memory: null, cpu: null, disk: null, problems: [] }, railAge: null }

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
