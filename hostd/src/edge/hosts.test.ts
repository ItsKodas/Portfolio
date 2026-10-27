import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { markerFor, type HostsSpec, type Owner } from '../shared/edge-protocol.ts'
import { applyHosts, findHosts, getHosts, removeHosts, type HostsDeps } from './hosts.ts'
import { NpmClient, NpmError, type NpmFlavour } from './npm-client.ts'
import { FakeNpm, NPMPLUS_WRITABLE } from './testing/fake-npm.ts'

const OWNER: Owner = { project: 'spotondrones', environment: 'live' }
const MARKER = markerFor(OWNER)
const UPSTREAM = '192.168.0.8'
const BS = String.fromCharCode(92)
const BROTLI = `if ($http_content_encoding ~* "(^|,)${BS}s*br${BS}s*(,|$)") {
    return 415;
}`

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
            proxyFixed: { forward_scheme: 'http', block_exploits: true, allow_websocket_upgrade: true, hsts_enabled: false, hsts_subdomains: false, caching_enabled: false },
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
    const before = proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: '', hsts_enabled: 1 })
    npm.seed('proxy-hosts', before)
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
    assert.equal(reply.ok, true)
    assert.deepEqual(reply, {
        ok: true, verb: 'apply', ids: { proxyHost: 10, redirectionHost: 100 },
        previous: {
            proxy: {
                domain_names: ['spotondrones.com', 'www.spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: '',
            },
            redirection: null,
            // The hand-made host's own choices, so the adoption undo can put them back
            proxyFixed: { forward_scheme: 'http', block_exploits: true, allow_websocket_upgrade: true, hsts_enabled: true, hsts_subdomains: false, caching_enabled: false },
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
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: BROTLI, hsts_enabled: 1 }))
    const start = npm.snapshot()
    npm.breakNext('proxy-hosts', 'update', 'bad')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
    assert.equal(reply.ok, false)
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update proxy-hosts 10'])
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
        if (kind === 'redirection-hosts') throw new NpmError('NPM answered POST /nginx/redirection-hosts with 400', 400)
        return await create(kind, body)
    }
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM answered POST /nginx/redirection-hosts with 400' })
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

// The adoption undo's spec: the hand-made proxy host as it was, aliases included, no marker.
function handMade(): HostsSpec {
    return {
        proxy: {
            domain_names: ['spotondrones.com', 'www.spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
            ssl_forced: true, http2_support: true, advanced_config: BROTLI,
        },
        redirection: null,
    }
}

test('restore puts the hand-made host back and deletes the redirection host', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, handMade(), false)
    assert.equal(reply.ok, true)
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: null })
    // The redirection host lets go of www first, or NPM would refuse the proxy update.
    assert.deepEqual(writes(npm), ['remove redirection-hosts 4', 'update proxy-hosts 10'])
    const state = npm.snapshot()
    assert.deepEqual(state['proxy-hosts'][0]!.domain_names, ['spotondrones.com', 'www.spotondrones.com'])
    assert.equal(state['proxy-hosts'][0]!.advanced_config, BROTLI)
    assert.deepEqual(state['redirection-hosts'], [])
})

test('a failed restore recreates the redirection host and names its new id', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    npm.breakNext('proxy-hosts', 'update', 'bad')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, handMade(), false)
    assert.deepEqual(reply, {
        ok: false, output: 'bad',
        problem: 'NPM refused the configuration for spotondrones live. NPM redirection host 4 was put back as NPM redirection host 100',
    })
    const state = normalised(npm.snapshot())
    assert.deepEqual(state['proxy-hosts'], normalised({ 'proxy-hosts': [proxyRecord(10, { meta: { nginx_online: true, nginx_err: null } })], 'redirection-hosts': [], 'dead-hosts': [] } as never)['proxy-hosts'])
    assert.deepEqual(state['redirection-hosts'].map(record => [record.id, record.domain_names, record.advanced_config]), [[100, ['www.spotondrones.com'], `${MARKER}\n`]])
})

