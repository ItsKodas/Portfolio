// Drift: an NPM host hostd owns whose current state is not what hostd would write for it now, because
// someone edited it in NPM's UI. Health reports it so the next domain action's overwrite is no surprise.
// Read-only: nothing here writes to NPM. Never throws; edge being unreachable is itself one warning.

import { hostnamesOf, type EnvironmentEntry, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import type { HostsSpec, ProxyHostSpec, RedirectionHostSpec } from '../shared/edge-protocol.ts'
import type { EdgeClient } from './edge-client.ts'
import type { DomainsConfig } from './domains.ts'
import { aliasCertificates, renderHosts, tokenFromHosts } from './npm-render.ts'

const name = (project: ProjectEntry, environment: EnvironmentEntry): string => `${project.id} ${environment.name}`
// Hand-made hosts may carry names in any case or with a trailing dot; the registry's never do.
const hostname = (value: string): string => value.toLowerCase().replace(/\.$/, '')

// The names of the fields whose values differ. Domain names compare as a set, since NPM may hand them
// back in another order.
function differing(current: ProxyHostSpec | RedirectionHostSpec, wanted: ProxyHostSpec | RedirectionHostSpec): string[] {
    const fields: string[] = []
    const left = current as Record<string, unknown>
    const right = wanted as Record<string, unknown>
    for (const key of Object.keys(right)) {
        const same = key === 'domain_names'
            ? JSON.stringify((left[key] as string[]).map(hostname).sort()) === JSON.stringify((right[key] as string[]).map(hostname).sort())
            : left[key] === right[key]
        if (!same) fields.push(key)
    }
    return fields
}

async function driftOf(
    registry: Registry, edge: EdgeClient, config: DomainsConfig, project: ProjectEntry, environment: EnvironmentEntry,
): Promise<string[]> {
    const ids = environment.npm
    if (ids === null || environment.domain === null) return []
    const who = name(project, environment)
    const reply = await edge.call({ verb: 'get', owner: { project: project.id, environment: environment.name }, ids })
    if (!reply.ok) return [`NPM hosts for ${who} cannot be read as hostd's own: ${reply.problem}`]
    if (reply.verb !== 'get') return [`edge answered a get for ${who} with ${reply.verb}`]
    const current = reply.current
    if (current === null) return [`NPM proxy host ${ids.proxyHost} for ${who} is missing`]

    // The token comes off the host itself, so a token is never invented here. Without one there is
    // nothing to render the verification location from, which is a departure from the template too.
    const token = tokenFromHosts(current)
    if (token === null) return [`NPM proxy host ${ids.proxyHost} for ${who} no longer carries its verification token`]

    // The same split of the aliases writeHosts makes, so the flexible host is compared against its render
    let certificateId: number | null = null
    let aliases = environment.aliases
    let flexibleAliases: string[] = []
    if (!environment.flexibleSsl) {
        const chosen = aliasCertificates(registry.certificates, environment.domain, environment.aliases)
        if (!chosen.ok) return [`NPM hosts for ${who} cannot be compared: ${chosen.problem}`]
        certificateId = chosen.id
        aliases = chosen.covered
        flexibleAliases = chosen.flexible
    }
    const wanted: HostsSpec = renderHosts({
        id: project.id, environment: environment.name, primary: environment.domain, aliases, flexibleAliases,
        port: environment.port, flexibleSsl: environment.flexibleSsl, token, certificateId,
        upstreamHost: config.upstreamHost, edgeHost: config.edgeHost, edgeHttpPort: config.edgeHttpPort,
    })

    const warnings: string[] = []
    const proxyFields = differing(current.proxy, wanted.proxy)
    if (proxyFields.length) warnings.push(`NPM proxy host ${ids.proxyHost} for ${who} was edited in NPM and differs from what hostd would write: ${proxyFields.join(', ')}`)
    if (wanted.redirection !== null && current.redirection === null) {
        warnings.push(`NPM redirection host for ${who} is missing, so its aliases are not redirected`)
    } else if (wanted.redirection === null && current.redirection !== null) {
        warnings.push(`NPM redirection host ${ids.redirectionHost} for ${who} exists but the environment has no aliases`)
    } else if (wanted.redirection !== null && current.redirection !== null) {
        const fields = differing(current.redirection, wanted.redirection)
        if (fields.length) warnings.push(`NPM redirection host ${ids.redirectionHost} for ${who} was edited in NPM and differs from what hostd would write: ${fields.join(', ')}`)
    }
    const wantedFlexible = wanted.flexibleRedirection ?? null
    const currentFlexible = current.flexibleRedirection ?? null
    const flexibleId = ids.flexibleRedirectionHost ?? null
    if (wantedFlexible !== null && currentFlexible === null) {
        warnings.push(`NPM flexible redirection host for ${who} is missing, so its flexible aliases are not redirected`)
    } else if (wantedFlexible === null && currentFlexible !== null) {
        warnings.push(`NPM flexible redirection host ${flexibleId} for ${who} exists but the environment has no flexible aliases`)
    } else if (wantedFlexible !== null && currentFlexible !== null) {
        const fields = differing(currentFlexible, wantedFlexible)
        if (fields.length) warnings.push(`NPM flexible redirection host ${flexibleId} for ${who} was edited in NPM and differs from what hostd would write: ${fields.join(', ')}`)
    }
    return warnings
}

export async function driftWarnings(registry: Registry, edge: EdgeClient, config: DomainsConfig): Promise<string[]> {
    const warnings: string[] = []
    try {
        const owners = new Map<string, { project: ProjectEntry, environment: EnvironmentEntry }>()
        const known = new Set<string>()
        for (const project of registry.projects.values()) {
            for (const environment of project.environments.values()) {
                for (const host of hostnamesOf(environment)) owners.set(hostname(host), { project, environment })
                warnings.push(...await driftOf(registry, edge, config, project, environment))
                if (environment.npm !== null) {
                    known.add(`proxy ${environment.npm.proxyHost}`)
                    if (environment.npm.redirectionHost !== null) known.add(`redirection ${environment.npm.redirectionHost}`)
                    const flexible = environment.npm.flexibleRedirectionHost ?? null
                    if (flexible !== null) known.add(`redirection ${flexible}`)
                }
            }
        }
        if (owners.size === 0) return warnings
        // A second kind of drift: a host hostd does not manage answering for a name the registry gave to
        // a site. It is checked for every environment, including ones hostd has not written hosts for.
        const reply = await edge.call({ verb: 'find', domains: [...owners.keys()] })
        if (!reply.ok) return [...warnings, `NPM could not be searched for hosts hostd does not manage: ${reply.problem}`]
        if (reply.verb !== 'find') return [...warnings, `edge answered a find with ${reply.verb}`]
        for (const host of reply.hosts) {
            // Hosts hostd has ids for were reported above, by the read that found them unowned
            if (host.owner !== null || known.has(`${host.kind} ${host.id}`)) continue
            const served = host.domain_names.map(hostname).filter(served => owners.has(served))
            if (served.length === 0) continue
            const claimed = owners.get(served[0]!)!
            warnings.push(
                `NPM ${host.kind} host ${host.id} serves ${served.join(', ')}, which belongs to ${name(claimed.project, claimed.environment)}, but hostd does not manage it`,
            )
        }
        return warnings
    } catch (error) {
        return [`NPM could not be checked for drift: ${describeError(error)}`]
    }
}
