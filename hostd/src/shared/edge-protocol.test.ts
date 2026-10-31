import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markerFor, ownerOf, parseEdgeReply, parseEdgeRequest, type EdgeReply, type EdgeRequest, type HostsSpec } from './edge-protocol.ts'

const owner = { project: 'spotondrones', environment: 'live' }
const proxy = {
    domain_names: ['spotondrones.com'], forward_host: '192.168.0.8', forward_port: 8080, certificate_id: 3,
    ssl_forced: true, http2_support: true, advanced_config: markerFor(owner),
}
const redirection = {
    domain_names: ['www.spotondrones.com'], forward_domain_name: 'spotondrones.com', certificate_id: 3,
    ssl_forced: true, http2_support: true, advanced_config: markerFor(owner),
}
const spec: HostsSpec = { proxy, redirection }
const ids = { proxyHost: 4, redirectionHost: null }
const proxyFixed = { forward_scheme: 'http', block_exploits: false, allow_websocket_upgrade: true, hsts_enabled: true, hsts_subdomains: false, caching_enabled: false } as const

describe('markerFor and ownerOf', () => {
    it('writes the exact marker line', () => {
        assert.equal(markerFor(owner), '# hostd: spotondrones/live. Managed by hostd; edits here are overwritten.')
    })

    it('reads the owner back from the first line only', () => {
        assert.deepEqual(ownerOf(`${markerFor(owner)}\nlocation / {}`), owner)
        assert.equal(ownerOf(`# other\n${markerFor(owner)}`), null)
        assert.equal(ownerOf(''), null)
    })

    it('rejects ids and environments the registry would reject', () => {
        assert.equal(ownerOf('# hostd: A/live. Managed by hostd; edits here are overwritten.'), null)
        assert.equal(ownerOf('# hostd: spotondrones/. Managed by hostd; edits here are overwritten.'), null)
        assert.equal(ownerOf('# hostd: spotondrones/live. Managed by someone else.'), null)
    })
})

describe('parseEdgeRequest', () => {
    const requests: EdgeRequest[] = [
        { verb: 'health' },
        { verb: 'certificates' },
        { verb: 'find', domains: ['a.com'] },
        { verb: 'get', owner, ids },
        { verb: 'apply', owner, ids: null, spec, adopt: false },
        { verb: 'apply', owner, ids, spec: { proxy, redirection: null }, adopt: true },
        { verb: 'apply', owner, ids, spec: { proxy, redirection: null }, adopt: false, restoreFixed: proxyFixed },
        { verb: 'remove', owner, ids: { proxyHost: 1, redirectionHost: 2 } },
    ]
    for (const request of requests) {
        it(`round-trips ${request.verb}`, () => {
            assert.deepEqual(parseEdgeRequest(JSON.parse(JSON.stringify(request))), request)
        })
    }

    it('refuses what is malformed', () => {
        assert.equal(parseEdgeRequest(null), null)
        assert.equal(parseEdgeRequest({ verb: 'nope' }), null)
        assert.equal(parseEdgeRequest({ verb: 'health', extra: 1 }), null)
        assert.equal(parseEdgeRequest({ verb: 'find' }), null)
        assert.equal(parseEdgeRequest({ verb: 'get', owner }), null)
        assert.equal(parseEdgeRequest({ verb: 'get', owner: { project: 'A', environment: 'live' }, ids }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec, adopt: 'yes' }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec: { proxy: { ...proxy, forward_port: 80.5 }, redirection: null }, adopt: false }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec: { proxy: { ...proxy, domain_names: 'a.com' }, redirection: null }, adopt: false }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec: { proxy: { ...proxy, domain_names: [1] }, redirection: null }, adopt: false }), null)
        assert.equal(parseEdgeRequest({ verb: 'remove', owner, ids: { proxyHost: 1.5, redirectionHost: null } }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids, spec, adopt: false, restoreFixed: { ...proxyFixed, block_exploits: 0 } }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids, spec, adopt: false, restoreFixed: { ...proxyFixed, forward_scheme: 'ftp' } }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids, spec, adopt: false, restoreFixed: { ...proxyFixed, extra: true } }), null)
    })
})