// The release write puts back the fixed fields the hand-made host had, not hostd's own.
test('restore with restoreFixed writes the hand-made host\'s own fixed fields back', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const fixed = { forward_scheme: 'http', block_exploits: false, allow_websocket_upgrade: false, hsts_enabled: true, hsts_subdomains: true, caching_enabled: true } as const
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, handMade(), false, fixed)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    const proxy = npm.snapshot()['proxy-hosts'][0]!
    for (const [key, value] of Object.entries(fixed)) assert.equal(proxy[key], value, key)
})

test('restoreFixed is refused on anything but a release of an owned host', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    const fixed = { forward_scheme: 'http', block_exploits: false, allow_websocket_upgrade: true, hsts_enabled: false, hsts_subdomains: false, caching_enabled: false } as const
    // A normal render (it carries the marker) always gets hostd's own fixed fields
    const render = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), false, fixed)
    assert.equal(render.ok, false)
    const create = await applyHosts(deps, OWNER, null, handMade(), false, fixed)
    assert.equal(create.ok, false)
    const adopting = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, handMade(), true, fixed)
    assert.equal(adopting.ok, false)
    assert.deepEqual(writes(npm), [])
})

// A redirection host carrying this owner's marker that the registry's id no longer names (a lost
// reply on the delete-then-create path, edge's own undo recreating it under a new id, recordIds
// failing) is provably this environment's, so it is taken as the redirection record.
test('a stale redirection id adopts the orphan carrying this owner\'s marker, and answers its id', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(7))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: 7 })
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update redirection-hosts 7'])
    assert.equal(npm.snapshot()['redirection-hosts'].length, 1)
})

test('a null redirection id adopts the orphan carrying this owner\'s marker', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(7))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: 7 })
})

test('an orphan with this owner\'s marker is deleted when the environment has no aliases now', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(7))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ aliases: [] }), false)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: null })
    assert.deepEqual(npm.snapshot()['redirection-hosts'], [])
})

test('an orphan redirection host without this owner\'s exact marker is still a clash', async () => {
    for (const advanced_config of ['', `${markerFor({ project: 'spotondrones', environment: 'redesign' })}\n`, `# note\n${MARKER}\n`]) {
        const { npm, deps } = setup()
        npm.seed('proxy-hosts', proxyRecord(10))
        npm.seed('redirection-hosts', redirectionRecord(7, { advanced_config }))
        const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec(), false)
        assert.deepEqual(reply, { ok: false, problem: 'www.spotondrones.com is already on NPM redirection host 7' }, advanced_config)
        assert.deepEqual(writes(npm), [])
    }
})

test('a redirection id that still exists is used, never a second marked host', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    npm.seed('redirection-hosts', redirectionRecord(7, { domain_names: ['old.spotondrones.com'] }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec(), false)
    assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: 4 })
    assert.ok(writes(npm).every(call => !call.endsWith(' 7')))
})

test('a redirection host that keeps some aliases is trimmed before the proxy takes the rest', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4, { domain_names: ['www.spotondrones.com', 'shop.spotondrones.com'] }))
    const wanted = spec({ aliases: ['shop.spotondrones.com'] })
    wanted.proxy.domain_names = ['spotondrones.com', 'www.spotondrones.com']
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, wanted, false)
    assert.equal(reply.ok, true)
    assert.deepEqual(writes(npm), ['update redirection-hosts 4', 'update proxy-hosts 10'])
    assert.deepEqual(npm.snapshot()['redirection-hosts'][0]!.domain_names, ['shop.spotondrones.com'])
})

test('refuses a spec that puts one domain on both hosts', async () => {
    const { npm, deps } = setup()
    const wanted = spec()
    wanted.proxy.domain_names = ['spotondrones.com', 'www.spotondrones.com']
    const reply = await applyHosts(deps, OWNER, null, wanted, false)
    assert.deepEqual(reply, { ok: false, problem: 'www.spotondrones.com is on both the proxy host and the redirection host' })
    assert.deepEqual(writes(npm), [])
})

