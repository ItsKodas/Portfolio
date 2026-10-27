import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair } from 'node:stream'
import { handleEdge, handleEdgeConnection, type EdgeDeps } from './server.ts'
import type { EdgeReply, EdgeRequest, HostsSpec } from '../shared/edge-protocol.ts'

const owner = { project: 'acme', environment: 'production' } as const
const ids = { proxyHost: 1, redirectionHost: null }
const spec: HostsSpec = {
    proxy: { domain_names: ['acme.test'], forward_host: '192.168.0.8', forward_port: 8001, certificate_id: 2, ssl_forced: true, http2_support: true, advanced_config: '# x' },
    redirection: null,
}

function deps(over: Partial<EdgeDeps> = {}): EdgeDeps {
    return {
        npm: { certificateIds: async () => [7, 9], list: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => undefined } as unknown as EdgeDeps['npm'],
        upstreamHost: '192.168.0.8',
        npmAge: () => 1234,
        ...over,
    }
}

describe('handleEdge', () => {
    it('answers each verb through its handler', async () => {
        const calls: string[] = []
        const d = deps({
            hosts: {
                apply: async (_d, o, i, s, adopt) => { calls.push(`apply ${o.project} ${i?.proxyHost} ${s.proxy.forward_port} ${adopt}`); return { ok: true, verb: 'apply', ids, previous: null } },
                remove: async (_d, o, i) => { calls.push(`remove ${o.project} ${i.proxyHost}`); return { ok: true, verb: 'remove' } },
            },
        })
        assert.deepEqual(await handleEdge({ verb: 'health' }, d), { ok: true, verb: 'health', npmAge: 1234 })
        assert.deepEqual(await handleEdge({ verb: 'certificates' }, d), { ok: true, verb: 'certificates', ids: [7, 9] })
        assert.deepEqual(await handleEdge({ verb: 'apply', owner, ids, spec, adopt: false }, d), { ok: true, verb: 'apply', ids, previous: null })
        assert.deepEqual(await handleEdge({ verb: 'remove', owner, ids }, d), { ok: true, verb: 'remove' })
        assert.deepEqual(calls, ['apply acme 1 8001 false', 'remove acme 1'])
        // find and get go to the real hosts.ts; whatever they answer, they answer for their own verb or refuse.
        const found = await handleEdge({ verb: 'find', domains: ['acme.test'] }, d)
        assert.ok(found.ok ? found.verb === 'find' : typeof found.problem === 'string')
        const got = await handleEdge({ verb: 'get', owner, ids }, d)
        assert.ok(got.ok ? got.verb === 'get' : typeof got.problem === 'string')
    })

    it('turns a thrown error into ok false', async () => {
        const d = deps({ npm: { certificateIds: async () => { throw new Error('NPM is down') } } as unknown as EdgeDeps['npm'] })
        assert.deepEqual(await handleEdge({ verb: 'certificates' }, d), { ok: false, problem: 'NPM is down' })
    })

    it('serialises apply and remove calls, and a rejection does not poison the queue', async () => {
        const events: string[] = []
        const release: Array<() => void> = []
        const gate = () => new Promise<void>(resolve => release.push(resolve))
        let n = 0
        const d = deps({
            hosts: {
                apply: async () => {
                    const mine = ++n
                    events.push(`start ${mine}`)
                    await gate()
                    events.push(`end ${mine}`)
                    if (mine === 1) throw new Error('first failed')
                    return { ok: true, verb: 'apply', ids, previous: null }
                },
                remove: async () => { events.push('remove'); return { ok: true, verb: 'remove' } },
            },
        })
        const first = handleEdge({ verb: 'apply', owner, ids, spec, adopt: false }, d)
        const second = handleEdge({ verb: 'apply', owner, ids, spec, adopt: false }, d)
        const third = handleEdge({ verb: 'remove', owner, ids }, d)
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(events, ['start 1'])
        release[0]?.()
        assert.deepEqual(await first, { ok: false, problem: 'first failed' })
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(events, ['start 1', 'end 1', 'start 2'])
        release[1]?.()
        await second
        assert.deepEqual(await third, { ok: true, verb: 'remove' })
        assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'remove'])
    })
})

async function exchange(raw: string, run: (request: EdgeRequest) => Promise<EdgeReply> = async () => ({ ok: true, verb: 'remove' })): Promise<string[]> {
    const [client, server] = duplexPair()
    const done = handleEdgeConnection(server, run, () => {})
    client.write(raw)
    client.setEncoding('utf8')
    let text = ''
    for await (const chunk of client) text += chunk
    await done
    return text.split('\n').filter(part => part !== '')
}

describe('handleEdgeConnection', () => {
    it('answers one request per connection', async () => {
        assert.deepEqual(await exchange('{"verb":"certificates"}\n', async () => ({ ok: true, verb: 'certificates', ids: [1] })), ['{"ok":true,"verb":"certificates","ids":[1]}'])
    })

    it('refuses an unparseable line with ok false', async () => {
        const lines = await exchange('not json\n', async () => { throw new Error('must not run') })
        assert.equal(JSON.parse(lines[0] ?? '').ok, false)
    })

    it('refuses a request with an unknown verb', async () => {
        const lines = await exchange('{"verb":"explode"}\n', async () => { throw new Error('must not run') })
        assert.equal(JSON.parse(lines[0] ?? '').ok, false)
    })

    it('ends quietly on a bare connect and close', async () => {
        const [client, server] = duplexPair()
        const done = handleEdgeConnection(server, async () => { throw new Error('must not run') }, () => {})
        client.end()
        client.resume()
        await done
    })
})
