import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { holdingHandler } from './holding-http.ts'

async function ask(path: string, files: Record<string, string>, method = 'GET') {
    const reads: string[] = []
    const server = createServer(holdingHandler('/pages', async file => {
        reads.push(file)
        return files[file] ?? null
    }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        const { port } = server.address() as AddressInfo
        // http.request rather than fetch, which would normalise the dot segments away
        return await new Promise<{ status: number, headers: Record<string, unknown>, body: string, reads: string[] }>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, path, method }, res => {
                let body = ''
                res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, reads }))
            })
            req.on('error', reject).end()
        })
    } finally {
        server.close()
    }
}

test('a holding page answers 503 with Retry-After and the file body', async () => {
    const reply = await ask('/holding/spotondrones-live', { '/pages/sites/spotondrones-live.html': '<p>back soon</p>' })
    assert.equal(reply.status, 503)
    assert.equal(reply.headers['retry-after'], '120')
    assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(reply.body, '<p>back soon</p>')
})

test('a hyphenated project id splits on the last hyphen', async () => {
    const reply = await ask('/holding/my-site-uat1', { '/pages/sites/my-site-uat1.html': 'x' })
    assert.equal(reply.body, 'x')
})

test('a missing page answers 503 with a built-in page', async () => {
    const reply = await ask('/holding/spotondrones-live', {})
    assert.equal(reply.status, 503)
    assert.match(reply.body, /Be right back/)
})

for (const path of ['/holding/../etc/passwd', '/holding/Bad-Live', '/holding/x-nosuchenv', '/holding/%2e%2e-live', '/holding/', '/']) {
    test(`${path} answers 404 without reading a file`, async () => {
        const reply = await ask(path, {})
        assert.equal(reply.status, 404)
        assert.deepEqual(reply.reads, [])
    })
}

test('other methods answer 404', async () => {
    const reply = await ask('/holding/spotondrones-live', {}, 'POST')
    assert.equal(reply.status, 404)
    assert.deepEqual(reply.reads, [])
})
