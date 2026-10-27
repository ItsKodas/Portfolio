// The agent's domain verb. It renders an environment's Nginx Proxy Manager hosts and asks edge to put
// them in place; edge is the only process that talks to NPM, and it refuses to touch any host that does
// not carry this environment's marker (adopt aside). Everything that decides what a site may serve
// stays here: the registry, the certificate, the claim checks.
//
// Undoing a failed write is edge's job now, not this file's: edge holds the state the host was in
// before, and answers ok: false only after putting it back. What is left here is the one case edge
// cannot settle, a reply that never arrived, where the write may or may not have happened.

import { hostnamesOf, type EnvironmentEntry, type NpmIds, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { refuse, type AdoptPreview, type DomainsWritten, type Refusal } from '../shared/protocol.ts'
import type { Change } from '../shared/registry-write.ts'
import { describeError } from '../shared/formats.ts'
import { ownerOf as ownerOfConfig, type FoundHost, type HostsSpec, type Owner, type ProxyHostSpec, type RedirectionHostSpec } from '../shared/edge-protocol.ts'
import type { EdgeClient } from './edge-client.ts'
import type { AdoptedStore } from './adopted-store.ts'
import { BROTLI, certificateFor, describeHosts, renderHosts, tokenFromHosts } from './npm-render.ts'

export type DomainsConfig = { upstreamHost: string, edgeHost: string, edgeHttpPort: number }

export type DomainsDeps = {
    edge: EdgeClient
    // The pre-adopt copy of each adopted proxy host, which is what restoreAdopted puts back
    adopted: AdoptedStore
    // The same RegistryWriter provisioning already uses, and a reload so the entry this just wrote is
    // what the hosts are rendered from. Rendering from the arguments instead would let a write that was
    // silently rejected still produce a host claiming the alias.
    writeRegistry(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
    reloadRegistry(): Promise<Registry>
    // Writes the environment's holding page now, so it is already there when NPM first falls back to
    // it. Optional, and its failure ignored: a host whose page is missing still serves the site, and the
    // main loop writes the page again on its next pass.
    refreshHoldingPage?(project: ProjectEntry, environment: EnvironmentEntry): Promise<void>
    config: DomainsConfig
}

type Done = { ok: true } | Refusal
type Applied = { ok: true, ids: NpmIds, previous: HostsSpec | null }
type Claim = AdoptPreview['preview']['claims'][number]

const ownerOf = (project: ProjectEntry, environment: EnvironmentEntry): Owner => ({ project: project.id, environment: environment.name })
const nameOf = (owner: Owner): string => `${owner.project} ${owner.environment}`
// What DomainsWritten carries as its path: the portal shows it, and api only ever stores it
const pathOf = (proxyHost: number): string => `npm:proxy-host/${proxyHost}`
// Hand-made hosts in NPM may carry names in any case, or with a trailing dot; the registry's never do.
const hostname = (name: string): string => name.toLowerCase().replace(/\.$/, '')
const sameOwner = (a: Owner | null, b: Owner): boolean => a !== null && a.project === b.project && a.environment === b.environment
const sameIds = (a: NpmIds | null, b: NpmIds | null): boolean =>
    a === b || (a !== null && b !== null && a.proxyHost === b.proxyHost && a.redirectionHost === b.redirectionHost)

function allDomains(spec: HostsSpec): string[] {
    return [...spec.proxy.domain_names, ...(spec.redirection?.domain_names ?? [])]
}

// Field by field, with the domain names as a set: NPM may hand them back in another order.
function sameSpec(a: ProxyHostSpec | RedirectionHostSpec, b: ProxyHostSpec | RedirectionHostSpec): boolean {
    const canonical = (spec: ProxyHostSpec | RedirectionHostSpec) => JSON.stringify(Object.entries(spec)
        .map(([key, value]) => [key, key === 'domain_names' ? (value as string[]).map(hostname).sort() : value])
        .sort(([left], [right]) => String(left).localeCompare(String(right))))
    return canonical(a) === canonical(b)
}

// Never throws: the page is a nicety on top of the hosts, and the domain change must not fail for it.
async function ensureHoldingPage(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry): Promise<void> {
    await deps.refreshHoldingPage?.(project, environment).catch(() => {})
}

// The certificate comes from a fresh read of the registry's certificates map rather than anything the
// caller holds, for the same reason the entry itself is reloaded before every write.
async function render(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, token: string): Promise<{ ok: true, spec: HostsSpec } | Refusal> {
    let certificateId: number | null = null
    if (!environment.flexibleSsl) {
        const chosen = certificateFor((await deps.reloadRegistry()).certificates, hostnamesOf(environment))
        if (!chosen.ok) return refuse('bad-request', chosen.problem)
        certificateId = chosen.id
    }
    return {
        ok: true,
        spec: renderHosts({
            id: project.id,
            environment: environment.name,
            primary: environment.domain!,
            aliases: environment.aliases,
            port: environment.port,
            flexibleSsl: environment.flexibleSsl,
            token,
            certificateId,
            upstreamHost: deps.config.upstreamHost,
            edgeHost: deps.config.edgeHost,
            edgeHttpPort: deps.config.edgeHttpPort,
        }),
    }
}

async function find(deps: DomainsDeps, domains: string[]): Promise<{ ok: true, hosts: FoundHost[] } | Refusal> {
    try {
        const reply = await deps.edge.call({ verb: 'find', domains })
        if (!reply.ok) return refuse('unavailable', `NPM could not be searched: ${reply.problem}`, reply.output)
        if (reply.verb !== 'find') return refuse('failed', `edge answered a find with ${reply.verb}`)
        return { ok: true, hosts: reply.hosts }
    } catch (error) {
        return refuse('unavailable', `NPM could not be searched: ${describeError(error)}`)
    }
}

function unknownOutcome(owner: Owner, why: string, again: string): Refusal {
    return refuse(
        'unavailable',
        `${why}, and NPM could not be read back either (${again}), so the change to the hosts for ${nameOf(owner)} `
        + 'may or may not have reached Nginx Proxy Manager. Check the hosts in NPM before trying again.',
    )
}

// edge answers only once its write queue reaches a request, and the client's timeout counts the time
// spent queued, so a reply that never came says nothing about whether the write happened: it may have
// landed, it may still be waiting, or it may have failed and been put back. NPM is read once to find
// out. Only hosts that match the spec exactly count as landed, and anything else is refused as
// unavailable with no ids recorded: guessing wrong either way would leave the registry naming hosts
// that are not there, or NPM holding marked hosts nothing names.
async function confirmApply(deps: DomainsDeps, owner: Owner, ids: NpmIds | null, spec: HostsSpec, error: unknown): Promise<Applied | Refusal> {
    const why = `edge did not answer (${describeError(error)})`
    const notYet = refuse(
        'unavailable',
        `${why}, and NPM does not show the change to the hosts for ${nameOf(owner)}. It may still be waiting behind `
        + 'another write, or it may have failed and been put back; check the hosts in NPM before trying again.',
    )
    // A known set of ids is read back directly, unless the write was to create a redirection host,
    // whose id only a search can find, or to release the proxy host (the adoption undo writes it back
    // without the marker), which get would then refuse as no longer this environment's.
    const releasing = !sameOwner(ownerOfConfig(spec.proxy.advanced_config), owner)
    if (ids !== null && !releasing && (ids.redirectionHost !== null || spec.redirection === null)) {
        let reply
        try {
            reply = await deps.edge.call({ verb: 'get', owner, ids })
        } catch (again) {
            return unknownOutcome(owner, why, describeError(again))
        }
        if (!reply.ok) return unknownOutcome(owner, why, reply.problem)
        if (reply.verb !== 'get') return unknownOutcome(owner, why, `edge answered a get with ${reply.verb}`)
        const current = reply.current
        if (current === null || !sameSpec(current.proxy, spec.proxy)) return notYet
        if (spec.redirection === null ? current.redirection !== null : current.redirection === null || !sameSpec(current.redirection, spec.redirection)) return notYet
        return { ok: true, ids: { proxyHost: ids.proxyHost, redirectionHost: spec.redirection === null ? null : ids.redirectionHost }, previous: null }
    }
    const found = await find(deps, allDomains(spec))
    if (!found.ok) return unknownOutcome(owner, why, found.message)
    // By id when there is one (a released host carries no marker to match on), by marker for a create
    const proxy = found.hosts.find(host => host.kind === 'proxy' && host.spec !== null && sameSpec(host.spec, spec.proxy)
        && (ids === null ? sameOwner(host.owner, owner) : host.id === ids.proxyHost))
    if (!proxy) return notYet
    let redirectionHost: number | null = null
    if (spec.redirection) {
        const wanted = spec.redirection
        const redirection = found.hosts.find(host => host.kind === 'redirection' && sameOwner(host.owner, owner) && host.spec !== null && sameSpec(host.spec, wanted))
        if (!redirection) return notYet
        redirectionHost = redirection.id
    } else if (found.hosts.some(host => host.kind === 'redirection' && sameOwner(host.owner, owner))) {
        // The redirection host this write deletes is still there
        return notYet
    }
    return { ok: true, ids: { proxyHost: proxy.id, redirectionHost }, previous: null }
}

async function apply(deps: DomainsDeps, owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean): Promise<Applied | Refusal> {
    let reply
    try {
        reply = await deps.edge.call({ verb: 'apply', owner, ids, spec, adopt })
    } catch (error) {
        return confirmApply(deps, owner, ids, spec, error)
    }
    // edge has already put back whatever it changed, so a refusal means the hosts are as they were
    if (!reply.ok) return refuse('failed', reply.problem, reply.output)
    if (reply.verb !== 'apply') return refuse('failed', `edge answered an apply with ${reply.verb}`)
    return { ok: true, ids: reply.ids, previous: reply.previous }
}

// The same question as confirmApply, for a removal: the hosts are gone or they are not.
async function remove(deps: DomainsDeps, owner: Owner, ids: NpmIds): Promise<Done> {
    let reply
    try {
        reply = await deps.edge.call({ verb: 'remove', owner, ids })
    } catch (error) {
        const why = `edge did not answer (${describeError(error)})`
        let current
        try {
            current = await deps.edge.call({ verb: 'get', owner, ids })
        } catch (again) {
            return unknownOutcome(owner, why, describeError(again))
        }
        if (!current.ok) return unknownOutcome(owner, why, current.problem)
        if (current.verb === 'get' && current.current === null) return { ok: true }
        return refuse(
            'unavailable',
            `${why}, and NPM still has the hosts for ${nameOf(owner)}. The removal may still be waiting behind another `
            + 'write; check the hosts in NPM before trying again.',
        )
    }
    if (!reply.ok) return refuse('failed', reply.problem, reply.output)
    return { ok: true }
}

// The registry is told whenever the ids changed, which is a create, or an update that made or removed
// the redirection host. A create whose ids cannot be recorded is taken back off NPM, because a marked
// host the registry does not name blocks every later write of those names.
async function recordIds(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, ids: NpmIds): Promise<Done> {
    if (sameIds(environment.npm, ids)) return { ok: true }
    const written = await deps.writeRegistry({ kind: 'set-npm', id: project.id, environment: environment.name, npm: ids })
    if (written.ok) return { ok: true }
    const owner = ownerOf(project, environment)
    const hosts = `NPM proxy host ${ids.proxyHost}${ids.redirectionHost === null ? '' : ` and redirection host ${ids.redirectionHost}`}`
    if (environment.npm !== null) {
        return refuse('failed', `the hosts for ${nameOf(owner)} were written, but the registry could not record their ids (${written.problem}); it should name ${hosts}`)
    }
    const removed = await remove(deps, owner, ids)
    return refuse(
        'failed',
        `the registry could not record the new hosts for ${nameOf(owner)} (${written.problem}), `
        + (removed.ok ? 'so they were removed again' : `and removing them again failed too (${removed.message}); delete ${hosts} in NPM`),
    )
}

export async function writeHosts(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there are no NPM hosts to write`)
    }
    const rendered = await render(deps, project, environment, token)
    if (!rendered.ok) return rendered
    const owner = ownerOf(project, environment)

    // A create, checked here as well as in edge so a name already on another NPM host is refused as the
    // operator's to sort out (adopt it, or remove it in NPM) before anything is written, rather than
    // coming back as a failed write. Usually that host is the hand-made one the site runs on today.
    if (environment.npm === null) {
        const found = await find(deps, hostnamesOf(environment))
        if (!found.ok) return found
        const host = found.hosts[0]
        if (host) {
            const kind = host.kind === 'dead' ? '404' : host.kind
            const names = host.domain_names.map(hostname)
            const name = hostnamesOf(environment).find(entry => names.includes(hostname(entry))) ?? environment.domain
            const why = sameOwner(host.owner, owner)
                ? `which carries the marker for ${nameOf(owner)} although the registry names no NPM hosts for it; delete it in NPM first`
                : `which hostd does not manage; adopt ${nameOf(owner)} from the Domains tab to take it over, or remove it in NPM`
            return refuse('bad-request', `${name} is already served by NPM ${kind} host ${host.id}, ${why}`)
        }
    }
    await ensureHoldingPage(deps, project, environment)

    const applied = await apply(deps, owner, environment.npm, rendered.spec, false)
    if (!applied.ok) return applied
    const recorded = await recordIds(deps, project, environment, applied.ids)
    if (!recorded.ok) return recorded
    return { ok: true, written: { hostnames: hostnamesOf(environment), path: pathOf(applied.ids.proxyHost) } }
}

// The hosts off NPM, with nothing written to the registry: for a whole project being removed, whose
// entry, ids and all, is already gone by the time this runs.
export async function removeEdgeHosts(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry): Promise<Done> {
    if (environment.npm === null) return { ok: true }
    return remove(deps, ownerOf(project, environment), environment.npm)
}

export async function removeHosts(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
): Promise<DomainsWritten | Refusal> {
    // Nothing hostd wrote, so nothing to take away: a hand-made host is never hostd's to delete
    if (environment.npm === null) return { ok: true, written: { hostnames: [], path: 'npm:none' } }
    const ids = environment.npm
    const removed = await remove(deps, ownerOf(project, environment), ids)
    if (!removed.ok) return removed
    const written = await deps.writeRegistry({ kind: 'set-npm', id: project.id, environment: environment.name, npm: null })
    if (!written.ok) {
        return refuse('failed', `the NPM hosts for ${project.id} ${environment.name} were removed, but the registry still names them: ${written.problem}`)
    }
    return { ok: true, written: { hostnames: [], path: pathOf(ids.proxyHost) } }
}

// Puts hosts back that a delete's undo read before removing them: a create from the spec as it was,
// which carries the marker already, and the new ids recorded, since NPM never reuses an id.
export async function recreateHosts(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, spec: HostsSpec): Promise<Done> {
    const applied = await apply(deps, ownerOf(project, environment), null, spec, false)
    if (!applied.ok) return applied
    return recordIds(deps, project, { ...environment, npm: null }, applied.ids)
}

// The token the environment's hosts carry now, or null when hostd wrote none. Throws when edge cannot
// say, so a caller never mistakes "could not read" for "nothing there".
export async function currentToken(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry): Promise<string | null> {
    if (environment.npm === null) return null
    const reply = await deps.edge.call({ verb: 'get', owner: ownerOf(project, environment), ids: environment.npm })
    if (!reply.ok) throw new Error(reply.problem)
    if (reply.verb !== 'get') throw new Error(`edge answered a get with ${reply.verb}`)
    return reply.current === null ? null : tokenFromHosts(reply.current)
}

// Add or remove an alias. The caller hands over the whole list the environment should end up with, so a
// retry after a half-failure lands in the same place rather than adding the same alias twice.
//
// The order is registry first, then hosts, and it matters. The registry is the record of what this site
// is entitled to serve; the hosts are a rendering of it. Writing the hosts first would mean a crash
// between the two left NPM serving a hostname no entry claims.
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
    // No maxDomains check. Adding a hostname is admin-only (see ADMIN_ONLY in api's policy.ts), and the
    // admin may give an environment as many as they like.

    // parseRegistry's uniqueness rule sees hostd's entries and nothing else, so it cannot know that an
    // NPM host made by hand already serves one of these names. edge would refuse the write anyway, but
    // only after the registry had taken the alias, so the check is made here first. Only the names being
    // added: the ones already on the environment were accepted once, and re-checking them would make
    // removing an unrelated alias impossible. The primary too while hostd has no hosts for it, because
    // this call creates them, and a hand-made host on the primary is a site still waiting to be adopted.
    const owner = ownerOf(project, environment)
    const added = aliases.filter(alias => !environment.aliases.includes(alias))
    const checking = environment.npm === null ? [environment.domain, ...added] : added
    if (checking.length > 0) {
        const found = await find(deps, checking)
        if (!found.ok) return found
        for (const host of found.hosts) {
            if (sameOwner(host.owner, owner)) continue
            const names = host.domain_names.map(hostname)
            const kind = host.kind === 'dead' ? '404' : host.kind
            if (environment.npm === null && names.includes(hostname(environment.domain))) {
                return refuse(
                    'bad-request',
                    `${environment.domain} is still served by NPM ${kind} host ${host.id}, which hostd does not manage; adopt ${project.id} ${environment.name} first`,
                )
            }
            const clashing = added.filter(name => names.includes(hostname(name)))
            return refuse('bad-request', `${clashing.join(', ')} is already on NPM ${kind} host ${host.id}, which this environment does not own; remove it there first`)
        }
    }

    const written = await deps.writeRegistry({ kind: 'set-aliases', id: project.id, environment: environment.name, aliases })
    if (!written.ok) return refuse('failed', `the registry could not be updated: ${written.problem}`)

    // Re-read rather than trusting the write: parseRegistry is what enforces reserved, the allowed
    // carve-out and cross-project uniqueness, and a list that passed the grammar can still fail those.
    const registry = await deps.reloadRegistry()
    const fresh = registry.projects.get(project.id)?.environments.get(environment.name)
    if (!fresh) return refuse('failed', `${project.id} ${environment.name} did not survive the change`)
    return writeHosts(deps, registry.projects.get(project.id)!, fresh, token)
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

// A found host in the same plain lines describeHosts gives the proposal, so the two read side by side.
function describeFound(host: FoundHost): string {
    if (host.kind === 'proxy' && host.spec !== null) return describeHosts({ proxy: host.spec as ProxyHostSpec, redirection: null })
    if (host.kind === 'redirection' && host.spec !== null) {
        const spec = host.spec as RedirectionHostSpec
        return [
            'Redirection host',
            `Domains: ${spec.domain_names.join(', ')}`,
            `Redirects to: ${spec.forward_domain_name}`,
            `Certificate: ${spec.certificate_id === 0 ? 'none' : spec.certificate_id}`,
            `SSL forced: ${yesNo(spec.ssl_forced)}`,
            `HTTP/2: ${yesNo(spec.http2_support)}`,
            'Advanced config:',
            ...spec.advanced_config.trimEnd().split('\n').map(line => `    ${line}`),
        ].join('\n')
    }
    return ['404 host', `Domains: ${host.domain_names.join(', ')}`].join('\n')
}

function claimPath(host: FoundHost): string {
    return `NPM ${host.kind === 'dead' ? 'dead' : host.kind} host ${host.id}`
}

// Every reason one found host cannot be adopted, all of them at once: the operator fixes them by hand in
// NPM, and being told one per attempt is how an adoption takes an afternoon. edge re-checks the ones that
// guard live sites (marker, upstream, locations, access list, directives) when adopt writes.
function reasonsFor(deps: DomainsDeps, owner: Owner, environment: EnvironmentEntry, found: FoundHost[], host: FoundHost, extraNames: string[]): string[] {
    const reasons: string[] = []
    if (found.length > 1) {
        reasons.push(`${found.length} NPM hosts serve these names (${found.map(claimPath).join(', ')}); hostd adopts a single proxy host, so leave only one in NPM first.`)
    }
    if (host.owner !== null && !sameOwner(host.owner, owner)) {
        reasons.push(`It carries the marker for ${host.owner.project}/${host.owner.environment}, so it is already managed by hostd for that environment.`)
    }
    if (host.kind === 'redirection') {
        reasons.push('It is a redirection host; hostd adopts the proxy host and makes its own redirection host for the aliases.')
        return reasons
    }
    if (host.kind === 'dead') {
        reasons.push('It is a 404 host, which serves nothing hostd could take over.')
        return reasons
    }
    if (!host.domain_names.map(hostname).includes(hostname(environment.domain!))) reasons.push(`It does not serve ${environment.domain}.`)
    const forward = `${host.forward_host}:${host.forward_port}`
    const wanted = `${deps.config.upstreamHost}:${environment.port}`
    if (forward !== wanted) reasons.push(`It forwards to ${forward}, not ${wanted}.`)
    if (host.hasLocations) reasons.push('It has custom locations, which hostd would drop.')
    // The template replaces advanced_config whole, so anything in it but the brotli snippet every live
    // host carries would be lost without a word. A host already marked for this environment is hostd's
    // own rendering, so there is nothing of Koda's in it to lose.
    if (host.owner === null && host.spec !== null) {
        const config = host.spec.advanced_config.replace(/\r\n/g, '\n').trim()
        if (config !== '' && config !== BROTLI) {
            reasons.push(`It has custom nginx directives: ${config.split('\n', 1)[0]!.trim()} (move them out in NPM, or leave this host to be managed by hand).`)
        }
    }
    const extra = extraNames.filter(name => host.domain_names.map(hostname).includes(name))
    if (extra.length > 0) reasons.push(`${extra.join(', ')} are on the NPM host but not in the registry; add them as aliases first.`)
    return reasons
}

type Survey = { spec: HostsSpec, found: FoundHost[], claims: Claim[], extraNames: string[], adoptable: boolean }

// What preview shows and adopt re-checks, read fresh from NPM each time: a preview may be minutes old
// by the time the operator confirms it.
async function survey(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, token: string): Promise<{ ok: true, survey: Survey } | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is nothing to adopt`)
    }
    const rendered = await render(deps, project, environment, token)
    if (!rendered.ok) return rendered
    const hostnames = hostnamesOf(environment)
    const searched = await find(deps, hostnames)
    if (!searched.ok) return searched
    const found = searched.hosts
    // Adopt takes over a host that exists; with none, the site is made through the ordinary write instead
    if (found.length === 0) return refuse('bad-request', `no NPM proxy host serves ${environment.domain}`)

    // Names the old host serves that the registry has never heard of. Refused rather than dropped:
    // adopting without them would silently stop serving hostnames that work today.
    const listed = hostnames.map(hostname)
    const extraNames = [...new Set(found.filter(host => host.kind === 'proxy').flatMap(host => host.domain_names.map(hostname)))]
        .filter(name => !listed.includes(name))
    const owner = ownerOf(project, environment)
    const claims = found.map(host => ({
        path: claimPath(host),
        text: describeFound(host),
        names: host.domain_names,
        unsupported: reasonsFor(deps, owner, environment, found, host, extraNames),
    }))
    const adoptable = found.length === 1 && found[0]!.kind === 'proxy' && claims[0]!.unsupported.length === 0
    return { ok: true, survey: { spec: rendered.spec, found, claims, extraNames, adoptable } }
}

