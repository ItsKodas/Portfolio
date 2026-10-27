import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NpmClient, NpmError, npmConnection } from './npm-client.ts'

type Call = { method: string, url: string, headers: Record<string, string>, body: unknown }
type Reply = { status: number, body: unknown, cookies?: string[] } | 'hang'

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
                const signal = init.signal
                if (signal?.aborted) return reject(signal.reason)
                signal?.addEventListener('abort', () => reject(signal.reason))
            })
        }
        const headers = new Headers()
        for (const cookie of reply.cookies ?? []) headers.append('Set-Cookie', cookie)
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers })
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

// NPMplus: the session is a signed __Host- cookie, never a bearer token, and the server refuses a
// request whose Origin or Sec-Fetch-Site says it came from another site.
const PLUS = 'https://npmplus.test:81/api'
const COOKIE = 's%3Aeyabc.signature%2Bpart'
const cookieReply = (value: string, expiresAt: number): Reply => ({
    status: 200,
    body: { expires: new Date(expiresAt).toISOString() },
    cookies: [
        'other=1; Path=/',
        `__Host-Http-token=${value}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`,
    ],
})

function plusClient(replies: Reply[], extra: { now?: () => number } = {}) {
    const { calls, impl } = fake(replies)
    const at = (index: number): Call => calls[index] as Call
    return { calls, at, npm: new NpmClient({ url: PLUS, identity: 'me@x.test', secret: 's3cret', fetch: impl, flavour: 'npmplus', ...extra }) }
}

test('npmplus logs in with a cookie and sends it back exactly, with no bearer token', async () => {
    const now = 1_000_000
    const { calls, at, npm } = plusClient([cookieReply(COOKIE, now + HOUR), json(200, []), json(200, [])], { now: () => now })
    await npm.list('proxy-hosts')
    await npm.list('redirection-hosts')
    assert.equal(calls.length, 3)
    assert.deepEqual([at(0).method, at(0).url, at(0).body], ['POST', `${PLUS}/tokens`, { identity: 'me@x.test', secret: 's3cret' }])
    for (const index of [1, 2]) {
        assert.equal(at(index).headers.Cookie, `__Host-Http-token=${COOKIE}`)
        assert.equal(at(index).headers.Authorization, undefined)
    }
})

test('npmplus requests carry no Origin or Sec-Fetch-Site, which NPMplus would refuse', async () => {
    const now = 1_000_000
    const { calls, npm } = plusClient([cookieReply(COOKIE, now + HOUR), json(201, { id: 9 }), json(200, { id: 9 })], { now: () => now })
    await npm.create('proxy-hosts', { a: 1 })
    await npm.update('proxy-hosts', 9, { a: 2 })
    assert.equal(calls.length, 3)
    for (const call of calls) {
        const names = Object.keys(call.headers).map(name => name.toLowerCase())
        assert.equal(names.includes('origin'), false, call.url)
        assert.equal(names.includes('sec-fetch-site'), false, call.url)
    }
})

test('npmplus refreshes with GET /tokens before expiry and uses the new cookie', async () => {
    let now = 1_000_000
    const expires = now + HOUR
    const { at, npm } = plusClient([cookieReply('c1', expires), json(200, []), cookieReply('c2', expires + HOUR), json(200, [])], { now: () => now })
    await npm.list('proxy-hosts')
    now = expires - 5 * 60_000
    await npm.list('proxy-hosts')
    assert.deepEqual([at(2).method, at(2).url, at(2).headers.Cookie], ['GET', `${PLUS}/tokens`, '__Host-Http-token=c1'])
    assert.equal(at(3).headers.Cookie, '__Host-Http-token=c2')
})

test('npmplus logs in again once on a 401, then gives up', async () => {
    const now = 1_000_000
    const { calls, at, npm } = plusClient([
        cookieReply('c1', now + HOUR), json(401, { error: { code: 401, message: 'Unauthorized' } }),
        cookieReply('c2', now + HOUR), json(200, [{ id: 1 }]),
        json(401, {}), cookieReply('c3', now + HOUR), json(401, { error: { code: 401, message: 'nope' } }),
    ], { now: () => now })
    assert.deepEqual(await npm.list('proxy-hosts'), [{ id: 1 }])
    assert.equal(at(3).headers.Cookie, '__Host-Http-token=c2')
    await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => error instanceof NpmError && error.status === 401)
    assert.equal(calls.length, 7)
})