describe('parseEdgeReply', () => {
    const replies: EdgeReply[] = [
        { ok: true, verb: 'health', npmAge: null },
        { ok: true, verb: 'health', npmAge: 12 },
        { ok: true, verb: 'certificates', ids: [1, 2] },
        { ok: true, verb: 'find', hosts: [
            { kind: 'proxy', id: 4, domain_names: ['a.com'], owner, forward_host: '192.168.0.8', forward_port: 8080, hasLocations: false, spec: proxy },
            { kind: 'dead', id: 5, domain_names: ['b.com'], owner: null, forward_host: null, forward_port: null, hasLocations: true, spec: null },
        ] },
        { ok: true, verb: 'get', current: null },
        { ok: true, verb: 'get', current: spec },
        { ok: true, verb: 'apply', ids, previous: null },
        { ok: true, verb: 'apply', ids, previous: { ...spec, proxyFixed } },
        { ok: true, verb: 'apply', ids, previous: { ...spec, proxyFixed: null } },
        { ok: true, verb: 'remove' },
        { ok: false, problem: 'bad' },
        { ok: false, problem: 'bad', output: 'details' },
    ]
    for (const reply of replies) {
        it(`round-trips ${JSON.stringify(reply).slice(0, 50)}`, () => {
            assert.deepEqual(parseEdgeReply(JSON.parse(JSON.stringify(reply))), reply)
        })
    }

    it('refuses what is malformed', () => {
        assert.equal(parseEdgeReply(null), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'nope' }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'certificates', ids: ['1'] }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'health', npmAge: 'x' }), null)
        assert.equal(parseEdgeReply({ ok: false }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'find', hosts: [{ kind: 'weird' }] }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'get', current: { proxy: { ...proxy, forward_port: 1.5 }, redirection: null } }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'apply', ids, previous: { ...spec, proxyFixed: { ...proxyFixed, hsts_enabled: 'yes' } } }), null)
    })

    // A record the adopted store saved before the fixed fields were carried still reads, as unknown
    it('reads a previous without proxyFixed as null', () => {
        assert.deepEqual(parseEdgeReply({ ok: true, verb: 'apply', ids, previous: spec }), { ok: true, verb: 'apply', ids, previous: { ...spec, proxyFixed: null } })
    })
})

// The flexible redirection host (aliases no certificate covers, under a Full SSL primary) is a third
// host. Its keys are optional both ways: a message or record written before it existed has neither, and
// one written now carries them only when there is such a host, so absent and null read the same.
describe('the flexible redirection host', () => {
    const flexible = {
        domain_names: ['spotondrones.com.au'], forward_domain_name: 'spotondrones.com', certificate_id: 0,
        ssl_forced: false, http2_support: false, advanced_config: markerFor(owner),
    }
    const withFlexible: HostsSpec = { proxy, redirection, flexibleRedirection: flexible }
    const allIds = { proxyHost: 4, redirectionHost: 5, flexibleRedirectionHost: 6 }

    it('round-trips in every request and reply that carries hosts or ids', () => {
        const requests: EdgeRequest[] = [
            { verb: 'get', owner, ids: allIds },
            { verb: 'remove', owner, ids: allIds },
            { verb: 'apply', owner, ids: allIds, spec: withFlexible, adopt: false },
        ]
        for (const request of requests) assert.deepEqual(parseEdgeRequest(JSON.parse(JSON.stringify(request))), request)
        const replies: EdgeReply[] = [
            { ok: true, verb: 'get', current: withFlexible },
            { ok: true, verb: 'apply', ids: allIds, previous: { ...withFlexible, proxyFixed: null } },
        ]
        for (const reply of replies) assert.deepEqual(parseEdgeReply(JSON.parse(JSON.stringify(reply))), reply)
    })

    it('reads an explicit null the same as an absent key, and answers neither', () => {
        assert.deepEqual(parseEdgeRequest({ verb: 'get', owner, ids: { ...ids, flexibleRedirectionHost: null } }), { verb: 'get', owner, ids })
        assert.deepEqual(parseEdgeReply({ ok: true, verb: 'get', current: { ...spec, flexibleRedirection: null } }), { ok: true, verb: 'get', current: spec })
        assert.deepEqual(
            parseEdgeReply({ ok: true, verb: 'apply', ids: { ...ids, flexibleRedirectionHost: null }, previous: { ...spec, flexibleRedirection: null, proxyFixed: null } }),
            { ok: true, verb: 'apply', ids, previous: { ...spec, proxyFixed: null } },
        )
    })

    it('stays strict about what the new keys hold', () => {
        assert.equal(parseEdgeRequest({ verb: 'get', owner, ids: { ...ids, flexibleRedirectionHost: 1.5 } }), null)
        assert.equal(parseEdgeRequest({ verb: 'get', owner, ids: { ...ids, flexibleRedirectionHost: '6' } }), null)
        assert.equal(parseEdgeRequest({ verb: 'get', owner, ids: { ...ids, flexibleHost: 6 } }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec: { ...spec, flexibleRedirection: { ...flexible, extra: 1 } }, adopt: false }), null)
        assert.equal(parseEdgeRequest({ verb: 'apply', owner, ids: null, spec: { ...spec, flexibleRedirection: { ...flexible, certificate_id: -1 } }, adopt: false }), null)
        assert.equal(parseEdgeReply({ ok: true, verb: 'get', current: { ...spec, flexible } }), null)
    })
})