test('refuses a spec that forwards anywhere but the upstream host', async () => {
    const elsewhere = '192.168.0.9'
    const problem = `hostd only forwards to ${UPSTREAM}; refusing a proxy host that forwards to ${elsewhere}`
    const created = setup()
    const wanted = spec()
    wanted.proxy.forward_host = elsewhere
    assert.deepEqual(await applyHosts(created.deps, OWNER, null, wanted, false), { ok: false, problem })
    assert.deepEqual(created.npm.calls, [])

    const updated = setup()
    updated.npm.seed('proxy-hosts', proxyRecord(10))
    const edit = spec({ aliases: [] })
    edit.proxy.forward_host = elsewhere
    assert.deepEqual(await applyHosts(updated.deps, OWNER, { proxyHost: 10, redirectionHost: null }, edit, false), { ok: false, problem })
    assert.deepEqual(writes(updated.npm), [])
})

test('an unmarked spec is refused on a create and on an adopt', async () => {
    const { npm, deps } = setup()
    assert.equal((await applyHosts(deps, OWNER, null, handMade(), false)).ok, false)
    npm.seed('proxy-hosts', proxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: '' }))
    assert.equal((await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, handMade(), true)).ok, false)
    assert.deepEqual(writes(npm), [])
})

test('an update NPM stored but never answered is undone', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(10))
    npm.seed('redirection-hosts', redirectionRecord(4))
    const start = npm.snapshot()
    npm.loseReplyNext('proxy-hosts', 'update')
    const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
    assert.deepEqual(reply, { ok: false, problem: 'NPM did not answer PUT /nginx/proxy-hosts within 30 seconds' })
    assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update proxy-hosts 10'])
    assert.deepEqual(normalised(npm.snapshot()), normalised(start))
})

test('a create NPM may have stored but never answered says to check NPM', async () => {
    const { npm, deps } = setup()
    npm.loseReplyNext('redirection-hosts', 'create')
    const reply = await applyHosts(deps, OWNER, null, spec(), false)
    assert.deepEqual(reply, {
        ok: false,
        problem: 'NPM did not answer POST /nginx/redirection-hosts within 30 seconds; NPM may have created the redirection host anyway, so check NPM for it',
    })
    // The proxy host this call did create is still undone.
    assert.deepEqual(npm.snapshot()['proxy-hosts'], [])
})

test('adopt refuses a host with an access list', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(9, { access_list_id: 1, advanced_config: '' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 9, redirectionHost: null }, spec({ aliases: [] }), true)
    assert.equal(reply.ok, false)
    assert.match((reply as { problem: string }).problem, /^NPM proxy host 9 has access list 1; remove it in NPM or /)
    assert.deepEqual(writes(npm), [])
})

test('adopt refuses a host with custom nginx directives, on either host', async () => {
    for (const config of ['proxy_read_timeout 600;', `${BROTLI}\nclient_max_body_size 1g;`, `\n  # tuned by hand\n${BROTLI}`]) {
        const { npm, deps } = setup()
        npm.seed('proxy-hosts', proxyRecord(9, { advanced_config: config }))
        const reply = await applyHosts(deps, OWNER, { proxyHost: 9, redirectionHost: null }, spec({ aliases: [] }), true)
        assert.equal(reply.ok, false, config)
        assert.match((reply as { problem: string }).problem, /^NPM proxy host 9 has custom nginx directives: /, config)
        assert.deepEqual(writes(npm), [])
    }
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(9, { advanced_config: '' }))
    npm.seed('redirection-hosts', redirectionRecord(4, { advanced_config: 'return 410;' }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 9, redirectionHost: 4 }, spec(), true)
    assert.deepEqual(reply, { ok: false, problem: 'NPM redirection host 4 has custom nginx directives: return 410; (move them out in NPM or leave this host to be managed by hand)' })
    assert.deepEqual(writes(npm), [])
})