// requiresTotp false is NPMplus challenging a user with another two-factor method, and it then sets
// __Host-Http-token to a short-lived challenge token, which must not be taken for a session.
test('npmplus refuses a two-factor challenge, whatever requiresTotp says, and says to turn two-factor off', async () => {
    for (const requiresTotp of [true, false]) {
        const now = 1_000_000
        const challenge: Reply = {
            status: 200, body: { requiresTotp, expires: new Date(now + 300_000).toISOString() },
            cookies: [
                `__Host-Http-challenge_token=${COOKIE}; Path=/; HttpOnly; Secure`,
                `__Host-Http-token=${COOKIE}; Path=/; HttpOnly; Secure`,
            ],
        }
        const { calls, npm } = plusClient([challenge], { now: () => now })
        await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => {
            assert.ok(error instanceof NpmError, String(requiresTotp))
            assert.match(error.message, /turn off two-factor for the hostd user/)
            assert.equal(`${error.message}${error.body}`.includes(COOKIE), false)
            return true
        })
        // Nothing is asked of NPMplus on a session that does not exist.
        assert.equal(calls.length, 1, String(requiresTotp))
    }
})

test('npmplus login without the session cookie fails without repeating any cookie', async () => {
    const now = 1_000_000
    const { npm } = plusClient([{ status: 200, body: { expires: new Date(now + HOUR).toISOString() }, cookies: ['other=s%3Asecretish; Path=/'] }], { now: () => now })
    await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => {
        assert.ok(error instanceof NpmError)
        assert.match(error.message, /session cookie/)
        assert.equal(`${error.message}${error.body}`.includes('secretish'), false)
        return true
    })
})

test('npmplus never puts the cookie value in an error', async () => {
    const now = 1_000_000
    const { npm } = plusClient([cookieReply(COOKIE, now + HOUR), json(500, { error: { message: 'boom' } })], { now: () => now })
    await assert.rejects(npm.list('proxy-hosts'), (error: unknown) => {
        assert.ok(error instanceof NpmError)
        assert.equal(`${error.message}${error.body}${error.stack}`.includes(COOKIE), false)
        return true
    })
})

test('the npm flavour keeps the bearer token and sends no cookie', async () => {
    const now = 1_000_000
    const { at, npm } = client([token('t1', now + HOUR), json(200, [])], { now: () => now })
    await npm.list('proxy-hosts')
    assert.equal(at(1).headers.Authorization, 'Bearer t1')
    assert.equal(at(1).headers.Cookie, undefined)
    assert.equal(npm.flavour, 'npm')
})

test('npmConnection reads the flavour and the URL, refusing what cannot work', () => {
    assert.deepEqual(npmConnection({}), { flavour: 'npm', url: 'http://192.168.0.6:81/api', problems: [] })
    assert.deepEqual(
        npmConnection({ HOSTD_NPM_FLAVOUR: 'npm', HOSTD_NPM_URL: 'http://10.0.0.1:81/api' }),
        { flavour: 'npm', url: 'http://10.0.0.1:81/api', problems: [] },
    )
    assert.deepEqual(
        npmConnection({ HOSTD_NPM_FLAVOUR: 'npmplus', HOSTD_NPM_URL: 'https://192.168.0.6:81/api' }),
        { flavour: 'npmplus', url: 'https://192.168.0.6:81/api', problems: [] },
    )
    // The default URL is stock NPM's plain http, which NPMplus does not serve.
    const plain = npmConnection({ HOSTD_NPM_FLAVOUR: 'npmplus' })
    assert.equal(plain.problems.length, 1)
    assert.match(plain.problems[0]!, /HOSTD_NPM_URL must be an https URL when HOSTD_NPM_FLAVOUR is npmplus/)
    assert.equal(npmConnection({ HOSTD_NPM_FLAVOUR: 'npmplus', HOSTD_NPM_URL: 'not a url' }).problems.length, 1)
    for (const value of ['NPMplus', 'npm-plus', '', ' npm']) {
        const read = npmConnection({ HOSTD_NPM_FLAVOUR: value })
        assert.equal(read.problems.length, 1, value)
        assert.match(read.problems[0]!, /HOSTD_NPM_FLAVOUR must be npm or npmplus/, value)
    }
})
