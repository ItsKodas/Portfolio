import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createFetchClient, FetcherUnavailableError, type Connect } from './fetch-client.ts'
import { handleFetchConnection } from '../fetcher/server.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

// Each connect() gets a fresh socket pair whose far end is served by the real fetcher server.
function connectTo(run: (request: FetchRequest) => Promise<FetchReply>): Connect {
    return () => {
        const [client, server] = duplexPair()
        void handleFetchConnection(server, run, () => {})
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

describe('call', () => {
    it('writes one JSON line and reads one reply', async () => {
        const client = createFetchClient(connectTo(async request => {
            assert.deepEqual(request, { verb: 'tip', dir: '/var/www/acme', branch: 'main' })
            return { ok: true, commit: 'a1b2c3d' }
        }))
        assert.deepEqual(await client.call({ verb: 'tip', dir: '/var/www/acme', branch: 'main' }), { ok: true, commit: 'a1b2c3d' })
    })

    it('passes a refusal through unchanged', async () => {
        const client = createFetchClient(connectTo(async () => ({ ok: false, code: 'failed', message: 'fatal: repository not found' })))
        assert.deepEqual(await client.call({ verb: 'fetch', dir: '/var/www/acme', branch: null, credential: null }), { ok: false, code: 'failed', message: 'fatal: repository not found' })
    })

    it('throws FetcherUnavailableError when the socket closes with no reply', async () => {
        const client = createFetchClient(connectRaw(server => {
            server.once('data', () => server.end())
        }))
        await assert.rejects(client.call({ verb: 'fetch', dir: '/var/www/acme', branch: null, credential: null }), (error: unknown) => {
            assert.ok(error instanceof FetcherUnavailableError)
            assert.equal(error.message, 'the fetcher closed the connection without answering')
            return true
        })
    })

    it('throws FetcherUnavailableError on timeout, and closes the socket', async () => {
        let clientSide!: Duplex
        const client = createFetchClient(connectRaw((_server, side) => { clientSide = side }), { timeoutMs: 30 })
        await assert.rejects(client.call({ verb: 'fetch', dir: '/var/www/acme', branch: null, credential: null }), /the fetcher did not answer within 0\.03 seconds/)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(clientSide.writableEnded, true)
    })

    it('throws FetcherUnavailableError when the socket fails', async () => {
        const client = createFetchClient(connectRaw((_server, clientSide) => {
            setImmediate(() => clientSide.destroy(new Error('connect ENOENT /run/hostd/fetch.sock')))
        }))
        await assert.rejects(client.call({ verb: 'fetch', dir: '/var/www/acme', branch: null, credential: null }), /the fetcher connection failed: connect ENOENT \/run\/hostd\/fetch\.sock/)
    })

    it('throws FetcherUnavailableError on a reply that is not JSON', async () => {
        const client = createFetchClient(connectRaw(server => {
            server.once('data', () => server.end('garbage\n'))
        }))
        await assert.rejects(client.call({ verb: 'fetch', dir: '/var/www/acme', branch: null, credential: null }), /the fetcher sent an unreadable reply/)
    })
})
