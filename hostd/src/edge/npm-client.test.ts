import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NpmClient, NpmError } from './npm-client.ts'

type Call = { method: string, url: string, headers: Record<string, string>, body: unknown }
type Reply = { status: number, body: unknown } | 'hang'

const BASE = 'http://npm.test:81/api'

function json(status: number, body: unknown): Reply {
    return { status, body }
}

function fake(replies: Reply[]) {
    const calls: Call[] = []
    const impl = (async (input: string, init: RequestInit = {}) => {
        calls.push({
            method: init.method ?? 'GET',
            url: String(input),
            headers: { ...(init.headers as Record<string, string> | undefined) },
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        const reply = replies.shift()
        if (!reply) throw new Error('unexpected extra call')
        if (reply === 'hang') {
            return new Promise<Response>((_, reject) => {
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            })
        }
        return new Response(JSON.stringify(reply.body), { status: reply.status })
    }) as unknown as typeof fetch
    return { calls, impl }
}

const HOUR = 3_600_000
const token = (value: string, expiresAt: number) => json(200, { token: value, expires: new Date(expiresAt).toISOString() })

function client(replies: Reply[], extra: { now?: () => number, timeoutMs?: number } = {}) {
    const { calls, impl } = fake(replies)
    const at = (index: number): Call => calls[index] as Call
    return { calls, at, npm: new NpmClient({ url: BASE, identity: 'me@x.test', secret: 's3cret', fetch: impl, ...extra }) }
}

test('logs in once and reuses the token', async () => {
    const now = 1_000_000
    const { calls, at, npm } = client([token('t1', now + HOUR), json(200, []), json(200, [])], { now: () => now })
    await npm.list('proxy-hosts')
    await npm.list('proxy-hosts')
    assert.equal(calls.length, 3)
    assert.equal(at(0).method, 'POST')
    assert.equal(at(0).url, `${BASE}/tokens`)
    assert.deepEqual(at(0).body, { identity: 'me@x.test', secret: 's3cret' })
    assert.equal(at(1).url, `${BASE}/nginx/proxy-hosts`)
    assert.equal(at(1).headers.Authorization, 'Bearer t1')
    assert.equal(at(2).headers.Authorization, 'Bearer t1')
})

test('refreshes before expiry', async () => {
    let now = 1_000_000
    const expires = now + HOUR
    const { calls, at, npm } = client([token('t1', expires), json(200, []), token('t2', expires + HOUR), json(200, [])], { now: () => now })
    await npm.list('proxy-hosts')
    now = expires - 5 * 60_000
    await npm.list('proxy-hosts')
    assert.equal(at(2).method, 'GET')
    assert.equal(at(2).url, `${BASE}/tokens`)
    assert.equal(at(2).headers.Authorization, 'Bearer t1')
    assert.equal(at(3).headers.Authorization, 'Bearer t2')
})

test('logs in again once on a 401, then gives up', async () => {
    const now = 1_000_000
    const { calls, at, npm } = client([
        token('t1', now + HOUR), json(401, { error: { code: 401, message: 'Unauthorized' } }),
        token('t2', now + HOUR), json(200, [{ id: 1 }]),
        json(401, {}), token('t3', now + HOUR), json(401, { error: { code: 401, message: 'nope' } }),
    ], { now: () => now })
    assert.deepEqual(await npm.list('proxy-hosts'), [{ id: 1 }])
    assert.equal(calls.length, 4)
    assert.equal(at(3).headers.Authorization, 'Bearer t2')
    await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => error instanceof NpmError && error.status === 401 && error.body.includes('nope'))
    assert.equal(calls.length, 7)
})

test('create/update/remove hit the right paths', async () => {
    const now = 1_000_000
    const { calls, at, npm } = client([token('t1', now + HOUR), json(201, { id: 9 }), json(200, { id: 4 }), json(200, true)], { now: () => now })
    assert.deepEqual(await npm.create('proxy-hosts', { a: 1 }), { id: 9 })
    await npm.update('redirection-hosts', 4, { b: 2 })
    await npm.remove('dead-hosts', 2)
    assert.deepEqual([at(1).method, at(1).url, at(1).body], ['POST', `${BASE}/nginx/proxy-hosts`, { a: 1 }])
    assert.deepEqual([at(2).method, at(2).url, at(2).body], ['PUT', `${BASE}/nginx/redirection-hosts/4`, { b: 2 }])
    assert.deepEqual([at(3).method, at(3).url], ['DELETE', `${BASE}/nginx/dead-hosts/2`])
})

test('get answers null on 404', async () => {
    const now = 1_000_000
    const { npm } = client([token('t1', now + HOUR), json(404, { error: { code: 404, message: 'Not Found' } }), json(200, { id: 3 })], { now: () => now })
    assert.equal(await npm.get('proxy-hosts', 7), null)
    assert.deepEqual(await npm.get('proxy-hosts', 3), { id: 3 })
})

test('other failures throw NpmError with the body', async () => {
    const now = 1_000_000
    const { npm } = client([token('t1', now + HOUR), json(400, { error: { code: 400, message: 'bad domain' } })], { now: () => now })
    await assert.rejects(npm.create('proxy-hosts', {}), (error: unknown) => error instanceof NpmError && error.status === 400 && error.body.includes('bad domain'))
})

test('times out after timeoutMs', async () => {
    const { npm } = client(['hang'], { timeoutMs: 20 })
    await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => error instanceof NpmError && error.status === null && error.message.includes('/tokens'))
})

test('certificateIds skips deleted certificates', async () => {
    const now = 1_000_000
    const { npm } = client([token('t1', now + HOUR), json(200, [{ id: 1 }, { id: 2, is_deleted: 1 }, { id: 3, is_deleted: 0 }])], { now: () => now })
    assert.deepEqual(await npm.certificateIds(), [1, 3])
})

test('ageOfLastSuccess is null until a call succeeds', async () => {
    let now = 1_000_000
    const { npm } = client([token('t1', now + HOUR), json(200, [])], { now: () => now })
    assert.equal(npm.ageOfLastSuccess(), null)
    await npm.list('proxy-hosts')
    now += 5000
    assert.equal(npm.ageOfLastSuccess(), 5000)
})
