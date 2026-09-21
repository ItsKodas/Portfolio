// The agent's domain verb. It renders a vhost, puts it on the host through the rail, and puts the
// previous one back when Apache refuses the result.
//
// Reverting is here rather than in the host unit because this is what knows the previous contents. On a
// failed configtest nothing has reloaded, so the running configuration is still good; what is dangerous
// is the bad file sitting on disk, which the next unrelated reload or a reboot would pick up.

import { posix } from 'node:path'
import { hostnamesOf, type EnvironmentEntry, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { Change } from '../shared/registry-write.ts'
import type { ApacheRail } from './apache-rail.ts'
import { findClaims, type VhostFile } from './sites-enabled.ts'
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
    listSitesEnabled(): Promise<VhostFile[]>
    // The same RegistryWriter provisioning already uses, and a reload so the entry this just wrote is
    // what the vhost is rendered from. Rendering from the arguments instead would let a write that was
    // silently rejected still produce a vhost claiming the alias.
    writeRegistry(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
    reloadRegistry(): Promise<Registry>
    config: DomainsConfig
}

export type DomainsWritten = { ok: true, written: { hostnames: string[], path: string } }

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

export type AdoptPreview = {
    ok: true
    preview: {
        proposed: string
        claims: { path: string, names: string[], unsupported: string | null }[]
        extraNames: string[]
        adoptable: boolean
    }
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
    const claims = findClaims(await deps.listSitesEnabled(), hostnames)
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
    const claims = findClaims(await deps.listSitesEnabled(), hostnames)

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
