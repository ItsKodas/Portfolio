import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markerFor, type HostsSpec, type Owner } from '../shared/edge-protocol.ts'
import { applyHosts, findHosts, getHosts, removeHosts, type HostsDeps } from './hosts.ts'
import { FakeNpm } from './testing/fake-npm.ts'

const OWNER: Owner = { project: 'spotondrones', environment: 'live' }
const MARKER = markerFor(OWNER)
const UPSTREAM = '192.168.0.8'

function setup(): { npm: FakeNpm, deps: HostsDeps } {
    const npm = new FakeNpm()
    npm.certificates = [16]
    return { npm, deps: { npm, upstreamHost: UPSTREAM } }
}

function spec(over: { aliases?: string[], port?: number, certificate?: number, owner?: Owner } = {}): HostsSpec {
    const certificate = over.certificate ?? 16
    const marker = markerFor(over.owner ?? OWNER)
    const aliases = over.aliases ?? ['www.spotondrones.com']
    return {
        proxy: {
            domain_names: ['spotondrones.com'], forward_host: UPSTREAM, forward_port: over.port ?? 5007, certificate_id: certificate,
            ssl_forced: certificate !== 0, http2_support: certificate !== 0, advanced_config: `${marker}\n\nreturn 418;`,
        },
        redirection: aliases.length === 0 ? null : {
            domain_names: aliases, forward_domain_name: 'spotondrones.com', certificate_id: certificate,
            ssl_forced: certificate !== 0, http2_support: certificate !== 0, advanced_config: `${marker}\n`,
        },
    }
}

// A proxy host with every field NPM keeps, as NPM returns it (booleans as 0/1).
function proxyRecord(id: number, over: Record<string, unknown> = {}) {
    return {
        id, domain_names: ['spotondrones.com'], forward_scheme: 'http', forward_host: UPSTREAM, forward_port: 5007,
        certificate_id: 16, ssl_forced: 1, http2_support: 1, hsts_enabled: 0, hsts_subdomains: 0, caching_enabled: 0,
        access_list_id: 0, block_exploits: 1, allow_websocket_upgrade: 1, advanced_config: `${MARKER}\nold`, locations: [], ...over,
    }
}

function redirectionRecord(id: number, over: Record<string, unknown> = {}) {
    return {
        id, domain_names: ['www.spotondrones.com'], forward_scheme: 'https', forward_domain_name: 'spotondrones.com',
        forward_http_code: 301, preserve_path: 1, certificate_id: 16, ssl_forced: 1, http2_support: 1, hsts_enabled: 0,
        hsts_subdomains: 0, block_exploits: 1, advanced_config: `${MARKER}\n`, ...over,
    }
}

function writes(npm: FakeNpm): string[] {
    return npm.calls.filter(call => /^(create|update|remove) /.test(call))
}

test('creates a proxy and a redirection host and answers their ids', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, null, spec(), false)
    assert.deepEqual(reply, { ok: true, verb: 'apply', ids: { proxyHost: 100, redirectionHost: 101 }, previous: null })
    assert.deepEqual(writes(npm), ['create proxy-hosts', 'create redirection-hosts'])
    const state = npm.snapshot()
    const proxy = state['proxy-hosts'][0]!
    assert.equal(proxy.forward_scheme, 'http')
    assert.equal(proxy.forward_host, UPSTREAM)
    assert.equal(proxy.forward_port, 5007)
    assert.equal(proxy.hsts_enabled, false)
    assert.equal(proxy.hsts_subdomains, false)
    assert.equal(proxy.caching_enabled, false)
    assert.equal(proxy.access_list_id, 0)
    assert.equal(proxy.block_exploits, true)
    assert.equal(proxy.allow_websocket_upgrade, true)
    assert.deepEqual(proxy.locations, [])
    assert.equal(proxy.advanced_config.split('\n')[0], MARKER)
    const redirection = state['redirection-hosts'][0]!
    assert.equal(redirection.forward_scheme, 'https')
    assert.equal(redirection.forward_http_code, 301)
    assert.equal(redirection.preserve_path, true)
    assert.equal(redirection.forward_domain_name, 'spotondrones.com')
    // NPM's redirection-host schema rejects proxy-only fields, so they must not be sent.
    for (const key of ['locations', 'caching_enabled', 'access_list_id', 'allow_websocket_upgrade', 'forward_host', 'forward_port']) {
        assert.equal(key in redirection, false, key)
    }
})

