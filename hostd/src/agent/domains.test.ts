import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { applyChange, type Change } from '../shared/registry-write.ts'
import { markerFor, type HostsSpec, type Owner } from '../shared/edge-protocol.ts'
import {
    adopt, currentToken, previewAdopt, recreateHosts, removeEdgeHosts, removeHosts, restoreAdopted, setAliases, writeHosts,
    type DomainsDeps,
} from './domains.ts'
import type { AdoptedStore } from './adopted-store.ts'
import { FakeEdge, FAKE_UPSTREAM } from './testing/fake-edge.ts'

const OWNER: Owner = { project: 'acme', environment: 'live' }
const BS = String.fromCharCode(92)
const BROTLI = `if ($http_content_encoding ~* "(^|,)${BS}s*br${BS}s*(,|$)") {
    return 415;
}`

function registryText(options: { aliases?: string[], certificates?: boolean, flexibleSsl?: boolean, port?: number } = {}): string {
    const aliases = options.aliases ?? ['www.acme.com']
    return `
${options.certificates === false ? '' : 'certificates:\n  acme.com: 16\n'}
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        port: ${options.port ?? 5010}
        domain: acme.com
        aliases: [${aliases.join(', ')}]
${options.flexibleSsl ? '        flexibleSsl: true\n' : ''}      uat1:
        dir: /var/www/acme-uat1
        port: 5011
        domain: uat1.acme.com
`
}

function memoryStore(): AdoptedStore & { records: Map<string, unknown> } {
    const records = new Map<string, unknown>()
    const key = (owner: Owner) => `${owner.project}-${owner.environment}`
    return {
        records,
        async save(owner, record) { records.set(key(owner), structuredClone(record)) },
        async read(owner) { return (records.get(key(owner)) as never) ?? null },
        async clear(owner) { records.delete(key(owner)) },
    }
}

function setup(options: Parameters<typeof registryText>[0] = {}) {
    const edge = new FakeEdge()
    edge.npm.certificates = [16]
    let text = registryText(options)
    const changes: Change[] = []
    const order: string[] = []
    const adopted = memoryStore()
    const deps: DomainsDeps = {
        edge: {
            async call(request) {
                order.push(`edge ${request.verb}`)
                return edge.call(request)
            },
        },
        adopted,
        async writeRegistry(change) {
            changes.push(change)
            order.push(`registry ${change.kind}`)
            const result = applyChange(text, change)
            if (!result.ok) return result
            text = result.text
            return { ok: true }
        },
        async reloadRegistry() { return parseRegistry(text) },
        config: { upstreamHost: FAKE_UPSTREAM, edgeHost: FAKE_UPSTREAM, edgeHttpPort: 8790 },
    }
    // The entry as the registry holds it now, so a test sees ids an earlier call recorded
    const current = (name: 'live' | 'uat1' = 'live') => {
        const project = parseRegistry(text).projects.get('acme')!
        return { project, environment: project.environments.get(name)! }
    }
    return { deps, edge, npm: edge.npm, changes, order, adopted, current }
}

// A proxy host Koda made by hand in NPM's UI, as NPM returns it
function handMade(id: number, over: Record<string, unknown> = {}) {
    return {
        id, domain_names: ['acme.com', 'www.acme.com'], forward_scheme: 'http', forward_host: FAKE_UPSTREAM, forward_port: 5010,
        certificate_id: 16, ssl_forced: 1, http2_support: 1, hsts_enabled: 0, hsts_subdomains: 0, caching_enabled: 0,
        access_list_id: 0, block_exploits: 1, allow_websocket_upgrade: 1, advanced_config: BROTLI, locations: [], ...over,
    }
}

