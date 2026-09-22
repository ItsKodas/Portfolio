// The agent's domain verb. It renders a vhost, puts it on the host through the rail, and puts the
// previous one back when Apache refuses the result.
//
// Reverting is here rather than in the host unit because this is what knows the previous contents. On a
// failed configtest nothing has reloaded, so the running configuration is still good; what is dangerous
// is the bad file sitting on disk, which the next unrelated reload or a reboot would pick up.

import { posix } from 'node:path'
import { hostnamesOf, type EnvironmentEntry, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { refuse, type AdoptPreview, type DomainsWritten, type Refusal } from '../shared/protocol.ts'
import type { Change } from '../shared/registry-write.ts'
import type { ApacheRail } from './apache-rail.ts'
import { findClaims, type SitesEnabled } from './sites-enabled.ts'
import { renderVhost, vhostPath } from './vhost.ts'

export type DomainsConfig = {
    includeDir: string
    sitesEnabled: string
    originCert: string
    originKey: string
    acmeWebroot: string
    maintenanceFlagDir: string
    maintenancePageDir: string
}

export type DomainsDeps = {
    rail: Pick<ApacheRail, 'send'>
    // null rather than a throw when the file is not there: a first write has no previous file, and that
    // is the ordinary case rather than an error.
    readFile(path: string): Promise<string | null>
    // Both halves of the sweep: the files that were read, and the paths of any that could not be. A
    // file nobody can open claims no hostname, so it never blocks a write, but the caller is told about
    // it rather than left to believe sites-enabled held nothing else.
    listSitesEnabled(): Promise<SitesEnabled>
    // The same RegistryWriter provisioning already uses, and a reload so the entry this just wrote is
    // what the vhost is rendered from. Rendering from the arguments instead would let a write that was
    // silently rejected still produce a vhost claiming the alias.
    writeRegistry(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
    reloadRegistry(): Promise<Registry>
    config: DomainsConfig
}

function render(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, token: string): string {
    return renderVhost({
        id: project.id,
        environment: environment.name,
        primary: environment.domain!,
        aliases: environment.aliases,
        port: environment.port,
        token,
        certificate: { chain: deps.config.originCert, key: deps.config.originKey },
        maintenanceDir: deps.config.maintenancePageDir,
        maintenanceFlag: posix.join(deps.config.maintenanceFlagDir, `${project.id}-${environment.name}`),
        acmeWebroot: deps.config.acmeWebroot,
    })
}

// Put back what was there, or take away what was just put down. Either way a second reload follows, so
// that the configuration on disk is known to pass a configtest before this returns.
async function revert(deps: DomainsDeps, path: string, previous: string | null): Promise<string> {
    const parts = previous === null
        ? { write: null, remove: [path], disable: [] }
        : { write: { path, text: previous }, remove: [], disable: [] }
    try {
        const result = await deps.rail.send('reload', parts)
        return result.ok ? '' : ` The previous configuration could not be restored either: ${result.output}`
    } catch (error) {
        return ` The previous configuration could not be restored either: ${error instanceof Error ? error.message : String(error)}`
    }
}

export async function writeVhost(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is no vhost to write`)
    }
    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const text = render(deps, project, environment, token)

    const result = await deps.rail.send('reload', { write: { path, text }, remove: [], disable: [] })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the new configuration for ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames: hostnamesOf(environment), path } }
}

export async function removeVhost(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
): Promise<DomainsWritten | Refusal> {
    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const result = await deps.rail.send('reload', { write: null, remove: [path], disable: [] })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the configuration without ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames: [], path } }
}

// Add or remove an alias. The caller hands over the whole list the environment should end up with, so a
// retry after a half-failure lands in the same place rather than adding the same alias twice.
//
// The order is registry first, then vhost, and it matters. The registry is the record of what this site
// is entitled to serve; the vhost is a rendering of it. Writing the vhost first would mean a crash
// between the two left Apache serving a hostname no entry claims, which is the one state nothing else in
// hostd knows how to correct.
export async function setAliases(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    aliases: string[],
    token: string,
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so it cannot have aliases`)
    }
    if (aliases.includes(environment.domain)) {
        return refuse('bad-request', `${environment.domain} is already this environment's domain`)
    }
    // The project's own cap, which the grammar's blanket ceiling could not know.
    if (1 + aliases.length > project.maxDomains) {
        return refuse('bad-request', `${project.id} allows at most ${project.maxDomains} hostnames per environment`)
    }

    // parseRegistry's own uniqueness rule sees hostd's entries and nothing else, so it cannot know that a
    // hand-written vhost in sites-enabled already serves one of these hostnames; findClaims is what does.
    // Two vhosts claiming one name is not an error Apache refuses: it warns about the overlap, starts
    // anyway, and which one answers depends on the order the files loaded. Every refusal here names the
    // file, because the operator's next move is to adopt it or edit it, and neither is possible without
    // knowing which one it is.
    // Only the files that were read. An unreadable one is Apache serving nothing from that path, so it
    // cannot be claiming a hostname and it must not stop this write; /health is where it is raised,
    // because it is a problem with the server rather than with this site.
    const { files: sitesEnabled } = await deps.listSitesEnabled()

    // The primary first, and it is checked on every call rather than only when something is being added.
    // This path does not merely register a name: it writes a whole vhost, and that vhost claims the
    // primary too. A site that has never been adopted still has a hand-written file serving its primary,
    // which is the state all five existing sites are in, so adding a first alias to one of them would
    // put a second vhost on the same hostname and let include order decide which of the two answers. If
    // hostd's won, the site would silently lose whatever the hand-written file carried, a custom
    // rewrite, basic auth, a bespoke error page, which is exactly what adopt's preview exists to put in
    // front of the operator before it happens.
    //
    // This guard is not authoritative and must not be read as though it were. It sees sites-enabled as it
    // is on disk right now; Apache is serving the configuration it loaded the last time it was reloaded,
    // which may be an older view of the same directory. In the window where a symlink has been deleted
    // but Apache has not reloaded since, the file is gone from this reading while the hostname it names
    // is still genuinely being served, so this passes and the vhost is written anyway. Nothing bad
    // reaches production when that happens: the rail's own apache2ctl configtest fails on the dangling
    // entry and writeVhost puts the previous file back. The cost is only that the operator gets Apache's
    // words about a configuration it refused instead of the purpose-built refusal below, which would have
    // named the file and told them to adopt. Closing the race would mean asking Apache what it currently
    // has loaded rather than reading the directory, which is a much larger thing than this check is.
    const primaryClaim = findClaims(sitesEnabled, [environment.domain])[0]
    if (primaryClaim) {
        return refuse(
            'bad-request',
            `${environment.domain} is still served by ${primaryClaim.path}, so writing a vhost for it here would leave two claiming it; adopt ${project.id} ${environment.name} first, which moves that file aside in the same reload`,
        )
    }

    // The aliases, and only the ones being added. Names already on the environment were accepted once,
    // and re-checking them would make removing an unrelated alias impossible, since set-aliases carries
    // the whole resulting list rather than one name and a direction.
    const added = aliases.filter(alias => !environment.aliases.includes(alias))
    if (added.length > 0) {
        const claim = findClaims(sitesEnabled, added)[0]
        if (claim) {
            const clashing = claim.names.filter(name => added.includes(name))
            return refuse('bad-request', `${clashing.join(', ')} is already served by ${claim.path}; adopt or edit that file first`)
        }
    }

    const written = await deps.writeRegistry({
        kind: 'set-aliases', id: project.id, environment: environment.name, aliases,
    })
    if (!written.ok) return refuse('failed', `the registry could not be updated: ${written.problem}`)

    // Re-read rather than trusting the write: parseRegistry is what enforces reserved, the allowed
    // carve-out and cross-project uniqueness, and a list that passed the grammar can still fail those.
    const registry = await deps.reloadRegistry()
    const fresh = registry.projects.get(project.id)?.environments.get(environment.name)
    if (!fresh) {
        return refuse('failed', `${project.id} ${environment.name} did not survive the change`)
    }
    return writeVhost(deps, registry.projects.get(project.id)!, fresh, token)
}

