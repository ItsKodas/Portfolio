import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { edgeClient, EdgeUnavailableError, EDGE_TIMEOUT_MS, type Connect } from './edge-client.ts'
import { handleEdgeConnection } from '../edge/server.ts'
import type { EdgeReply, EdgeRequest } from '../shared/edge-protocol.ts'

function connectTo(run: (request: EdgeRequest) => Promise<EdgeReply>): Connect {
    return () => {
        const [client, server] = duplexPair()
        void handleEdgeConnection(server, run, () => {})
        return client
    }
}

function connectRaw(behaviour: (server: Duplex, client: Duplex) => void): Connect {
    return () => {
        const [client, server] = duplexPair()
        behaviour(server, client)
        return client
    }
}

describe('call', () => {
    it('writes one JSON line and reads one reply', async () => {
        const client = edgeClient(connectTo(async request => {
            assert.deepEqual(request, { verb: 'certificates' })
            return { ok: true, verb: 'certificates', ids: [3, 4] }
        }))
        assert.deepEqual(await client.call({ verb: 'certificates' }), { ok: true, verb: 'certificates', ids: [3, 4] })
    })

    it('passes a refusal through', async () => {
        const client = edgeClient(connectTo(async () => ({ ok: false, problem: 'NPM said no' })))
        assert.deepEqual(await client.call({ verb: 'health' }), { ok: false, problem: 'NPM said no' })
    })

    it('leaves room for a create, a redirection host and a revert', () => {
        assert.equal(EDGE_TIMEOUT_MS, 150_000)
    })

    it('throws EdgeUnavailableError when the socket closes with no reply', async () => {
        const client = edgeClient(connectRaw(server => { server.once('data', () => server.end()) }))
        await assert.rejects(client.call({ verb: 'health' }), (error: unknown) => {
            assert.ok(error instanceof EdgeUnavailableError)
            assert.equal(error.message, 'edge closed the connection without answering')
            return true
        })
    })

    it('throws EdgeUnavailableError on timeout, and closes the socket', async () => {
        let clientSide!: Duplex
        const client = edgeClient(connectRaw((_server, side) => { clientSide = side }), { timeoutMs: 30 })
        await assert.rejects(client.call({ verb: 'health' }), /edge did not answer within 0\.03 seconds/)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(clientSide.writableEnded, true)
    })

    it('throws EdgeUnavailableError when the socket fails', async () => {
        const client = edgeClient(connectRaw((_server, side) => {
            setImmediate(() => side.destroy(new Error('connect ENOENT /run/hostd-edge/edge.sock')))
        }))
        await assert.rejects(client.call({ verb: 'health' }), /edge connection failed: connect ENOENT/)
    })

    it('throws EdgeUnavailableError on a reply that is not JSON', async () => {
        const client = edgeClient(connectRaw(server => { server.once('data', () => server.end('garbage\n')) }))
        await assert.rejects(client.call({ verb: 'health' }), /edge sent an unreadable reply/)
    })

    it('throws EdgeUnavailableError on JSON that is not an edge reply', async () => {
        const client = edgeClient(connectRaw(server => { server.once('data', () => server.end('{"ok":true,"verb":"nope"}\n')) }))
        await assert.rejects(client.call({ verb: 'health' }), /edge sent an unreadable reply/)
    })
})
