// Which of the registry's services one environment actually runs. The registry lists a site's services
// once, and they describe live: the storage guard holds live's compose file to every one of them. Any
// other environment runs whatever its own branch's compose file declares, and a branch may run fewer (a
// main branch that still points at an outside database, say). Anything that looks at an environment's
// services by name, the deploy health check and a copy, asks this first, so a service the branch does
// not have is "not in this environment" rather than a container that failed to start.
//
// A commit that renames the site's service (geoguesser to mappies, say) leaves the registry naming a
// service no compose file has any more. Read strictly, that environment would have no site at all, and
// every deploy of the rename would fail its health check and roll back to the copy from before it, for
// ever, until someone edited the registry by hand. So when none of the registry's site services is
// declared, the compose services the registry does not list at all stand in for them, guessed exactly as
// enrolling the project would have guessed them (compose.ts's guessRole), databases left out. A live
// deploy that comes up healthy that way then writes the new names into the registry (deploy.ts), so the
// rest of hostd, which reads the registry's names, follows the rename too.

import { isComposeService, type ProjectEntry, type ServiceEntry } from '../shared/registry.ts'
import { guessRole, resolveCompose, type ComposeLocation, type ResolvedCompose, type Runner } from './compose.ts'

export type EnvironmentServices = Record<string, ServiceEntry>

// sqlite is kept whatever the compose file says: it is a file the site opens, never a compose service.
export function declaredServices(project: ProjectEntry, resolved: ResolvedCompose): EnvironmentServices {
    const services: EnvironmentServices = {}
    for (const [name, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry) || Object.hasOwn(resolved.services, name)) services[name] = entry
    }
    for (const name of standInSites(project, resolved)) services[name] = { role: 'site' }
    return services
}

// The compose services standing in for a site service the registry names and the compose file no longer
// has: empty while any of the registry's site services is still declared, which is every ordinary deploy.
export function standInSites(project: ProjectEntry, resolved: ResolvedCompose): string[] {
    const sites = Object.keys(project.services).filter(name => project.services[name]!.role === 'site')
    if (sites.some(name => Object.hasOwn(resolved.services, name))) return []
    return Object.keys(resolved.services)
        .filter(name => !Object.hasOwn(project.services, name) && guessRole(resolved.services[name]!).role === 'site')
}

// How the registry's site services differ from the ones an environment was checked against: the ones its
// compose file no longer declares, and the stand-ins it declares instead. Databases are never in either
// list. A database that disappears from the compose file is a question for the operator (its backups and
// its storage depend on the name), not something a deploy should quietly rewrite.
export function siteDrift(project: ProjectEntry, declared: EnvironmentServices): { removed: string[], added: string[] } {
    const removed = Object.keys(project.services)
        .filter(name => project.services[name]!.role === 'site' && !Object.hasOwn(declared, name))
    const added = Object.keys(declared).filter(name => !Object.hasOwn(project.services, name))
    return { removed, added }
}

// An environment none of whose site services is running has nothing to serve, so a check that would
// otherwise pass on having nothing to look at must fail instead.
export function missingSiteProblem(project: ProjectEntry, services: EnvironmentServices): string | null {
    if (Object.values(services).some(entry => entry.role === 'site')) return null
    const sites = Object.keys(project.services).filter(name => project.services[name]!.role === 'site')
    return `none of the registry's site services (${sites.join(', ')}) is in this environment's compose file`
}

export async function environmentServices(
    project: ProjectEntry, location: ComposeLocation, run: Runner,
): Promise<{ ok: true, services: EnvironmentServices } | { ok: false, problem: string }> {
    const resolved = await resolveCompose(location, run)
    if (!resolved.ok) return { ok: false, problem: `the environment's compose file could not be read: ${resolved.problem}` }
    return { ok: true, services: declaredServices(project, resolved.resolved) }
}