test('adopt accepts a host whose only directive is the brotli snippet', async () => {
    const { npm, deps } = setup()
    npm.seed('proxy-hosts', proxyRecord(9, { advanced_config: `\n${BROTLI}\r\n  ` }))
    const reply = await applyHosts(deps, OWNER, { proxyHost: 9, redirectionHost: null }, spec({ aliases: [] }), true)
    assert.equal(reply.ok, true)
    assert.deepEqual(writes(npm), ['update proxy-hosts 9'])
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

// The guard tests again, under both flavours, each through a real NpmClient talking HTTP to the fake:
// NPMplus's fake refuses any key its schema does not allow, keeps what a PUT leaves out, wants the
// session cookie and reports nginx's state at the top level. The npm run shows the shared logic did not
// move; the npmplus run shows it holds there too.
const FLAVOURS: NpmFlavour[] = ['npm', 'npmplus']

function setupFor(flavour: NpmFlavour): { npm: FakeNpm, deps: HostsDeps } {
    const npm = new FakeNpm({ flavour })
    npm.certificates = [16]
    const url = flavour === 'npmplus' ? 'https://npmplus.test:81/api' : 'http://npm.test:81/api'
    const client = new NpmClient({ url, identity: 'hostd@x.test', secret: 'pw', flavour, fetch: npm.fetch })
    return { npm, deps: { npm: client, upstreamHost: UPSTREAM, flavour } }
}

// A proxy host as NPMplus returns it: no fixed NPM fields, its own features, booleans as booleans.
function plusProxyRecord(id: number, over: Record<string, unknown> = {}) {
    return {
        id, domain_names: ['spotondrones.com'], forward_scheme: 'http', forward_host: UPSTREAM, forward_port: 5007,
        certificate_id: 16, ssl_forced: true, hsts_enabled: false, hsts_subdomains: false, npmplus_http3_support: false,
        npmplus_access_list_ids: [], access_lists: [], npmplus_access_list_type: 'any', npmplus_noindex: false, npmplus_crowdsec_appsec: true,
        npmplus_x_frame_options: 'SAMEORIGIN', npmplus_auth_request: 'none', npmplus_auth_request_upstream: '', npmplus_location_config: '',
        locations: [], enabled: true, advanced_config: `${MARKER}\nold`, ...over,
    }
}

function plusRedirectionRecord(id: number, over: Record<string, unknown> = {}) {
    return {
        id, domain_names: ['www.spotondrones.com'], forward_scheme: 'https', forward_domain_name: 'spotondrones.com',
        forward_http_code: 301, preserve_path: true, certificate_id: 16, ssl_forced: true, hsts_enabled: false,
        hsts_subdomains: false, npmplus_http3_support: false, enabled: true, advanced_config: `${MARKER}\n`, ...over,
    }
}

function recordsFor(flavour: NpmFlavour) {
    return flavour === 'npmplus' ? { proxy: plusProxyRecord, redirection: plusRedirectionRecord } : { proxy: proxyRecord, redirection: redirectionRecord }
}

const PROXY_MANAGED = ['advanced_config', 'certificate_id', 'domain_names', 'forward_host', 'forward_port', 'forward_scheme', 'ssl_forced']
const REDIRECTION_MANAGED = ['advanced_config', 'certificate_id', 'domain_names', 'forward_domain_name', 'forward_http_code', 'forward_scheme', 'preserve_path', 'ssl_forced']
const NEVER_ON_NPMPLUS = ['block_exploits', 'caching_enabled', 'allow_websocket_upgrade', 'http2_support', 'access_list_id', 'meta']

// Nothing edge sent was refused, nor would it have been: every key is one NPMplus allows.
function assertOnlyAllowedKeys(npm: FakeNpm): void {
    assert.deepEqual(npm.refusedRequests, [])
    for (const { call, body } of npm.sent) {
        const kind = call.split(' ')[1] as keyof typeof NPMPLUS_WRITABLE
        for (const key of Object.keys(body)) {
            assert.ok(NPMPLUS_WRITABLE[kind]!.includes(key), `${call} sent ${key}`)
            assert.equal(NEVER_ON_NPMPLUS.includes(key), false, `${call} sent ${key}`)
        }
    }
}

for (const flavour of FLAVOURS) {
    describe(`on ${flavour}`, () => {
        const records = recordsFor(flavour)
        const afterEach = (npm: FakeNpm) => { if (flavour === 'npmplus') assertOnlyAllowedKeys(npm) }

        test('creates a proxy and a redirection host and answers their ids', async () => {
            const { npm, deps } = setupFor(flavour)
            const reply = await applyHosts(deps, OWNER, null, spec(), false)
            assert.deepEqual(reply, { ok: true, verb: 'apply', ids: { proxyHost: 100, redirectionHost: 101 }, previous: null })
            assert.deepEqual(writes(npm), ['create proxy-hosts', 'create redirection-hosts'])
            const state = npm.snapshot()
            const proxy = state['proxy-hosts'][0]!
            assert.deepEqual([proxy.forward_scheme, proxy.forward_host, proxy.forward_port], ['http', UPSTREAM, 5007])
            assert.equal(proxy.advanced_config.split('\n')[0], MARKER)
            const redirection = state['redirection-hosts'][0]!
            assert.deepEqual([redirection.forward_scheme, redirection.forward_http_code, redirection.preserve_path], ['https', 301, true])
            afterEach(npm)
        })

        test('refuses to update a host without this owner\'s marker', async () => {
            const cases = ['hand made', `${markerFor({ project: 'spotondrones', environment: 'staging' })}\n`, `${markerFor({ project: 'pmpcold', environment: 'live' })}\n`, `# hand made\n${MARKER}`]
            for (const config of cases) {
                const { npm, deps } = setupFor(flavour)
                npm.seed('proxy-hosts', records.proxy(10, { advanced_config: config }))
                const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), false)
                assert.match((reply as { problem: string }).problem, /NPM proxy host 10 does not carry the marker for spotondrones\/live/, config)
                assert.deepEqual(writes(npm), [], config)
            }
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10))
            npm.seed('redirection-hosts', records.redirection(4, { advanced_config: '' }))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec(), false)
            assert.match((reply as { problem: string }).problem, /NPM redirection host 4 does not carry the marker/)
            assert.deepEqual(writes(npm), [])
        })

        test('adopt claims an unmarked host whose domains and upstream match', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: BROTLI }))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
            assert.equal(reply.ok, true, JSON.stringify(reply))
            const { ids, previous } = reply as { ids: unknown, previous: { proxy: unknown } }
            assert.deepEqual(ids, { proxyHost: 10, redirectionHost: 100 })
            assert.deepEqual(previous.proxy, {
                domain_names: ['spotondrones.com', 'www.spotondrones.com'], forward_host: UPSTREAM, forward_port: 5007, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: BROTLI,
            })
            const state = npm.snapshot()
            assert.deepEqual(state['proxy-hosts'][0]!.domain_names, ['spotondrones.com'])
            assert.equal(state['proxy-hosts'][0]!.advanced_config.split('\n')[0], MARKER)
            assert.deepEqual(state['redirection-hosts'][0]!.domain_names, ['www.spotondrones.com'])
            // The proxy gives the alias up before the redirection host takes it.
            assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'create redirection-hosts'])
            afterEach(npm)
        })

        test('adopt refuses what it cannot take over safely', async () => {
            const refusals: [Record<string, unknown>, RegExp][] = [
                [{ forward_port: 5008 }, /forwards to 192\.168\.0\.8:5008, not 192\.168\.0\.8:5007/],
                [{ domain_names: ['other.com'] }, /does not serve spotondrones\.com/],
                [{ locations: [{ path: '/api', forward_host: '10.0.0.1' }] }, /has custom locations/],
                [{ domain_names: ['spotondrones.com', 'shop.spotondrones.com'] }, /also serves shop\.spotondrones\.com/],
                [{ advanced_config: `${markerFor({ project: 'spotondrones', environment: 'staging' })}\n` }, /does not carry the marker/],
                [{ advanced_config: `${BROTLI}\nclient_max_body_size 1g;` }, /^NPM proxy host 10 has custom nginx directives: /],
            ]
            for (const [over, problem] of refusals) {
                const { npm, deps } = setupFor(flavour)
                npm.seed('proxy-hosts', records.proxy(10, { advanced_config: '', ...over }))
                const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
                assert.equal(reply.ok, false, JSON.stringify(over))
                assert.match((reply as { problem: string }).problem, problem, JSON.stringify(over))
                assert.deepEqual(writes(npm), [], JSON.stringify(over))
            }
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(9, { advanced_config: '' }))
            npm.seed('redirection-hosts', records.redirection(4, { advanced_config: 'return 410;' }))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 9, redirectionHost: 4 }, spec(), true)
            assert.match((reply as { problem: string }).problem, /^NPM redirection host 4 has custom nginx directives: return 410;/)
            assert.equal((await applyHosts(deps, OWNER, null, spec(), true)).ok, false)
            assert.deepEqual(writes(npm), [])
        })

        test('puts the previous state back when nginx refuses the write', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10))
            npm.seed('redirection-hosts', records.redirection(4))
            const start = npm.snapshot()
            npm.breakNext('proxy-hosts', 'update', 'bad')
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
            assert.deepEqual(reply, { ok: false, problem: 'NPM refused the configuration for spotondrones live', output: 'bad' })
            assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update proxy-hosts 10'])
            assert.deepEqual(normalised(npm.snapshot()), normalised(start))
            afterEach(npm)
        })

        test('undoes every earlier write when a later one is refused by nginx', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'] }))
            const start = npm.snapshot()
            npm.breakNext('redirection-hosts', 'create', 'bad redirect')
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), false)
            assert.deepEqual(reply, { ok: false, problem: 'NPM refused the configuration for spotondrones live', output: 'bad redirect' })
            assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'create redirection-hosts', 'remove redirection-hosts 100', 'update proxy-hosts 10'])
            assert.deepEqual(normalised(npm.snapshot()), normalised(start))
            afterEach(npm)
        })

        test('the release puts the hand-made host back, the redirection host letting go first', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10))
            npm.seed('redirection-hosts', records.redirection(4))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, handMade(), false)
            assert.equal(reply.ok, true, JSON.stringify(reply))
            assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: null })
            assert.deepEqual(writes(npm), ['remove redirection-hosts 4', 'update proxy-hosts 10'])
            const state = npm.snapshot()
            assert.deepEqual(state['proxy-hosts'][0]!.domain_names, ['spotondrones.com', 'www.spotondrones.com'])
            assert.equal(state['proxy-hosts'][0]!.advanced_config, BROTLI)
            assert.deepEqual(state['redirection-hosts'], [])
            afterEach(npm)
        })

        test('a redirection host that keeps some aliases is trimmed before the proxy takes the rest', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10))
            npm.seed('redirection-hosts', records.redirection(4, { domain_names: ['www.spotondrones.com', 'shop.spotondrones.com'] }))
            const wanted = spec({ aliases: ['shop.spotondrones.com'] })
            wanted.proxy.domain_names = ['spotondrones.com', 'www.spotondrones.com']
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, wanted, false)
            assert.equal(reply.ok, true, JSON.stringify(reply))
            assert.deepEqual(writes(npm), ['update redirection-hosts 4', 'update proxy-hosts 10'])
            afterEach(npm)
        })

        test('a stale redirection id takes the orphan carrying this owner\'s marker, and answers its id', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(10))
            npm.seed('redirection-hosts', records.redirection(7))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
            assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 10, redirectionHost: 7 })
            assert.deepEqual(writes(npm), ['update proxy-hosts 10', 'update redirection-hosts 7'])
            afterEach(npm)
        })

        // A migration (NPM to NPMplus, say) that gave the hosts new ids: the one carrying this owner's
        // exact marker on its first line is provably this environment's, so it is taken and its id answered.
        test('a stale proxy id takes the proxy host carrying this owner\'s marker, and answers its id', async () => {
            const { npm, deps } = setupFor(flavour)
            npm.seed('proxy-hosts', records.proxy(31))
            npm.seed('redirection-hosts', records.redirection(32))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, spec({ port: 5008 }), false)
            assert.equal(reply.ok, true, JSON.stringify(reply))
            assert.deepEqual((reply as { ids: unknown }).ids, { proxyHost: 31, redirectionHost: 32 })
            assert.deepEqual(writes(npm), ['update proxy-hosts 31', 'update redirection-hosts 32'])
            assert.equal(npm.snapshot()['proxy-hosts'][0]!.forward_port, 5008)
            afterEach(npm)
        })

        test('a stale proxy id never takes a host without this owner\'s exact marker', async () => {
            const configs = ['', BROTLI, `${markerFor({ project: 'spotondrones', environment: 'staging' })}\n`, `# note\n${MARKER}\n`, ` ${MARKER}\n`]
            for (const advanced_config of configs) {
                const { npm, deps } = setupFor(flavour)
                npm.seed('proxy-hosts', records.proxy(31, { advanced_config }))
                const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), false)
                assert.deepEqual(reply, { ok: false, problem: 'NPM proxy host 10 does not exist' }, advanced_config)
                assert.deepEqual(writes(npm), [], advanced_config)
                // Not under adopt either: adopt takes over the host it was given, never one found by marker hunting.
                const adopting = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
                assert.equal(adopting.ok, false, advanced_config)
                assert.deepEqual(writes(npm), [], advanced_config)
            }
        })

        test('remove refuses an unowned host and deletes nothing', async () => {
            for (const [proxy, redirection] of [['hand made', `${MARKER}\n`], [`${MARKER}\n`, 'hand made']]) {
                const { npm, deps } = setupFor(flavour)
                npm.seed('proxy-hosts', records.proxy(10, { advanced_config: proxy }))
                npm.seed('redirection-hosts', records.redirection(4, { advanced_config: redirection }))
                const reply = await removeHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 })
                assert.equal(reply.ok, false)
                assert.deepEqual(writes(npm), [])
            }
        })
    })
}

