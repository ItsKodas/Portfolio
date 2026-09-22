import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair } from 'node:stream'
import { handleConnection, readRequestLine, type AgentHandler } from './server.ts'
import type { AgentRequest, HealthReply, LogLine } from '../shared/protocol.ts'
import { MAX_BODY_FRAME_BYTES, MAX_REQUEST_BYTES } from '../shared/protocol.ts'

const DOWNLOAD_REQUEST = '{"verb":"backup","project":"acme","args":{"action":"download","snapshot":"deadbeef"}}\n'
const line: LogLine = { stream: 'stdout', ts: null, text: 'hello', truncated: false }
// Any reply will do for a transport test; health is the smallest real one.
const health: HealthReply = { ok: true, warnings: [], invalid: {}, system: { memory: null, cpu: null, disk: null, problems: [] }, railAge: null }

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

// Like exchange, but keeps the raw Buffer chunks the server wrote rather than decoding them as UTF-8:
// a download's body must survive byte for byte, which exchange's setEncoding('utf8') would corrupt.
async function exchangeBytes(agent: AgentHandler, raw: string): Promise<Buffer> {
    const [client, server] = duplexPair()
    const done = handleConnection(server, agent, () => {})
    client.write(raw)
    const chunks: Buffer[] = []
    for await (const chunk of client) chunks.push(chunk as Buffer)
    await done
    return Buffer.concat(chunks)
}

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

    it('logs a credentials request by its verb alone, having no project to log it by', async () => {
        const agent = stubAgent(async () => ({ kind: 'reply', reply: { ok: true, credentials: ['acme'] } }))
        const [client, server] = duplexPair()
        const logged: string[] = []
        const done = handleConnection(server, agent, message => logged.push(message))
        client.end('{"verb":"credentials"}\n')
        client.setEncoding('utf8')
        for await (const _chunk of client) { /* drain */ }
        await done
        assert.deepEqual(logged, ['credentials ok'])
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

    it('writes a bytes outcome as a header line, one frame per chunk, then the terminator', async () => {
        const agent = stubAgent(async () => ({
            kind: 'bytes',
            body: (async function* () { yield Buffer.from('tar'); yield Buffer.from(' bytes') })(),
            close: () => {},
        }))
        const output = await exchangeBytes(agent, DOWNLOAD_REQUEST)
        const newline = output.indexOf(0x0a)
        assert.deepEqual(JSON.parse(output.subarray(0, newline).toString()), { ok: true, stream: true })
        // The terminator is the whole point: it says the body finished, which a socket closing does not.
        assert.equal(output.subarray(newline + 1).toString(), '3\ntar6\n bytes0\n')
    })

    it('passes non-UTF-8 body bytes through a bytes outcome unchanged', async () => {
        // The case that catches string-based transport: a gzip magic number followed by bytes no UTF-8
        // decoder round-trips.
        const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80])
        const agent = stubAgent(async () => ({
            kind: 'bytes',
            body: (async function* () { yield body })(),
            close: () => {},
        }))
        const output = await exchangeBytes(agent, DOWNLOAD_REQUEST)
        const newline = output.indexOf(0x0a)
        assert.deepEqual(output.subarray(newline + 1), Buffer.concat([Buffer.from('8\n'), body, Buffer.from('0\n')]))
    })

    it('writes no terminator when the body throws, so a short download cannot read as a complete one', async () => {
        // The production failure: restic dump exits non-zero after some bytes have already gone out. The
        // bytes written before the throw are real and stay on the wire; what must not appear after them
        // is the terminator, because that is the only thing api accepts as proof the body is whole.
        // The throw waits until the first frame has actually been read by the peer, so the assertion is
        // about what the protocol wrote and not about what a destroyed socket happened to discard.
        let arrived: () => void = () => {}
        const delivered = new Promise<void>(resolve => { arrived = resolve })
        const agent = stubAgent(async () => ({
            kind: 'bytes',
            body: (async function* () {
                yield Buffer.from('partial')
                await delivered
                throw new Error('restic dump exited with code 1')
            })(),
            close: () => {},
        }))
        const [client, server] = duplexPair()
        const chunks: Buffer[] = []
        client.on('data', chunk => {
            chunks.push(chunk as Buffer)
            if (Buffer.concat(chunks).includes('7\npartial')) arrived()
        })
        const done = handleConnection(server, agent, () => {})
        client.write(DOWNLOAD_REQUEST)
        await done
        await new Promise(resolve => setImmediate(resolve))
        const output = Buffer.concat(chunks)
        const newline = output.indexOf(0x0a)
        assert.deepEqual(JSON.parse(output.subarray(0, newline).toString()), { ok: true, stream: true })
        assert.equal(output.subarray(newline + 1).toString(), '7\npartial')
    })

    it('splits a chunk larger than the frame cap rather than writing a frame the reader would refuse', async () => {
        const body = Buffer.alloc(MAX_BODY_FRAME_BYTES + 5, 0x61)
        const agent = stubAgent(async () => ({
            kind: 'bytes',
            body: (async function* () { yield body })(),
            close: () => {},
        }))
        const output = await exchangeBytes(agent, DOWNLOAD_REQUEST)
        const newline = output.indexOf(0x0a)
        const framed = output.subarray(newline + 1)
        assert.ok(framed.subarray(0, 16).toString().startsWith(`${MAX_BODY_FRAME_BYTES}\n`))
        // The remainder as its own frame, then the terminator.
        assert.equal(framed.subarray(framed.length - 9).toString(), '5\naaaaa0\n')
    })

    it('closes a bytes outcome when the client goes away', async () => {
        let closed = false
        let wake: () => void = () => {}
        const agent = stubAgent(async () => ({
            kind: 'bytes',
            body: (async function* () {
                yield Buffer.from('first')
                await new Promise<void>(resolve => { wake = resolve })
            })(),
            close: () => {
                closed = true
                wake()
            },
        }))
        const [client, server] = duplexPair()
        const done = handleConnection(server, agent, () => {})
        client.write('{"verb":"backup","project":"acme","args":{"action":"download","snapshot":"deadbeef"}}\n')
        // Wait for at least the header and the first body bytes before the peer leaves.
        await new Promise<void>(resolve => {
            client.on('data', function onData() {
                client.off('data', onData)
                resolve()
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