// Reading only. Nothing here moves a file or reloads anything: an operator has to see what they are
// replacing before any of it happens, and that is the whole reason adoption is two calls.
export async function previewAdopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<AdoptPreview | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is nothing to adopt`)
    }
    const hostnames = hostnamesOf(environment)
    const { files, unreadable } = await deps.listSitesEnabled()
    const claims = findClaims(files, hostnames)
    // Names the old file serves that the registry has never heard of. Offered rather than taken: adopting
    // without carrying these across would silently stop serving hostnames that work today, and adding
    // them automatically would put hostnames in the registry nobody asked for.
    const extraNames = [...new Set(claims.flatMap(claim => claim.names))].filter(name => !hostnames.includes(name))
    return {
        ok: true,
        preview: {
            proposed: render(deps, project, environment, token),
            claims,
            extraNames,
            // Carried even though none of it can be a claim. This pane's whole job is to show what is
            // actually in sites-enabled before it is replaced, and "there is a file here nobody could
            // open" is exactly the sort of thing an operator should see before confirming, not least
            // because Apache will refuse the reload the adopt ends with while it is there.
            unreadable,
            adoptable: claims.every(claim => claim.unsupported === null),
        },
    }
}

export async function adopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
    disable: string[],
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is nothing to adopt`)
    }
    const hostnames = hostnamesOf(environment)
    // Only the files that were read, for the same reason as in setAliases: an unreadable file serves
    // nothing, so it claims nothing, and it cannot be one of the paths api asked to have disabled.
    const claims = findClaims((await deps.listSitesEnabled()).files, hostnames)

    // Every named file has to be one this environment's hostnames actually reach. api chose these from a
    // preview, and the preview could be minutes old, so the claim is re-established here against the
    // files as they are now rather than trusted from the request.
    for (const path of disable) {
        const claim = claims.find(entry => entry.path === path)
        if (!claim) return refuse('bad-request', `${path} does not serve any hostname of ${project.id} ${environment.name}`)
        if (claim.unsupported) return refuse('bad-request', `${path} cannot be read well enough to adopt: ${claim.unsupported}`)
    }

    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const text = render(deps, project, environment, token)

    // One request, so the new file arrives and the old one leaves before the single configtest. Two
    // requests would mean a moment with both files loaded, where Apache picks one by file order, or a
    // moment with neither.
    const result = await deps.rail.send('adopt', { write: { path, text }, remove: [], disable })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the configuration adopting ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames, path } }
}
