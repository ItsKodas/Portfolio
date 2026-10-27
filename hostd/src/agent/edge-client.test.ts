import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { edgeClient, EdgeUnavailableError, EDGE_CONFIRM_TIMEOUT_MS, EDGE_TIMEOUT_MS, type Connect } from './edge-client.ts'
import { CALL_TIMEOUT_MS } from '../api/agent-client.ts'
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

    // api gives up on the agent after CALL_TIMEOUT_MS, and for an adopt that means it never runs its own
    // rollback. An apply that times out is followed by one confirming read, so both together must end
    // inside api's window, with room to spare for the agent's own work around them.
    it('lets an apply and its confirming read finish before api gives up', () => {
        assert.ok(EDGE_TIMEOUT_MS + EDGE_CONFIRM_TIMEOUT_MS <= CALL_TIMEOUT_MS - 10_000, `${EDGE_TIMEOUT_MS} + ${EDGE_CONFIRM_TIMEOUT_MS} against ${CALL_TIMEOUT_MS}`)
    })

    it('honours a per-call timeout', async () => {
        const client = edgeClient(connectRaw(() => {}), { timeoutMs: 60_000 })
        const started = Date.now()
        await assert.rejects(client.call({ verb: 'health' }, { timeoutMs: 50 }), /within 0.05 seconds/)
        assert.ok(Date.now() - started < 5_000)
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