// Reading only. Nothing here writes to NPM or the registry: an operator has to see what they are
// replacing before any of it happens, and that is the whole reason adoption is two calls.
export async function previewAdopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<AdoptPreview | Refusal> {
    const surveyed = await survey(deps, project, environment, token)
    if (!surveyed.ok) return surveyed
    const { spec, claims, extraNames, adoptable } = surveyed.survey
    return {
        ok: true,
        preview: {
            proposed: describeHosts(spec),
            claims,
            extraNames,
            // Nothing in NPM is unreadable the way a broken sites-enabled symlink was; kept for the portal
            unreadable: [],
            adoptable,
            // The environment's own flag. Adopting no longer switches it: NPM serves the existing hosts
            // with a certificate and Force SSL, and the registry is corrected by hand before adoption.
            flexibleSsl: environment.flexibleSsl,
        },
    }
}

// disable is what the Apache design moved aside; with NPM the one host to take over is found here, so
// it is accepted for the wire's sake and not used.
export async function adopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
    _disable: string[],
): Promise<DomainsWritten | Refusal> {
    if (environment.npm !== null) {
        return refuse('bad-request', `${project.id} ${environment.name} is already managed by hostd (NPM proxy host ${environment.npm.proxyHost}), so there is nothing to adopt`)
    }
    const surveyed = await survey(deps, project, environment, token)
    if (!surveyed.ok) return surveyed
    const { spec, found, claims, adoptable } = surveyed.survey
    if (!adoptable) {
        const reasons = claims.filter(claim => claim.unsupported.length > 0).map(claim => `${claim.path} cannot be adopted: ${claim.unsupported.join(' ')}`)
        return refuse('bad-request', reasons.join(' '))
    }
    const host = found[0]!
    await ensureHoldingPage(deps, project, environment)

    // The same proxy host id, so NPM's own logs and stats for it carry on; edge makes the redirection
    // host for the aliases, taking them off the proxy host first.
    const owner = ownerOf(project, environment)
    const applied = await apply(deps, owner, { proxyHost: host.id, redirectionHost: null }, spec, true)
    if (!applied.ok) return applied

    // edge's own copy of what it replaced, read inside its write queue, is the better one; the survey's
    // is only for a reply that never arrived but was confirmed by reading NPM back.
    const previous = applied.previous ?? { proxy: host.spec as ProxyHostSpec, redirection: null }
    const problems: string[] = []
    try {
        await deps.adopted.save(owner, { ids: applied.ids, previous })
    } catch (error) {
        problems.push(`the copy of NPM proxy host ${host.id} as it was could not be saved (${describeError(error)}), so this adoption cannot be undone from the portal`)
    }
    // Recorded even when the copy could not be saved: the hosts carry the marker now, and without their
    // ids in the registry hostd could neither update nor remove them.
    const recorded = await recordIds(deps, project, environment, applied.ids)
    if (!recorded.ok) problems.push(recorded.message)
    if (problems.length > 0) return refuse('failed', `${project.id} ${environment.name} was adopted, but ${problems.join('; and ')}`)
    return { ok: true, written: { hostnames: hostnamesOf(environment), path: pathOf(applied.ids.proxyHost) } }
}