describe('npmplus only', () => {
    function plus() {
        return setupFor('npmplus')
    }
    function bodyOf(npm: FakeNpm, call: string, nth = 0): Record<string, unknown> {
        return npm.sent.filter(entry => entry.call === call)[nth]!.body
    }

    test('writes carry only the managed fields, with hostd\'s values for the fixed ones', async () => {
        const { npm, deps } = plus()
        assert.equal((await applyHosts(deps, OWNER, null, spec(), false)).ok, true)
        const proxy = bodyOf(npm, 'create proxy-hosts')
        assert.deepEqual(Object.keys(proxy).sort(), PROXY_MANAGED)
        assert.equal(proxy.forward_scheme, 'http')
        const redirection = bodyOf(npm, 'create redirection-hosts')
        assert.deepEqual(Object.keys(redirection).sort(), REDIRECTION_MANAGED)
        assert.deepEqual([redirection.forward_scheme, redirection.forward_http_code, redirection.preserve_path], ['https', 301, true])
        // A host hostd creates gets NPMplus's own defaults for everything else.
        assert.equal(npm.snapshot()['proxy-hosts'][0]!.npmplus_crowdsec_appsec, true)
        assertOnlyAllowedKeys(npm)
    })

    test('hand-set NPMplus features survive adopt, a later write and the release', async () => {
        const { npm, deps } = plus()
        const hand = {
            npmplus_crowdsec_appsec: false, npmplus_access_list_ids: [3], access_lists: [{ id: 3, name: 'office' }], npmplus_noindex: true,
            npmplus_http3_support: true, hsts_enabled: true, npmplus_x_frame_options: 'DENY',
        }
        npm.seed('proxy-hosts', plusProxyRecord(10, { domain_names: ['spotondrones.com', 'www.spotondrones.com'], advanced_config: BROTLI, ...hand }))
        const kept = () => {
            const proxy = npm.snapshot()['proxy-hosts'].find(record => record.id === 10)!
            for (const [key, value] of Object.entries(hand)) assert.deepEqual(proxy[key], value, key)
        }
        // An access list no longer stops an adopt: nothing edge sends can drop it.
        const adopted = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec(), true)
        assert.equal(adopted.ok, true, JSON.stringify(adopted))
        assert.equal((adopted as { previous: { proxyFixed: unknown } }).previous.proxyFixed, null)
        kept()
        const ids = (adopted as { ids: { proxyHost: number, redirectionHost: number } }).ids
        assert.equal((await applyHosts(deps, OWNER, ids, spec({ port: 5008 }), false)).ok, true)
        kept()
        // The release, with a restoreFixed the agent kept from a stock NPM adopt: there is nothing fixed
        // on NPMplus to put back, so it is ignored and the hand-set values stay.
        const fixed = { forward_scheme: 'http', block_exploits: false, allow_websocket_upgrade: false, hsts_enabled: false, hsts_subdomains: false, caching_enabled: true } as const
        const released = await applyHosts(deps, OWNER, ids, handMade(), false, fixed)
        assert.equal(released.ok, true, JSON.stringify(released))
        kept()
        const proxy = npm.snapshot()['proxy-hosts'][0]!
        assert.deepEqual([proxy.domain_names, proxy.advanced_config, proxy.forward_port], [['spotondrones.com', 'www.spotondrones.com'], BROTLI, 5007])
        assertOnlyAllowedKeys(npm)
    })

    test('a failed write is put back with the managed fields only, leaving the rest alone', async () => {
        const { npm, deps } = plus()
        npm.seed('proxy-hosts', plusProxyRecord(10, { npmplus_crowdsec_appsec: false, forward_scheme: 'http' }))
        npm.breakNext('proxy-hosts', 'update', 'bad')
        const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [], port: 5008 }), false)
        assert.equal(reply.ok, false)
        assert.deepEqual(Object.keys(bodyOf(npm, 'update proxy-hosts 10', 1)).sort(), PROXY_MANAGED)
        const proxy = npm.snapshot()['proxy-hosts'][0]!
        assert.deepEqual([proxy.forward_port, proxy.npmplus_crowdsec_appsec, proxy.npmplus_nginx_online], [5007, false, true])
        assertOnlyAllowedKeys(npm)
    })

    test('adopt refuses what sits in front of hostd\'s verification, naming it', async () => {
        const refusals: [Record<string, unknown>, RegExp][] = [
            [{ npmplus_auth_request: 'authelia' }, /^NPM proxy host 10 puts authelia auth in front of every request/],
            [{ npmplus_location_config: 'location /admin {\n    deny all;\n}' }, /^NPM proxy host 10 has custom location config: location \/admin \{/],
            [{ forward_scheme: 'https' }, /^NPM proxy host 10 forwards over https/],
        ]
        for (const [over, problem] of refusals) {
            const { npm, deps } = plus()
            npm.seed('proxy-hosts', plusProxyRecord(10, { advanced_config: '', ...over }))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
            assert.equal(reply.ok, false, JSON.stringify(over))
            assert.match((reply as { problem: string }).problem, problem)
            assert.deepEqual(writes(npm), [])
        }
        for (const auth of ['none', '']) {
            const { npm, deps } = plus()
            npm.seed('proxy-hosts', plusProxyRecord(10, { advanced_config: '', npmplus_auth_request: auth, npmplus_location_config: '  \n' }))
            const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: null }, spec({ aliases: [] }), true)
            assert.equal(reply.ok, true, `${auth}: ${JSON.stringify(reply)}`)
        }
    })

    test('an owned host reads back with HTTP/2 on whenever it has a certificate, as NPMplus serves it', async () => {
        const { npm, deps } = plus()
        npm.seed('proxy-hosts', plusProxyRecord(10))
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
        npm.seed('proxy-hosts', plusProxyRecord(11, { certificate_id: 0, ssl_forced: false }))
        const flexible = await getHosts(deps, OWNER, { proxyHost: 11, redirectionHost: null })
        assert.equal((flexible as { current: { proxy: { http2_support: boolean } } }).current.proxy.http2_support, false)
    })

    test('a redirection host recreated by an undo keeps its NPMplus settings', async () => {
        const { npm, deps } = plus()
        npm.seed('proxy-hosts', plusProxyRecord(10))
        npm.seed('redirection-hosts', plusRedirectionRecord(4, { npmplus_http3_support: true, hsts_enabled: true }))
        npm.breakNext('proxy-hosts', 'update', 'bad')
        const reply = await applyHosts(deps, OWNER, { proxyHost: 10, redirectionHost: 4 }, handMade(), false)
        assert.equal(reply.ok, false)
        const back = npm.snapshot()['redirection-hosts'][0]!
        assert.deepEqual([back.id, back.domain_names, back.npmplus_http3_support, back.hsts_enabled], [100, ['www.spotondrones.com'], true, true])
        assertOnlyAllowedKeys(npm)
    })
})
