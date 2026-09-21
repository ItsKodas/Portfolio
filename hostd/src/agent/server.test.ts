import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair } from 'node:stream'
import { handleConnection, readRequestLine, type AgentHandler } from './server.ts'
import type { AgentRequest, HealthReply, LogLine } from '../shared/protocol.ts'
import { MAX_REQUEST_BYTES } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: null, text: 'hello', truncated: false }
// Any reply will do for a transport test; health is the smallest real one.
const health: HealthReply = { ok: true, warnings: [], invalid: {}, system: { memory: null, cpu: null, disk: null, problems: [] } }

function stubAgent(handle: AgentHandler['handle']): AgentHandler & { requests: AgentRequest[] } {
    const requests: AgentRequest[] = []
    return {
        requests,
        handle: async request => {
            requests.push(request)
            return handle(request)
        },
    }
}

// Sends raw bytes as the client and returns every line the server wrote before closing.
async function exchange(agent: AgentHandler, raw: string): Promise<string[]> {
    const [client, server] = duplexPair()
    const logged: string[] = []
    const done = handleConnection(server, agent, message => logged.push(message))
    client.write(raw)
    client.setEncoding('utf8')
    let text = ''
    for await (const chunk of client) text += chunk
    await done
    return text.split('\n').filter(part => part !== '')
}

describe('readRequestLine', () => {
    it('resolves the line', async () => {
        const [client, server] = duplexPair()
        const result = readRequestLine(server)
        client.end('{"verb":"health"}\n')
        assert.deepEqual(await result, { line: '{"verb":"health"}' })
    })

    it('reports empty when the peer closes without sending a byte', async () => {
        const [client, server] = duplexPair()
        const result = readRequestLine(server)
        client.end()
        assert.deepEqual(await result, { line: null, reason: 'empty' })
    })

    it('reports incomplete when the peer sends bytes then closes without a newline', async () => {
        const [client, server] = duplexPair()
        const result = readRequestLine(server)
        client.end('{"verb":"hea')
        assert.deepEqual(await result, { line: null, reason: 'incomplete' })
    })

    it('reports oversize when the line exceeds the byte cap', async () => {
        const [client, server] = duplexPair()
        const result = readRequestLine(server, 10)
        client.end('x'.repeat(20))
        assert.deepEqual(await result, { line: null, reason: 'oversize' })
    })
})

describe('handleConnection', () => {
    it('answers a request with one JSON line and closes', async () => {
        const agent = stubAgent(async () => ({ kind: 'reply', reply: health }))
        assert.deepEqual(await exchange(agent, '{"verb":"health"}\n'), [JSON.stringify(health)])
        assert.deepEqual(agent.requests, [{ verb: 'health' }])
    })

    it('logs a branches request by its project, the same as every other project verb', async () => {
        const agent = stubAgent(async () => ({ kind: 'reply', reply: { ok: true, branches: ['main'] } }))
        const [client, server] = duplexPair()
        const logged: string[] = []
        const done = handleConnection(server, agent, message => logged.push(message))
        client.end('{"verb":"branches","project":"acme"}\n')
        client.setEncoding('utf8')
        for await (const _chunk of client) { /* drain */ }
        await done
        assert.deepEqual(logged, ['branches acme ok'])
    })

    it('refuses a malformed request without calling the agent', async () => {
        const agent = stubAgent(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(agent, '{"verb":"exec","project":"acme"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'unknown verb' })
        assert.deepEqual(agent.requests, [])
    })

    it('refuses a request line longer than the limit', async () => {
        const agent = stubAgent(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(agent, 'x'.repeat(MAX_REQUEST_BYTES + 10))
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' })
    })

    it('reports an agent error as unavailable rather than dropping the connection', async () => {
        const agent = stubAgent(async () => { throw new Error('connect ENOENT /var/run/docker.sock') })
        const [reply] = await exchange(agent, '{"verb":"status","project":"acme"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'unavailable', message: 'connect ENOENT /var/run/docker.sock' })
    })

    it('streams a header then one JSON line per log line', async () => {
        const agent = stubAgent(async () => ({
            kind: 'stream',
            lines: (async function* () { yield line; yield { ...line, text: 'again' } })(),
            close: () => {},
        }))
        const lines = await exchange(agent, '{"verb":"logs","project":"acme","args":{"service":"web"}}\n')
        assert.deepEqual(lines.map(l => JSON.parse(l)), [{ ok: true, stream: true }, line, { ...line, text: 'again' }])
    })

    it('closes the stream when the client goes away', async () => {
        let closed = false
        let wake: () => void = () => {}
        const agent = stubAgent(async () => ({
            kind: 'stream',
            lines: (async function* () {
                yield line
                await new Promise<void>(resolve => { wake = resolve })
            })(),
            close: () => {
                closed = true
                wake()
            },
        }))
        const [client, server] = duplexPair()
        const done = handleConnection(server, agent, () => {})
        client.write('{"verb":"logs","project":"acme","args":{"service":"web","follow":true}}\n')
        client.setEncoding('utf8')
        let text = ''
        await new Promise<void>(resolve => {
            client.on('data', (chunk: string) => {
                text += chunk
                if (text.split('\n').length > 2) resolve()
            })
        })
        client.end()
        await done
        assert.equal(closed, true)
    })

    it('closes a follow stream whose peer left before handle() resolved', async () => {
        let closed = false
        let wake: () => void = () => {}
        const agent = stubAgent(async () => {
            await new Promise(resolve => setTimeout(resolve, 50))
            return {
                kind: 'stream',
                lines: (async function* () {
                    await new Promise<void>(resolve => { wake = resolve })
                })(),
                close: () => {
                    closed = true
                    wake()
                },
            }
        })
        const [client, server] = duplexPair()
        const done = handleConnection(server, agent, () => {})
        client.write('{"verb":"logs","project":"acme","args":{"service":"web","follow":true}}\n')
        client.end()

        // A bounded race: if the fix regresses, `done` never resolves (the stream's lines generator waits
        // on `wake`, which only close() calls), so this fails as an assertion rather than hanging the suite.
        const result = await Promise.race([
            done.then(() => 'done' as const),
            new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 300)),
        ])
        assert.equal(result, 'done')
        assert.equal(closed, true)
    })
})