test('creates only a proxy host when there are no aliases', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, null, spec({ aliases: [] }), false)
    assert.deepEqual(reply, { ok: true, verb: 'apply', ids: { proxyHost: 100, redirectionHost: null }, previous: null })
    assert.deepEqual(writes(npm), ['create proxy-hosts'])
})

test('refuses a create when a domain is already on another host', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(7, { domain_names: ['WWW.spotondrones.com.'], advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, null, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'www.spotondrones.com is already on NPM proxy host 7' })
    assert.deepEqual(writes(npm), [])
})

test('refuses a create when a domain is on a redirection or 404 host', async () => {
    const { npm, deps } = setup()
    npm.seed('dead-hosts', { id: 3, domain_names: ['spotondrones.com'] })
    const reply = await applyHosts(deps, OWNER, null, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'spotondrones.com is already on NPM 404 host 3' })
    assert.deepEqual(writes(npm), [])
})

test('refuses to update a host without this owner\'s marker', async () => {
    const cases: [string, string][] = [
        ['no marker', 'hand made'],
        ['another environment', `${markerFor({ project: 'spotondrones', environment: 'staging' })}\n`],
        ['another project', `${markerFor({ project: 'pmpcold', environment: 'live' })}\n`],
        ['marker on line 2', `# hand made\n${MARKER}`],
    ]
    for (const [label, config] of cases) {
        const { npm, deps } = setup()
        npm.seed('proxy-hosts', proxyRecord(10, { advanced_config: config }))
        const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), false)
        assert.equal(reply.ok, false, label)
        assert.match((reply as { problem: string }).problem, /NPM proxy host 10 does not carry the marker for spotondrones\/live/, label)
        assert.deepEqual(writes(npm), [], label)
    }
})

test('refuses to update a redirection host without this owner\'s marker', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4, { advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec(), false)
    assert.equal(reply.ok, false)
    assert.match((reply as { problem: string }).problem, /NPM redirection host 4 does not carry the marker/)
    assert.deepEqual(writes(npm), [])
})

test('updates an owned host and answers the previous state, booleans normalised', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
    assert.deepEqual(reply, {
        ok: true, verb: 'apply', ids: { proxyHost: 10, redirectionHost: 4 },
        previous: {
            proxy: {
                domain_names: ['spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: `${MARKER}\nold`,
            },
            redirection: {
                domain_names: ['www.spotondrones.com'], forward_domain_name: 'spotondrones.com', certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: `${MARKER}\n`,
            },
        },
    })
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update redirection-hosts 4'])
    assert.equal(npm.snapshot()['proxy-hosts'][0]!.forward_port, 5008)
})

test('a host edited by hand that still has the marker first is rewritten', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { hsts_enabled: 1, caching_enabled: 1, advanced_config: `${MARKER}\nhand edit` }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), false)
    assert.equal(reply.ok, true)
    const proxy = npm.snapshot()['proxy-hosts'][0]!
    assert.equal(proxy.hsts_enabled, false)
    assert.equal(proxy.caching_enabled, false)
    assert.equal(proxy.advanced_config, spec().proxy.advanced_config)
})

test('refuses an update when a domain is on a host other than the named ones', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(9, { advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'www.spotondrones.com is already on NPM redirection host 9' })
    assert.deepEqual(writes(npm), [])
})

test('refuses an update of a proxy host that no longer exists', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM proxy host 10 does not exist' })
    assert.deepEqual(writes(npm), [])
})

test('adopt may claim an unmarked host whose domains and upstream match', async () => {
    const { npm, deps } = setup()
    const before = proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: 'hand made', hsts_enabled: 1 })
    npm.seed('proxy-hosts', before)
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
    assert.equal(reply.ok, true)
    assert.deepEqual(reply, {
        ok: true, verb: 'apply', ids: { proxyHost: 10, redirectionHost: 100 },
        previous: {
            proxy: {
                domain_names: ['spotondrones.com', 'www.spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: 'hand made',
            },
            redirection: null,
        },
    })
    const state = npm.snapshot()
    assert.deepEqual(state['proxy-hosts'][0]!.domain_names, ['spotondrones.com'])
    assert.equal(state['proxy-hosts'][0]!.advanced_config.split('\n')[0], MARKER)
    assert.deepEqual(state['redirection-hosts'][0]!.domain_names, ['www.spotondrones.com'])
})

