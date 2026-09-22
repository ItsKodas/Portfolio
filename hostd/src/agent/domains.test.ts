import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { writeVhost, removeVhost, setAliases, previewAdopt, adopt, type DomainsDeps } from './domains.ts'
import type { VhostFile } from './sites-enabled.ts'

// What listSitesEnabled answers with: the files that were read, and the paths of any that could not be.
// Most tests here care only about the first, so the second defaults to none.
const listing = (files: VhostFile[], unreadable: string[] = []) => async () => ({ files, unreadable })

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
        listSitesEnabled: listing([]),
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

    // The registry's uniqueness rule only sees hostd's own entries. Apache does not refuse two vhosts
    // claiming one hostname either: it warns and serves whichever loaded first.
    it('refuses an alias a hand-written vhost already claims, naming the file', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([
            { path: '/etc/apache2/sites-enabled/legacy.conf', text: 'ServerName legacy.example\nServerAlias shop.acme.com\n' },
        ])
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /shop\.acme\.com is already served by \/etc\/apache2\/sites-enabled\/legacy\.conf/)
        // Refused before the registry is touched, let alone Apache.
        assert.equal(sent.length, 0)
    })

    // Otherwise removing one alias would be refused because an unrelated one, accepted long ago, is
    // claimed by a file nobody is proposing to change.
    it('does not re-check the names the environment already serves', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([
            { path: '/etc/apache2/sites-enabled/legacy.conf', text: 'ServerName www.acme.com\n' },
        ])
        // Removing the alias that file claims, and adding nothing.
        const result = await setAliases(deps, project, environment, [], 'abc123')
        assert.equal(result.ok, true)
    })

    // The state all five existing sites are in. Writing the vhost claims the primary as well as the
    // aliases, so an alias added to a site nobody has adopted yet puts a second vhost on the primary
    // and lets include order decide which of the two answers. If hostd's wins, the site loses whatever
    // the hand-written file carried, which is the very thing adopt's preview exists to prevent.
    it('refuses to write a vhost at all while a hand-written file still serves the primary', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([
            { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\n' },
        ])
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        const message = result.ok === false ? result.message : ''
        assert.match(message, /acme\.com is still served by \/etc\/apache2\/sites-enabled\/acme\.conf/)
        // Says what to do, not only no.
        assert.match(message, /adopt acme live first/)
        assert.equal(sent.length, 0)
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
        deps.listSitesEnabled = listing([handWritten])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.preview.claims[0]!.path, handWritten.path)
        assert.match(result.ok ? result.preview.proposed : '', /ServerName acme\.com/)
    })

    // Both files, whole. Naming the one being replaced is not showing it, and the operator is about to
    // confirm an overwrite of a configuration serving a live site on the strength of this screen.
    it('carries the old file verbatim, not merely its path and the names it was understood to serve', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.claims[0]!.text, handWritten.text)
    })

    it('lists hostnames the old file serves that the registry does not know about', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.preview.extraNames, ['legacy.acme.com'])
    })

    it('moves nothing and reloads nothing', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten])
        await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(sent.length, 0)
    })

    it('refuses to call a file adoptable when it uses Include', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([{ path: handWritten.path, text: 'ServerName acme.com\nInclude /etc/apache2/common.conf' }])
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
        deps.listSitesEnabled = listing([handWritten])
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'adopt')
        assert.deepEqual(sent[0]!.disable, [handWritten.path])
        assert.match(sent[0]!.write?.text ?? '', /Generated by hostd/)
    })

    // The other half of "adoptable with no claims at all": a site nobody hand-wrote a file for must be
    // able to take its vhost, or a newly provisioned one would keep its registry domain and never get a
    // vhost, since adopt is the only route to one.
    it('writes the vhost for an environment with nothing to disable', async () => {
        const { deps, sent, project, environment } = setup()
        const result = await adopt(deps, project, environment, 'abc123', [])
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'adopt')
        assert.deepEqual(sent[0]!.disable, [])
        assert.match(sent[0]!.write?.text ?? '', /Generated by hostd/)
        assert.deepEqual(result.ok && result.written.hostnames, ['acme.com', 'www.acme.com'])
    })

    it('refuses a file that is not currently claiming one of this environment\'s hostnames', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten])
        const result = await adopt(deps, project, environment, 'abc123', ['/etc/apache2/sites-enabled/other.conf'])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /does not serve/)
    })

    it('refuses to adopt a file it could not fully read', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([{ path: handWritten.path, text: 'ServerName acme.com\nUse CommonSite acme' }])
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /cannot be read/)
    })

    it('reverts when the configtest fails, so the old file comes back', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false })
        deps.listSitesEnabled = listing([handWritten])
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.equal(sent.length, 2)
    })
})

