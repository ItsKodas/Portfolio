import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair } from 'node:stream'
import { handleFetchConnection } from './server.ts'
import type { FetchRequest, FetchReply } from '../shared/fetch-protocol.ts'
import { MAX_REQUEST_BYTES } from '../shared/protocol.ts'

function stubRun(run: (request: FetchRequest) => Promise<FetchReply>) {
    const requests: FetchRequest[] = []
    return {
        requests,
        run: async (request: FetchRequest) => {
            requests.push(request)
            return run(request)
        },
    }
}

// Sends raw bytes as the client and returns every line the server wrote before closing.
async function exchange(run: (request: FetchRequest) => Promise<FetchReply>, raw: string, log: (message: string) => void = () => {}): Promise<string[]> {
    const [client, server] = duplexPair()
    const done = handleFetchConnection(server, run, log)
    client.write(raw)
    client.setEncoding('utf8')
    let text = ''
    for await (const chunk of client) text += chunk
    await done
    return text.split('\n').filter(part => part !== '')
}

describe('handleFetchConnection', () => {
    it('answers one request per connection and ends the socket', async () => {
        const stub = stubRun(async () => ({ ok: true, commit: 'a1b2c3d' }))
        const lines = await exchange(stub.run, '{"verb":"tip","dir":"/var/www/acme","branch":"main"}\n')
        assert.deepEqual(lines, ['{"ok":true,"commit":"a1b2c3d"}'])
        assert.deepEqual(stub.requests, [{ verb: 'tip', dir: '/var/www/acme', branch: 'main' }])
    })

    it('refuses an oversized line without reading all of it', async () => {
        const stub = stubRun(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(stub.run, 'x'.repeat(MAX_REQUEST_BYTES + 10))
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' })
        assert.deepEqual(stub.requests, [])
    })

    it('stays quiet, with no reply and no log line, when a peer connects and closes without sending anything', async () => {
        const stub = stubRun(async () => { throw new Error('must not be called') })
        const logged: string[] = []
        const [client, server] = duplexPair()
        const done = handleFetchConnection(server, stub.run, message => logged.push(message))
        client.end()
        client.setEncoding('utf8')
        let text = ''
        for await (const chunk of client) text += chunk
        await done
        assert.equal(text, '')
        assert.deepEqual(logged, [])
        assert.deepEqual(stub.requests, [])
    })

    it('still refuses and logs an incomplete line (bytes sent, no newline, then closed)', async () => {
        const stub = stubRun(async () => { throw new Error('must not be called') })
        const logged: string[] = []
        // exchange() only writes, it never ends the client, which is right for the other cases here (they
        // resolve on a newline or on the byte cap) but wrong for this one, which only resolves on 'end'.
        const [client, server] = duplexPair()
        const done = handleFetchConnection(server, stub.run, message => logged.push(message))
        client.end('{"verb":"tip"')
        client.setEncoding('utf8')
        let text = ''
        for await (const chunk of client) text += chunk
        await done
        assert.deepEqual(JSON.parse(text.split('\n').filter(part => part !== '')[0] ?? ''), { ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' })
        assert.deepEqual(logged, ['refused bad-request: no request line'])
        assert.deepEqual(stub.requests, [])
    })

    it('still refuses and logs an oversized line', async () => {
        const stub = stubRun(async () => { throw new Error('must not be called') })
        const logged: string[] = []
        const [reply] = await exchange(stub.run, 'x'.repeat(MAX_REQUEST_BYTES + 10), logged.push.bind(logged))
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' })
        assert.deepEqual(logged, ['refused bad-request: no request line'])
        assert.deepEqual(stub.requests, [])
    })

    it('refuses a malformed request with bad-request, and never calls git', async () => {
        const stub = stubRun(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(stub.run, '{"verb":"exec"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'unknown verb' })
        assert.deepEqual(stub.requests, [])
    })

    it('turns a thrown error into unavailable rather than crashing the process', async () => {
        const stub = stubRun(async () => { throw new Error('fatal: could not read from remote repository') })
        const [reply] = await exchange(stub.run, '{"verb":"fetch","dir":"/var/www/acme"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'unavailable', message: 'fatal: could not read from remote repository' })
    })

    it('logs every request with its verb and outcome, and never a credential', async () => {
        const logged: string[] = []
        const stub = stubRun(async () => ({ ok: false, code: 'failed', message: 'https://ghp_leakedtoken123@github.com/acme/site.git: fatal: authentication failed' }))
        // Names a real credential (distinct from every other substring in this request: dir and repo both
        // contain "acme", so a name that collided with them would pass even if the name did leak) so that
        // the assertion below proves the name itself never reaches the log, not just that an absent one
        // trivially doesn't.
        await exchange(stub.run, '{"verb":"clone","repo":"https://github.com/acme/site.git","dir":"/var/www/acme","branch":"main","credential":"hiddenname"}\n', message => logged.push(message))
        assert.deepEqual(logged, ['clone /var/www/acme main failed'])
        assert.ok(!logged.join('\n').includes('ghp_'))
        assert.ok(!logged.join('\n').includes('hiddenname'))
    })

    it('answers a branches request and logs it by repo, having no dir to log it by', async () => {
        const logged: string[] = []
        const stub = stubRun(async () => ({ ok: true, branches: ['main', 'develop'] }))
        const lines = await exchange(stub.run, '{"verb":"branches","repo":"git@github.com:acme/site.git"}\n', message => logged.push(message))
        assert.deepEqual(lines, ['{"ok":true,"branches":["main","develop"]}'])
        assert.deepEqual(stub.requests, [{ verb: 'branches', repo: 'git@github.com:acme/site.git', credential: null }])
        assert.deepEqual(logged, ['branches git@github.com:acme/site.git ok'])
    })
})