test('adopt refuses one whose upstream differs', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { forward_port: 5008, advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [], port: 5007 }), true)
    assert.equal(reply.ok, false)
    assert.match((reply as { problem: string }).problem, /NPM proxy host 10 forwards to 192\.168\.0\.8:5008, not 192\.168\.0\.8:5007/)
    assert.deepEqual(writes(npm), [])
})

test('adopt refuses a host on another upstream machine even if the spec names it', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { forward_host: '192.168.0.9', advanced_config: '' }))
    const wanted = spec({ aliases: [] })
    wanted.proxy.forward_host = '192.168.0.9'
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, wanted, true)
    assert.equal(reply.ok, false)
    assert.deepEqual(writes(npm), [])
})

test('adopt refuses a host that does not serve the primary', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['other.com'], advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
    assert.equal(reply.ok, false)
    assert.match((reply as { problem: string }).problem, /does not serve spotondrones\.com/)
    assert.deepEqual(writes(npm), [])
})

test('adopt refuses a host with custom locations or domains the spec would drop', async () => {
    for (const over of [
        { locations: [{ path: '/api', forward_host: '10.0.0.1' }] },
        { domain_names: ['spotondrones.com', 'shop.spotondrones.com'] },
    ]) {
        const { npm, deps } = setup()
        npm.seed('proxy-hosts', proxyRecord(10, { advanced_config: '', ...over }))
        const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
        assert.equal(reply.ok, false, JSON.stringify(over))
        assert.deepEqual(writes(npm), [])
    }
})

test('adopt never claims a host that another environment\'s marker owns', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { advanced_config: `${markerFor({ project: 'spotondrones', environment: 'staging' })}\n` }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
    assert.equal(reply.ok, false)
    assert.deepEqual(writes(npm), [])
})

test('adopt needs a host to take over and never falls back to a create', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, null, spec(), true)
    assert.equal(reply.ok, false)
    assert.deepEqual(writes(npm), [])
})

test('moves aliases from the proxy host to a new redirection host in that order', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'] }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.equal(reply.ok, true)
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'create redirection-hosts'])
})

test('deletes the redirection host after the proxy update when the aliases are gone', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ aliases: [] }), false)
    assert.equal(reply.ok, true)
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: null })
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'remove redirection-hosts 4'])
})

test('puts the previous state back when NPM reports nginx_online false', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const start = npm.snapshot()
    npm.breakNext('proxy-hosts', 'update', 'bad')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM refused the configuration for spotondrones live', output: 'bad' })
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update proxy-hosts 10'])
    assert.deepEqual(normalised(npm.snapshot()), normalised(start))
})

test('puts a hand-made host back as it was when the adopt write is refused by nginx', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: 'hand made', hsts_enabled: 1 }))
    const start = npm.snapshot()
    npm.breakNext('proxy-hosts', 'update', 'bad')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
    assert.equal(reply.ok, false)
    assert.deepEqual(normalised(npm.snapshot()), normalised(start))
})

test('undoes every earlier write when a later one is refused by nginx', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'] }))
    const start = npm.snapshot()
    npm.breakNext('redirection-hosts', 'create', 'bad redirect')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM refused the configuration for spotondrones live', output: 'bad redirect' })
    // The new redirection host is deleted, then the proxy gets its aliases back.
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'create redirection-hosts', 'remove redirection-hosts 100', 'update proxy-hosts 10'])
    assert.deepEqual(normalised(npm.snapshot()), normalised(start))
})

test('deletes a just-created host when nginx refuses it', async () => {
    const { npm, deps } = setup()
    npm.breakNext('proxy-hosts', 'create', 'bad')
    const reply = await applyHosts(deps, OWNER, null, spec(), false)
    assert.equal(reply.ok, false)
    assert.deepEqual(writes(npm), ['create proxy-hosts', 'remove proxy-hosts 100'])
    assert.deepEqual(npm.snapshot()['proxy-hosts'], [])
})

test('an NPM error mid-way undoes the earlier writes and is answered, not thrown', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'] }))
    const start = npm.snapshot()
    const create = npm.create.bind(npm)
    npm.create = async (kind, body) => {
        if (kind === 'redirection-hosts') throw new Error('NPM did not answer POST /nginx/redirection-hosts within 30 seconds')
        return await create(kind, body)
    }
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM did not answer POST /nginx/redirection-hosts within 30 seconds' })
    assert.deepEqual(normalised(npm.snapshot()), normalised(start))
})

test('refuses an unknown certificate id', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, null, spec({ certificate: 99 }), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM has no certificate 99' })
    assert.deepEqual(writes(npm), [])
})