// One file in sites-enabled that cannot be opened used to throw out of listSitesEnabled, so the agent's
// top-level catch turned it into "unavailable" and every domain action on every site on the box failed,
// naming a file belonging to a site the operator was not even looking at. A file Apache cannot read
// serves nothing, so it claims no hostname, and it must not stop an unrelated site's change. It is not
// forgotten either: it goes to the preview and to /health.
describe('an unreadable file in sites-enabled', () => {
    const handWritten = {
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: 'ServerName acme.com\nServerAlias www.acme.com\n',
    }
    const dangling = '/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'

    // A readable file beside the broken one, because a sites-enabled where NOTHING could be read is a
    // different thing entirely and is refused: see the describe below.
    it('does not stop an alias being added to a different site', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([{ path: '/etc/apache2/sites-enabled/other.conf', text: 'ServerName other.com\n' }], [dangling])
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
    })

    // The readable files still have to be checked. Carrying on past the broken one must not also mean
    // carrying on past a real clash.
    it('still refuses an alias a readable file claims', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing(
            [{ path: '/etc/apache2/sites-enabled/legacy.conf', text: 'ServerName shop.acme.com\n' }],
            [dangling],
        )
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /legacy\.conf/)
    })

    it('does not stop an adopt of a site whose own file reads fine', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten], [dangling])
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, true)
        assert.equal(sent[0]!.disable[0], handWritten.path)
    })

    // The preview's whole job is to show what is actually in sites-enabled before it is replaced, and a
    // file nobody could open is exactly the sort of thing that pane exists to say: it is also what makes
    // Apache refuse the reload this adopt ends with.
    it('is reported by the preview, alongside the claims it did read', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten], [dangling])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.deepEqual(result.ok && result.preview.unreadable, [dangling])
        assert.equal(result.ok && result.preview.claims[0]!.path, handWritten.path)
    })

    // A file that could not be read is not a file that could not be parsed: adoptable is about what the
    // parser made of a claim, and this one never became a claim at all.
    it('does not on its own make the site unadoptable', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten], [dangling])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.adoptable, true)
    })

    it('leaves the preview saying so plainly when there is nothing unreadable', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = listing([handWritten])
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.preview.unreadable, [])
    })
})

// The regression test for the mount bug, and the one that would have caught it. sites-available was not
// mounted into the agent, so every relative symlink in sites-enabled dangled inside the container: five
// live sites listed, none of them readable, and every check below answered "nothing claims this
// hostname" with complete confidence. An empty sites-enabled and one hostd cannot read are the same
// value to all of this, and only one of them means what the guards read out of it.
describe('a sites-enabled where nothing at all could be read', () => {
    // What the dedi actually looked like: the five live sites, every one of them a broken link inside
    // the container and perfectly readable on the host.
    const blind = listing([], [
        '/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf',
        '/etc/apache2/sites-enabled/020-acme.com.conf',
    ])

    it('refuses an alias rather than reporting that no file claims the hostname', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = blind
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        // Nothing written, and no registry change either: the refusal is before both.
        assert.equal(sent.length, 0)
    })

    // Not bad-request: the call is fine and no rewording of it will help. api answers 503.
    it('refuses as unavailable, and says the mount rather than the site is at fault', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = blind
        const result = await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.equal(result.ok === false && result.code, 'unavailable')
        const message = result.ok === false ? result.message : ''
        assert.match(message, /could not read a single one of them/)
        assert.match(message, /a mount is missing rather than anything a site did/)
        assert.match(message, /cannot tell whether a hostname is already served/)
    })

    // The most convincing wrong answer hostd could give: an operator confirms the adopt because the
    // preview told them there was nothing there to displace.
    it('refuses the preview rather than showing a site with a live vhost as unclaimed', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = blind
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(result.ok === false && result.code, 'unavailable')
    })

    // The call that actually writes over a live site. Even with no paths to disable, which is precisely
    // what an operator would send after a preview that found nothing.
    it('refuses the adopt itself, including the empty-disable adopt the blind preview would produce', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = blind
        const result = await adopt(deps, project, environment, 'abc123', [])
        assert.equal(result.ok, false)
        assert.equal(sent.length, 0)
    })

    // Unchanged behaviour, stated as a test so it stays unchanged: a partly readable directory is still
    // acted on, because what was read is real.
    it('still proceeds on what it could read when at least one file read', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing(
            [{ path: '/etc/apache2/sites-enabled/other.conf', text: 'ServerName other.com\n' }],
            ['/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'],
        )
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
    })

    // And a directory that is genuinely empty is genuinely empty. A dedi with nothing hand-written on it
    // is an ordinary state, not a fault, and refusing there would block every first adoption.
    it('proceeds on an empty sites-enabled, which is a real answer rather than a blind one', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = listing([])
        const result = await setAliases(deps, project, environment, ['www.acme.com', 'shop.acme.com'], 'abc123')
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        const preview = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(preview.ok, true)
        assert.deepEqual(preview.ok && preview.preview.claims, [])
    })
})
