import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { writeVhost, removeVhost, setAliases, previewAdopt, adopt, type DomainsDeps } from './domains.ts'

const REGISTRY = `
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
`

function setup(options: { railOk?: boolean, existing?: string | null } = {}) {
    const sent: { action: string, write: { path: string, text: string } | null, remove: string[], disable: string[] }[] = []
    const railOk = options.railOk ?? true
    const deps: DomainsDeps = {
        rail: {
            async send(action, parts) {
                sent.push({ action, ...parts })
                // The revert, which is the second call, always passes: only the first is made to fail.
                const ok = railOk || sent.length > 1
                return { seq: sent.length - 1, ok, output: ok ? 'Syntax OK' : 'AH00526: Syntax error on line 9' }
            },
        },
        async readFile() { return options.existing ?? null },
        async listSitesEnabled() { return [] },
        // Neither is exercised unless a test overrides it: writeRegistry defaults to succeeding, and
        // reloadRegistry defaults to handing back the fixture unchanged.
        async writeRegistry() { return { ok: true } },
        async reloadRegistry() { return parseRegistry(REGISTRY) },
        config: {
            includeDir: '/etc/apache2/hostd',
            sitesEnabled: '/etc/apache2/sites-enabled',
            originCert: '/etc/ssl/hostd/origin.pem',
            originKey: '/etc/ssl/hostd/origin.key',
            acmeWebroot: '/var/www/hostd-acme',
            maintenanceFlagDir: '/run/hostd/maintenance',
            maintenancePageDir: '/var/www/hostd-maintenance',
        },
    }
    const registry = parseRegistry(REGISTRY)
    const project = registry.projects.get('acme')!
    return { deps, sent, project, environment: project.environments.get('live')! }
}

// The same fixture, but with the live environment's aliases spliced in, as if the registry had already
// been rewritten. Lets a test that stands in for reloadRegistry name only the aliases it cares about.
function reloaded(aliases: string[]) {
    const list = aliases.length === 0 ? '[]' : `[${aliases.join(', ')}]`
    return parseRegistry(`
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
        aliases: ${list}
`)
}

