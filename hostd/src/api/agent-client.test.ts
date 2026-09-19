import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createAgentClient, AgentUnavailableError, type Connect } from './agent-client.ts'
import { handleConnection, type AgentHandler } from '../agent/server.ts'
import type { LogLine } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }

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
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: true, warnings: [], invalid: {} } }) }))
        assert.deepEqual(await client.call({ verb: 'health' }), { ok: true, warnings: [], invalid: {} })
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
})
