import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { driftWarnings } from './drift.ts'
import { writeHosts, type DomainsConfig, type DomainsDeps } from './domains.ts'
import { FakeEdge, FAKE_UPSTREAM } from './testing/fake-edge.ts'

const REGISTRY = `
certificates:
  acme.com: 16
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: acme.com
        aliases: [www.acme.com]
        npm: { proxyHost: 100, redirectionHost: 101 }
      uat1:
        dir: /var/www/acme-uat1
        port: 5011
        domain: uat1.acme.com
`
const config: DomainsConfig = { upstreamHost: FAKE_UPSTREAM, edgeHost: FAKE_UPSTREAM, edgeHttpPort: 8790 }

// Writes live's hosts through the real domains code, so the render under test is the one hostd made
async function written() {
    const edge = new FakeEdge()
    edge.npm.certificates = [16]
    const registry = parseRegistry(REGISTRY)
    const project = registry.projects.get('acme')!
    const deps = {
        edge,
        async writeRegistry() { return { ok: true as const } },
        async reloadRegistry() { return registry },
        config,
    } as unknown as DomainsDeps
    const result = await writeHosts(deps, project, { ...project.environments.get('live')!, npm: null }, 'abc123')
    assert.equal(result.ok, true)
    return { edge, registry }
}

describe('driftWarnings', () => {
    it('reports nothing when everything matches', async () => {
        const { edge, registry } = await written()
        assert.deepEqual(await driftWarnings(registry, edge, config), [])
    })

    it('reports an owned host whose fields differ from the render', async () => {
        const { edge, registry } = await written()
        const proxy = edge.npm.snapshot()['proxy-hosts'][0]!
        edge.npm.seed('proxy-hosts', { ...proxy, forward_port: 9999, ssl_forced: false })
        const warnings = await driftWarnings(registry, edge, config)
        assert.equal(warnings.length, 1, warnings.join('; '))
        assert.match(warnings[0]!, /acme live/)
        assert.match(warnings[0]!, /proxy host 100/)
        assert.match(warnings[0]!, /forward_port, ssl_forced/)
        assert.doesNotMatch(warnings[0]!, /advanced_config/)
    })

    it('reports an edited redirection host and a changed advanced_config by field', async () => {
        const { edge, registry } = await written()
        const state = edge.npm.snapshot()
        edge.npm.seed('redirection-hosts', { ...state['redirection-hosts'][0]!, forward_domain_name: 'elsewhere.com' })
        edge.npm.seed('proxy-hosts', { ...state['proxy-hosts'][0]!, advanced_config: `${state['proxy-hosts'][0]!.advanced_config}\nclient_max_body_size 1g;\n` })
        const warnings = await driftWarnings(registry, edge, config)
        assert.equal(warnings.length, 2, warnings.join('; '))
        assert.ok(warnings.some(warning => /proxy host 100.*advanced_config/.test(warning)))
        assert.ok(warnings.some(warning => /redirection host 101.*forward_domain_name/.test(warning)))
    })

    it('reports a host whose token can no longer be read, rather than inventing one', async () => {
        const { edge, registry } = await written()
        const proxy = edge.npm.snapshot()['proxy-hosts'][0]!
        const marker = String(proxy.advanced_config).split('\n')[0]!
        edge.npm.seed('proxy-hosts', { ...proxy, advanced_config: `${marker}\n` })
        const warnings = await driftWarnings(registry, edge, config)
        assert.equal(warnings.length, 1)
        assert.match(warnings[0]!, /verification token/)
    })

    it('reports a host whose marker was removed', async () => {
        const { edge, registry } = await written()
        const proxy = edge.npm.snapshot()['proxy-hosts'][0]!
        edge.npm.seed('proxy-hosts', { ...proxy, advanced_config: 'client_max_body_size 1g;' })
        const warnings = await driftWarnings(registry, edge, config)
        assert.ok(warnings.some(warning => /acme live.*marker/.test(warning)), warnings.join('; '))
    })

    it('reports an NPM host not owned by hostd that serves a registry hostname', async () => {
        const { edge, registry } = await written()
        edge.npm.seed('proxy-hosts', { id: 200, domain_names: ['uat1.acme.com'], forward_host: '10.0.0.9', forward_port: 80 })
        const warnings = await driftWarnings(registry, edge, config)
        assert.equal(warnings.length, 1, warnings.join('; '))
        assert.match(warnings[0]!, /proxy host 200 serves uat1\.acme\.com/)
        assert.match(warnings[0]!, /acme uat1/)
    })

    it('does not check environments without hosts for drift, and ignores unrelated NPM hosts', async () => {
        const { edge, registry } = await written()
        edge.npm.seed('proxy-hosts', { id: 201, domain_names: ['other.example'], forward_host: '10.0.0.9', forward_port: 80 })
        assert.deepEqual(await driftWarnings(registry, edge, config), [])
        assert.equal(edge.requests.filter(request => request.verb === 'get').length, 1)
    })

    it('reports edge being unreachable as one warning, not a throw', async () => {
        const { edge, registry } = await written()
        edge.failNext('get', 'before')
        const warnings = await driftWarnings(registry, edge, config)
        assert.equal(warnings.length, 1)
        assert.match(warnings[0]!, /could not be checked for drift/)
    })
})