describe('writeVhost', () => {
    it('sends one reload carrying the rendered file', async () => {
        const { deps, sent, project, environment } = setup()
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'reload')
        assert.equal(sent[0]!.write?.path, '/etc/apache2/hostd/acme-live.conf')
        assert.match(sent[0]!.write?.text ?? '', /ServerName acme\.com/)
    })

    it('answers with every hostname it just made live', async () => {
        const { deps, project, environment } = setup()
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.written.hostnames, ['acme.com', 'www.acme.com'])
    })

    it('refuses an environment with no domain rather than writing a vhost that serves nothing', async () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
`)
        const { deps } = setup()
        const project = registry.projects.get('acme')!
        const result = await writeVhost(deps, project, project.environments.get('live')!, 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /no domain/)
    })

    it('puts the previous file back when the configtest fails', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false, existing: '# the old file\n' })
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 2, 'the revert is a second request')
        assert.equal(sent[1]!.write?.text, '# the old file\n')
    })

    it('removes the file it wrote when the configtest fails and there was no previous file', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false, existing: null })
        await writeVhost(deps, project, environment, 'abc123')
        assert.deepEqual(sent[1]!.remove, ['/etc/apache2/hostd/acme-live.conf'])
        assert.equal(sent[1]!.write, null)
    })

    it('carries Apache\'s own output back, because that is what says what is wrong', async () => {
        const { deps, project, environment } = setup({ railOk: false })
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.match(result.ok === false ? result.output ?? '' : '', /AH00526/)
    })
})

describe('removeVhost', () => {
    it('removes the file and reloads', async () => {
        const { deps, sent, project, environment } = setup()
        const result = await removeVhost(deps, project, environment)
        assert.equal(result.ok, true)
        assert.deepEqual(sent[0]!.remove, ['/etc/apache2/hostd/acme-live.conf'])
        assert.equal(sent[0]!.write, null)
    })
})

describe('setAliases', () => {
    it('writes the registry before it writes the vhost', async () => {
        const order: string[] = []
        const { deps, project, environment } = setup()
        deps.writeRegistry = async () => { order.push('registry'); return { ok: true } }
        deps.reloadRegistry = async () => { order.push('reload'); return reloaded(['www.acme.com']) }
        const inner = deps.rail.send
        deps.rail = { send: async (a, p) => { order.push('vhost'); return inner(a, p) } }
        await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.deepEqual(order, ['registry', 'reload', 'vhost'])
    })

    it('does not touch Apache when the registry write is refused', async () => {
        const { deps, sent, project, environment } = setup()
        deps.writeRegistry = async () => ({ ok: false, problem: 'someone else changed it' })
        const result = await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 0)
    })

    it('refuses an alias equal to the primary', async () => {
        const { deps, project, environment } = setup()
        const result = await setAliases(deps, project, environment, ['acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /already this environment's domain/)
    })

    it('refuses more hostnames than the project allows, counting the primary', async () => {
        const { deps, project, environment } = setup()
        const capped = { ...project, maxDomains: 2 }
        const result = await setAliases(deps, capped, environment, ['a.acme.com', 'b.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /at most 2 hostnames/)
    })

    it('allows exactly the cap, counting the primary, which is the boundary an off-by-one would miss', async () => {
        const { deps, project, environment } = setup()
        const capped = { ...project, maxDomains: 2 }
        deps.reloadRegistry = async () => reloaded(['a.acme.com'])
        const result = await setAliases(deps, capped, environment, ['a.acme.com'], 'abc123')
        assert.equal(result.ok, true)
    })

    it('refuses an environment with no domain rather than accepting aliases for it', async () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
`)
        const { deps } = setup()
        const project = registry.projects.get('acme')!
        const result = await setAliases(deps, project, project.environments.get('live')!, ['www.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /no domain/)
    })

    it('renders the vhost from the reloaded entry, not from the arguments', async () => {
        const { deps, sent, project, environment } = setup()
        // The registry accepted only one of the two: the second was already taken by another project.
        deps.reloadRegistry = async () => reloaded(['www.acme.com'])
        await setAliases(deps, project, environment, ['www.acme.com', 'taken.com'], 'abc123')
        assert.doesNotMatch(sent[0]!.write?.text ?? '', /taken\.com/)
    })

    it('reports an entry that did not survive the change rather than writing a vhost for it', async () => {
        const { deps, sent, project, environment } = setup()
        deps.reloadRegistry = async () => parseRegistry('projects: {}')
        const result = await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 0)
    })
})

describe('previewAdopt', () => {
    const handWritten = {
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: 'ServerName acme.com\nServerAlias www.acme.com legacy.acme.com\n',
    }

    it('shows the file that serves this site today and the one hostd proposes', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.preview.claims[0]!.path, handWritten.path)
        assert.match(result.ok ? result.preview.proposed : '', /ServerName acme\.com/)
    })

    it('lists hostnames the old file serves that the registry does not know about', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.preview.extraNames, ['legacy.acme.com'])
    })

    it('moves nothing and reloads nothing', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(sent.length, 0)
    })

    it('refuses to call a file adoptable when it uses Include', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [{ path: handWritten.path, text: 'ServerName acme.com\nInclude /etc/apache2/common.conf' }]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.adoptable, false)
    })

    it('is adoptable with no claims at all, which is a site that has no hand-written vhost', async () => {
        const { deps, project, environment } = setup()
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.adoptable, true)
        assert.deepEqual(result.ok && result.preview.claims, [])
    })
})

describe('adopt', () => {
    const handWritten = { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\n' }

    it('writes the new file and disables the old one in a single request', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'adopt')
        assert.deepEqual(sent[0]!.disable, [handWritten.path])
        assert.match(sent[0]!.write?.text ?? '', /Generated by hostd/)
    })

    it('refuses a file that is not currently claiming one of this environment\'s hostnames', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', ['/etc/apache2/sites-enabled/other.conf'])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /does not serve/)
    })

    it('refuses to adopt a file it could not fully read', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [{ path: handWritten.path, text: 'ServerName acme.com\nUse CommonSite acme' }]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /cannot be read/)
    })

    it('reverts when the configtest fails, so the old file comes back', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false })
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.equal(sent.length, 2)
    })
})