describe('writeHosts', () => {
    it('refuses an environment with no domain', async () => {
        const { deps, edge, current } = setup()
        const { project, environment } = current()
        const result = await writeHosts(deps, project, { ...environment, domain: null }, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.deepEqual(edge.writes(), [])
    })

    it('refuses Full SSL without a zone certificate', async () => {
        const { deps, edge, current, changes } = setup({ certificates: false })
        const { project, environment } = current()
        const result = await writeHosts(deps, project, environment, 'abc123')
        assert.deepEqual(result, { ok: false, code: 'bad-request', message: 'No certificate in Nginx Proxy Manager covers acme.com.' })
        assert.deepEqual(edge.writes(), [])
        assert.deepEqual(changes, [])
    })

    it('needs no certificate under Flexible SSL', async () => {
        const { deps, npm, current } = setup({ certificates: false, flexibleSsl: true })
        const { project, environment } = current()
        const result = await writeHosts(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        const proxy = npm.snapshot()['proxy-hosts'][0]!
        assert.equal(proxy.certificate_id, 0)
        assert.equal(proxy.ssl_forced, false)
    })

    it('a create records the npm ids in the registry', async () => {
        const { deps, npm, current, changes } = setup()
        const { project, environment } = current()
        const result = await writeHosts(deps, project, environment, 'abc123')
        assert.deepEqual(result, { ok: true, written: { hostnames: ['acme.com', 'www.acme.com'], path: 'npm:proxy-host/100' } })
        assert.deepEqual(changes, [{ kind: 'set-npm', id: 'acme', environment: 'live', npm: { proxyHost: 100, redirectionHost: 101 } }])
        assert.deepEqual(current().environment.npm, { proxyHost: 100, redirectionHost: 101 })
        const state = npm.snapshot()
        const proxy = state['proxy-hosts'][0]!
        assert.deepEqual(proxy.domain_names, ['acme.com'])
        assert.equal(proxy.forward_host, FAKE_UPSTREAM)
        assert.equal(proxy.forward_port, 5010)
        assert.equal(proxy.certificate_id, 16)
        assert.equal(String(proxy.advanced_config).split('\n')[0], markerFor(OWNER))
        assert.match(String(proxy.advanced_config), /location = \/\.well-known\/hostd\/abc123/)
        assert.deepEqual(state['redirection-hosts'][0]!.domain_names, ['www.acme.com'])
    })

    it('an update keeps the ids and leaves the registry alone', async () => {
        const { deps, npm, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        const result = await writeHosts(deps, current().project, current().environment, 'def456')
        assert.deepEqual(result, { ok: true, written: { hostnames: ['acme.com', 'www.acme.com'], path: 'npm:proxy-host/100' } })
        assert.deepEqual(changes, [])
        assert.match(String(npm.snapshot()['proxy-hosts'][0]!.advanced_config), /def456/)
    })

    it('writes the holding page before the hosts that point at it', async () => {
        const { deps, order, current } = setup()
        deps.refreshHoldingPage = async () => { order.push('page') }
        await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.ok(order.indexOf('page') < order.indexOf('edge apply'))
    })

    it('writes the hosts even when the holding page could not be written', async () => {
        const { deps, current } = setup()
        deps.refreshHoldingPage = async () => { throw new Error('EACCES') }
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.equal(result.ok, true)
    })

    it('refuses a create while another NPM host serves the name, writing nothing', async () => {
        const { deps, npm, edge, current, changes } = setup()
        npm.seed('proxy-hosts', handMade(12))
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.deepEqual(result, {
            ok: false, code: 'bad-request',
            message: 'acme.com is already served by NPM proxy host 12, which hostd does not manage; adopt acme live from the Domains tab to take it over, or remove it in NPM',
        })
        assert.deepEqual(edge.writes(), [])
        assert.deepEqual(changes, [])
    })

    it('carries edge\'s refusal back as a failure', async () => {
        const { deps, npm, current, changes } = setup()
        npm.certificates = []
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.deepEqual(result, { ok: false, code: 'failed', message: 'NPM has no certificate 16' })
        assert.deepEqual(changes, [])
    })

    it('refuses as unavailable and records nothing when edge never got the write', async () => {
        const { deps, edge, current, changes } = setup()
        edge.failNext('apply', 'before')
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'unavailable')
        assert.match(!result.ok ? result.message : '', /NPM does not show the change/)
        assert.deepEqual(changes, [])
    })

    it('records the ids when the reply was lost but NPM shows the hosts were written', async () => {
        const { deps, edge, current, changes } = setup()
        edge.failNext('apply', 'after')
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.deepEqual(result, { ok: true, written: { hostnames: ['acme.com', 'www.acme.com'], path: 'npm:proxy-host/100' } })
        assert.deepEqual(changes, [{ kind: 'set-npm', id: 'acme', environment: 'live', npm: { proxyHost: 100, redirectionHost: 101 } }])
    })

    it('says the change may or may not have reached NPM when the re-read fails too', async () => {
        const { deps, edge, current, changes } = setup()
        edge.failNext('apply', 'after')
        // The create's own check is the first find; the re-read after the lost reply is the second
        const inner = deps.edge
        let finds = 0
        deps.edge = {
            async call(request) {
                if (request.verb === 'find' && ++finds === 2) throw new Error('edge connection failed: ECONNREFUSED')
                return inner.call(request)
            },
        }
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'unavailable')
        assert.match(!result.ok ? result.message : '', /may or may not have reached Nginx Proxy Manager/)
        assert.deepEqual(changes, [])
    })

    it('confirms an update through a get when the reply was lost', async () => {
        const { deps, edge, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        edge.failNext('apply', 'after')
        const result = await writeHosts(deps, current().project, current().environment, 'def456')
        assert.equal(result.ok, true)
        assert.ok(edge.requests.some(request => request.verb === 'get'))
    })

    it('removes the hosts it created when the registry will not record their ids', async () => {
        const { deps, npm, current } = setup()
        deps.writeRegistry = async () => ({ ok: false, problem: 'the registry file is read-only' })
        const result = await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'failed')
        assert.match(!result.ok ? result.message : '', /the registry file is read-only/)
        assert.deepEqual(npm.snapshot()['proxy-hosts'], [])
        assert.deepEqual(npm.snapshot()['redirection-hosts'], [])
    })
})

describe('removeHosts', () => {
    it('is a success that touches nothing for an environment hostd holds no ids for', async () => {
        const { deps, edge, current, changes } = setup()
        const result = await removeHosts(deps, current().project, current().environment)
        assert.equal(result.ok, true)
        assert.deepEqual(edge.requests, [])
        assert.deepEqual(changes, [])
    })

    it('removes the hosts and then clears the ids', async () => {
        const { deps, npm, current, changes, order } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        order.length = 0
        changes.length = 0
        const result = await removeHosts(deps, current().project, current().environment)
        assert.deepEqual(result, { ok: true, written: { hostnames: [], path: 'npm:proxy-host/100' } })
        assert.deepEqual(order, ['edge remove', 'registry set-npm'])
        assert.deepEqual(changes, [{ kind: 'set-npm', id: 'acme', environment: 'live', npm: null }])
        assert.deepEqual(npm.snapshot()['proxy-hosts'], [])
        assert.deepEqual(npm.snapshot()['redirection-hosts'], [])
    })

    it('keeps the ids when edge refuses, because the hosts are still there', async () => {
        const { deps, npm, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        // Koda deleted the marker by hand: the host is no longer hostd's to delete
        npm.seed('proxy-hosts', { ...npm.snapshot()['proxy-hosts'][0]!, advanced_config: 'return 418;' })
        const result = await removeHosts(deps, current().project, current().environment)
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'failed')
        assert.deepEqual(changes, [])
    })

    it('clears the ids when the reply was lost but the hosts are gone', async () => {
        const { deps, edge, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        edge.failNext('remove', 'after')
        const result = await removeHosts(deps, current().project, current().environment)
        assert.equal(result.ok, true)
        assert.deepEqual(changes, [{ kind: 'set-npm', id: 'acme', environment: 'live', npm: null }])
    })

    it('keeps the ids when the reply was lost and the hosts are still there', async () => {
        const { deps, edge, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        edge.failNext('remove', 'before')
        const result = await removeHosts(deps, current().project, current().environment)
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'unavailable')
        assert.deepEqual(changes, [])
    })

    it('says the change may or may not have reached NPM when the re-read fails too', async () => {
        const { deps, edge, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        edge.failNext('remove', 'after')
        edge.failNext('get', 'before')
        const result = await removeHosts(deps, current().project, current().environment)
        assert.equal(!result.ok && result.code, 'unavailable')
        assert.match(!result.ok ? result.message : '', /may or may not have reached Nginx Proxy Manager/)
        assert.deepEqual(changes, [])
    })
})

describe('removeEdgeHosts', () => {
    it('removes the hosts without writing the registry, for an entry that is already gone', async () => {
        const { deps, npm, current, changes } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        changes.length = 0
        const result = await removeEdgeHosts(deps, current().project, current().environment)
        assert.deepEqual(result, { ok: true })
        assert.deepEqual(changes, [])
        assert.deepEqual(npm.snapshot()['proxy-hosts'], [])
    })
})

describe('recreateHosts', () => {
    it('creates the hosts again from a spec read earlier and records the new ids', async () => {
        const { deps, npm, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        const before = npm.snapshot()['proxy-hosts'][0]!
        const removed = await removeHosts(deps, current().project, current().environment)
        assert.equal(removed.ok, true)
        const spec: HostsSpec = {
            proxy: {
                domain_names: ['acme.com'], forward_host: FAKE_UPSTREAM, forward_port: 5010, certificate_id: 16,
                ssl_forced: true, http2_support: true, advanced_config: String(before.advanced_config),
            },
            redirection: null,
        }
        const result = await recreateHosts(deps, current().project, current().environment, spec)
        assert.deepEqual(result, { ok: true })
        assert.deepEqual(current().environment.npm, { proxyHost: 102, redirectionHost: null })
    })
})

describe('setAliases', () => {
    it('writes the registry before it writes the hosts', async () => {
        const { deps, order, current } = setup()
        const result = await setAliases(deps, current().project, current().environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, true)
        assert.deepEqual(order.filter(step => step !== 'edge find'), ['registry set-aliases', 'edge apply', 'registry set-npm'])
        assert.deepEqual(result.ok && result.written.hostnames, ['acme.com', 'www.acme.com', 'shop.acme.com'])
    })

    it('refuses an alias equal to the primary', async () => {
        const { deps, edge, current } = setup()
        const result = await setAliases(deps, current().project, current().environment, ['acme.com'], 'abc123')
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.deepEqual(edge.requests, [])
    })

    it('refuses an alias another NPM host already serves, naming the host', async () => {
        const { deps, npm, edge, current, changes } = setup()
        npm.seed('proxy-hosts', handMade(30, { domain_names: ['shop.acme.com'], advanced_config: '' }))
        const result = await setAliases(deps, current().project, current().environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.deepEqual(result, {
            ok: false, code: 'bad-request',
            message: 'shop.acme.com is already on NPM proxy host 30, which this environment does not own; remove it there first',
        })
        assert.deepEqual(changes, [])
        assert.deepEqual(edge.writes(), [])
    })

    it('refuses while a host hostd does not own still serves the primary', async () => {
        const { deps, npm, current, changes } = setup()
        npm.seed('proxy-hosts', handMade(12))
        const result = await setAliases(deps, current().project, current().environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.match(!result.ok ? result.message : '', /acme\.com is still served by NPM proxy host 12.*adopt acme live first/)
        assert.deepEqual(changes, [])
    })

    it('does not re-check names already on the environment, and accepts its own hosts', async () => {
        const { deps, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        const result = await setAliases(deps, current().project, current().environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, true)
        const removing = await setAliases(deps, current().project, current().environment, ['shop.acme.com'], 'abc123')
        assert.equal(removing.ok, true)
        assert.deepEqual(current().environment.npm, { proxyHost: 100, redirectionHost: 101 })
    })

    it('touches no host when the registry refuses the change', async () => {
        const { deps, edge, current } = setup()
        deps.writeRegistry = async () => ({ ok: false, problem: 'uat1.acme.com is already used' })
        const result = await setAliases(deps, current().project, current().environment, ['uat1.acme.com'], 'abc123')
        assert.equal(!result.ok && result.code, 'failed')
        assert.deepEqual(edge.writes(), [])
    })
})

describe('previewAdopt', () => {
    it('shows the NPM host serving the site today and the hosts hostd proposes', async () => {
        const { deps, npm, edge, current } = setup()
        npm.seed('proxy-hosts', handMade(12))
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        const { preview } = result
        assert.equal(preview.adoptable, true)
        assert.deepEqual(preview.extraNames, [])
        assert.deepEqual(preview.unreadable, [])
        assert.equal(preview.flexibleSsl, false)
        assert.equal(preview.claims.length, 1)
        const claim = preview.claims[0]!
        assert.equal(claim.path, 'NPM proxy host 12')
        assert.deepEqual(claim.names, ['acme.com', 'www.acme.com'])
        assert.deepEqual(claim.unsupported, [])
        assert.match(claim.text, /^Proxy host\nDomains: acme\.com, www\.acme\.com\nUpstream: 192\.168\.0\.8:5010/)
        assert.match(preview.proposed, /Redirection host\nDomains: www\.acme\.com/)
        assert.match(preview.proposed, /# hostd: acme\/live/)
        assert.deepEqual(edge.writes(), [])
    })

    it('refuses when no NPM host serves the site', async () => {
        const { deps, current } = setup()
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.deepEqual(result, { ok: false, code: 'bad-request', message: 'no NPM proxy host serves acme.com' })
    })

    it('preview refuses a host on another upstream', async () => {
        const { deps, npm, current } = setup()
        npm.seed('proxy-hosts', handMade(12, { forward_host: '192.168.0.9' }))
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        assert.equal(result.preview.adoptable, false)
        assert.deepEqual(result.preview.claims[0]!.unsupported, ['It forwards to 192.168.0.9:5010, not 192.168.0.8:5010.'])
    })

    it('preview reports names the registry does not list as unsupported', async () => {
        const { deps, npm, current } = setup()
        npm.seed('proxy-hosts', handMade(12, { domain_names: ['acme.com', 'www.acme.com', 'acme.com.au'] }))
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        assert.deepEqual(result.preview.extraNames, ['acme.com.au'])
        assert.equal(result.preview.adoptable, false)
        assert.deepEqual(result.preview.claims[0]!.unsupported, ['acme.com.au are on the NPM host but not in the registry; add them as aliases first.'])
    })

    it('refuses more than one host, a redirection host, locations and custom directives', async () => {
        const { deps, npm, current } = setup()
        npm.seed('proxy-hosts', handMade(12, { domain_names: ['acme.com'], locations: [{ path: '/api' }], advanced_config: 'client_max_body_size 50m;' }))
        npm.seed('redirection-hosts', { id: 4, domain_names: ['www.acme.com'], forward_domain_name: 'acme.com', advanced_config: '' })
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        const [proxy, redirection] = result.preview.claims
        assert.equal(result.preview.adoptable, false)
        assert.ok(proxy!.unsupported.some(reason => reason.startsWith('2 NPM hosts serve these names')))
        assert.ok(proxy!.unsupported.includes('It has custom locations, which hostd would drop.'))
        assert.ok(proxy!.unsupported.some(reason => reason.startsWith('It has custom nginx directives: client_max_body_size 50m;')))
        assert.equal(redirection!.path, 'NPM redirection host 4')
        assert.ok(redirection!.unsupported.some(reason => reason.startsWith('It is a redirection host')))
    })

    it('refuses a host carrying another environment\'s marker', async () => {
        const { deps, npm, current } = setup()
        npm.seed('proxy-hosts', handMade(12, { advanced_config: `${markerFor({ project: 'acme', environment: 'uat1' })}\n` }))
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        assert.deepEqual(result.preview.claims[0]!.unsupported, ['It carries the marker for acme/uat1, so it is already managed by hostd for that environment.'])
    })

    it('reports the environment\'s own Flexible SSL flag', async () => {
        const { deps, npm, current } = setup({ flexibleSsl: true })
        npm.seed('proxy-hosts', handMade(12, { certificate_id: 0, ssl_forced: 0 }))
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.ok(result.ok && 'preview' in result)
        assert.equal(result.preview.flexibleSsl, true)
    })

    it('refuses as unavailable when NPM cannot be read', async () => {
        const { deps, edge, current } = setup()
        edge.failNext('find', 'before')
        const result = await previewAdopt(deps, current().project, current().environment, 'abc123')
        assert.equal(!result.ok && result.code, 'unavailable')
    })
})

describe('adopt', () => {
    it('adopt keeps the proxy host id and records the redirection host', async () => {
        const { deps, npm, current, adopted } = setup()
        npm.seed('proxy-hosts', handMade(12))
        const result = await adopt(deps, current().project, current().environment, 'abc123', ['NPM proxy host 12'])
        assert.deepEqual(result, { ok: true, written: { hostnames: ['acme.com', 'www.acme.com'], path: 'npm:proxy-host/12' } })
        assert.deepEqual(current().environment.npm, { proxyHost: 12, redirectionHost: 100 })
        const state = npm.snapshot()
        assert.deepEqual(state['proxy-hosts'].map(host => [host.id, host.domain_names]), [[12, ['acme.com']]])
        assert.equal(String(state['proxy-hosts'][0]!.advanced_config).split('\n')[0], markerFor(OWNER))
        assert.deepEqual(state['redirection-hosts'].map(host => [host.id, host.domain_names]), [[100, ['www.acme.com']]])
        const saved = await adopted.read(OWNER)
        assert.deepEqual(saved?.ids, { proxyHost: 12, redirectionHost: 100 })
        assert.deepEqual(saved?.previous.proxy.domain_names, ['acme.com', 'www.acme.com'])
        assert.equal(saved?.previous.proxy.advanced_config, BROTLI)
    })

    it('records the ids and the host as it was when the reply was lost but NPM shows the adopt landed', async () => {
        const { deps, npm, edge, current, adopted } = setup()
        npm.seed('proxy-hosts', handMade(12))
        edge.failNext('apply', 'after')
        const result = await adopt(deps, current().project, current().environment, 'abc123', [])
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.deepEqual(current().environment.npm, { proxyHost: 12, redirectionHost: 100 })
        assert.deepEqual((await adopted.read(OWNER))?.previous.proxy.domain_names, ['acme.com', 'www.acme.com'])
    })

    it('refuses a host the preview finds unadoptable, writing nothing', async () => {
        const { deps, npm, edge, current, changes } = setup()
        npm.seed('proxy-hosts', handMade(12, { forward_port: 6000 }))
        const result = await adopt(deps, current().project, current().environment, 'abc123', [])
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.match(!result.ok ? result.message : '', /NPM proxy host 12 cannot be adopted: It forwards to 192\.168\.0\.8:6000/)
        assert.deepEqual(edge.writes(), [])
        assert.deepEqual(changes, [])
    })

    it('refuses with nothing to adopt rather than creating hosts', async () => {
        const { deps, edge, current } = setup()
        const result = await adopt(deps, current().project, current().environment, 'abc123', [])
        assert.deepEqual(result, { ok: false, code: 'bad-request', message: 'no NPM proxy host serves acme.com' })
        assert.deepEqual(edge.writes(), [])
    })

    it('refuses an environment hostd already manages', async () => {
        const { deps, edge, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        const writes = edge.writes().length
        const result = await adopt(deps, current().project, current().environment, 'abc123', [])
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.equal(edge.writes().length, writes)
    })
})

describe('restoreAdopted', () => {
    it('restore puts back the hand-made host and clears the ids', async () => {
        const { deps, npm, current, adopted, changes } = setup()
        const original = npm.seed('proxy-hosts', handMade(12))
        await adopt(deps, current().project, current().environment, 'abc123', ['NPM proxy host 12'])
        changes.length = 0
        const result = await restoreAdopted(deps, current().project, current().environment, ['NPM proxy host 12'])
        assert.deepEqual(result, { ok: true, written: { hostnames: [], path: 'npm:proxy-host/12' } })
        const state = npm.snapshot()
        assert.deepEqual(state['redirection-hosts'], [])
        const proxy = state['proxy-hosts'][0]!
        assert.equal(proxy.id, 12)
        assert.deepEqual(proxy.domain_names, original.domain_names)
        assert.equal(proxy.advanced_config, BROTLI)
        assert.deepEqual(changes, [{ kind: 'set-npm', id: 'acme', environment: 'live', npm: null }])
        assert.equal(await adopted.read(OWNER), null)
        // Released: hostd no longer owns it, so a write is refused rather than taking it back silently
        const again = await removeEdgeHosts(deps, current().project, { ...current().environment, npm: { proxyHost: 12, redirectionHost: null } })
        assert.equal(again.ok, false)
    })

    it('clears the ids when the reply was lost but NPM shows the host was put back', async () => {
        const { deps, npm, edge, current, adopted } = setup()
        npm.seed('proxy-hosts', handMade(12))
        await adopt(deps, current().project, current().environment, 'abc123', [])
        edge.failNext('apply', 'after')
        const result = await restoreAdopted(deps, current().project, current().environment, [])
        assert.deepEqual(result, { ok: true, written: { hostnames: [], path: 'npm:proxy-host/12' } })
        assert.equal(current().environment.npm, null)
        assert.equal(await adopted.read(OWNER), null)
    })

    it('keeps the ids and says to check NPM when the reply was lost and nothing changed', async () => {
        const { deps, npm, edge, current } = setup()
        npm.seed('proxy-hosts', handMade(12))
        await adopt(deps, current().project, current().environment, 'abc123', [])
        edge.failNext('apply', 'before')
        const result = await restoreAdopted(deps, current().project, current().environment, [])
        assert.equal(!result.ok && result.code, 'unavailable')
        assert.match(!result.ok ? result.message : '', /could not be put back as it was: edge did not answer/)
        assert.deepEqual(current().environment.npm, { proxyHost: 12, redirectionHost: 100 })
    })

    it('refuses without a saved adoption', async () => {
        const { deps, edge, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        const writes = edge.writes().length
        const result = await restoreAdopted(deps, current().project, current().environment, [])
        assert.equal(!result.ok && result.code, 'bad-request')
        assert.equal(edge.writes().length, writes)
    })
})

describe('currentToken', () => {
    it('reads the token out of the hosts hostd wrote', async () => {
        const { deps, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        assert.equal(await currentToken(deps, current().project, current().environment), 'abc123')
    })

    it('answers null for an environment with no hosts', async () => {
        const { deps, current } = setup()
        assert.equal(await currentToken(deps, current().project, current().environment), null)
    })

    it('throws when edge cannot say', async () => {
        const { deps, edge, current } = setup()
        await writeHosts(deps, current().project, current().environment, 'abc123')
        edge.failNext('get', 'before')
        await assert.rejects(currentToken(deps, current().project, current().environment))
    })
})