test('certificate 0 (Flexible SSL) needs no lookup', async () => {
    const { npm, deps } = setup()
    const reply = await applyHosts(deps, OWNER, null, spec({ certificate: 0 }), false)
    assert.equal(reply.ok, true)
    assert.equal(npm.calls.includes('certificates'), false)
})

test('remove deletes the redirection host first, then the proxy host', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const reply = await removeHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 })
    assert.deepEqual(reply, { ok: true, verb: 'remove' })
    assert.deepEqual(writes(npm), ['remove redirection-hosts 4', 'remove proxy-hosts 10'])
})

test('remove refuses an unowned host and deletes nothing', async () => {
    for (const [proxy, redirection] of [['hand made', `${MARKER}\n`], [`${MARKER}\n`, 'hand made']]) {
        const { npm, deps } = setup()
        npm.seed('proxy-hosts', proxyRecord(10, { advanced_config: proxy }))
        npm.seed('redirection-hosts', redirectionRecord(4, { advanced_config: redirection }))
        const reply = await removeHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 })
        assert.equal(reply.ok, false)
        assert.deepEqual(writes(npm), [])
    }
})

test('remove skips a host that is already gone', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    const reply = await removeHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 })
    assert.deepEqual(reply, { ok: true, verb: 'remove' })
    assert.deepEqual(writes(npm), ['remove proxy-hosts 10'])
})

test('get answers the current hosts of an owned environment', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    const reply = await getHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null })
    assert.deepEqual(reply, {
        ok: true, verb: 'get', current: {
            proxy: {
                domain_names: ['spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: `${MARKER}\nold`,
            },
            redirection: null,
        },
    })
    assert.deepEqual(await getHosts(deps, OWNER, { proxyHost: 11, redirectionHost: null }), { ok: true, verb: 'get', current: null })
})

test('get refuses a host whose marker was deleted', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { advanced_config: 'hand edited' }))
    const reply = await getHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null })
    assert.equal(reply.ok, false)
})

test('find answers every kind of host carrying any of the domains', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10, { locations: [{ path: '/x' }] }))
    npm.seed('proxy-hosts', proxyRecord(11, { domain_names: ['unrelated.com'], advanced_config: '' }))
    npm.seed('redirection-hosts', redirectionRecord(4, { advanced_config: 'hand made' }))
    npm.seed('dead-hosts', { id: 2, domain_names: ['old.spotondrones.com'] })
    const reply = await findHosts(deps, ['spotondrones.com', 'WWW.SpotOnDrones.com', 'old.spotondrones.com'])
    assert.equal(reply.ok, true)
    const hosts = (reply as { hosts: unknown[] }).hosts
    assert.deepEqual(hosts, [
        {
            kind: 'proxy', id: 10, domain_names: ['spotondrones.com'], owner: OWNER, forward_host: UPSTREAM, forward_port: 5007, hasLocations: true,
            spec: {
                domain_names: ['spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: `${MARKER}\nold`,
            },
        },
        {
            kind: 'redirection', id: 4, domain_names: ['www.spotondrones.com'], owner: null, forward_host: null, forward_port: null, hasLocations: false,
            spec: {
                domain_names: ['www.spotondrones.com'], forward_domain_name: 'spotondrones.com', certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: 'hand made',
            },
        },
        { kind: 'dead', id: 2, domain_names: ['old.spotondrones.com'], owner: null, forward_host: null, forward_port: null, hasLocations: false, spec: null },
    ])
})

test('a failing NPM read is answered as a problem', async () => {
    const { npm, deps } = setup()
    npm.list = async () => { throw new Error('NPM answered GET /nginx/proxy-hosts with 500') }
    assert.deepEqual(await findHosts(deps, ['spotondrones.com']), { ok: false, problem: 'NPM answered GET /nginx/proxy-hosts with 500' })
})

// A revert writes booleans as booleans, where the seeded record had NPM's 0/1. Compare on meaning.
function normalised(state: ReturnType<FakeNpm['snapshot']>) {
    const out = structuredClone(state)
    for (const records of Object.values(out)) {
        for (const record of records) {
            for (const key of ['ssl_forced', 'http2_support', 'hsts_enabled', 'hsts_subdomains', 'caching_enabled', 'block_exploits', 'allow_websocket_upgrade', 'preserve_path']) {
                if (typeof record[key] === 'number') record[key] = record[key] === 1
            }
        }
    }
    return out
}