// Adoption undone: the proxy host goes back to the fields Koda made it with, without the marker, so
// hostd no longer owns it, and the redirection host hostd made goes away because the spec has none.
// edge's guard passes because it checks the hosts as they are now, which the adopt marked. This is the
// rollback api reaches for when the hostname stops answering after an adopt.
//
// restore was the list of files to move back under Apache; it is accepted for the wire's sake.
export async function restoreAdopted(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    _restore: string[],
): Promise<DomainsWritten | Refusal> {
    const owner = ownerOf(project, environment)
    const saved = await deps.adopted.read(owner)
    if (!saved) return refuse('bad-request', `there is no adoption of ${project.id} ${environment.name} to undo`)
    if (environment.npm === null) return refuse('bad-request', `hostd holds no NPM hosts for ${project.id} ${environment.name}, so there is no adoption to undo`)
    // The saved copy belongs to one proxy host. Written onto another it would replace a host it never was.
    if (environment.npm.proxyHost !== saved.ids.proxyHost) {
        return refuse(
            'bad-request',
            `the saved copy is of NPM proxy host ${saved.ids.proxyHost}, but ${project.id} ${environment.name} is now NPM proxy host ${environment.npm.proxyHost}, so it was not put back`,
        )
    }

    const applied = await apply(deps, owner, environment.npm, { proxy: saved.previous.proxy, redirection: null }, false)
    if (!applied.ok) return { ...applied, message: `NPM proxy host ${saved.ids.proxyHost} could not be put back as it was: ${applied.message}` }
    const written = await deps.writeRegistry({ kind: 'set-npm', id: project.id, environment: environment.name, npm: null })
    if (!written.ok) {
        return refuse('failed', `NPM proxy host ${saved.ids.proxyHost} was put back as it was, but the registry still names it: ${written.problem}`)
    }
    // A record left behind is harmless: the next adopt overwrites it, and an undo without ids refuses.
    await deps.adopted.clear(owner).catch(() => {})
    // No hostnames: hostd serves nothing for this environment now, and saying otherwise would start a
    // verification countdown against hosts it no longer owns.
    return { ok: true, written: { hostnames: [], path: pathOf(saved.ids.proxyHost) } }
}
