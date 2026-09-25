// Which of the registry's services one environment actually runs. The registry lists a site's services
// once, and they describe live: the storage guard holds live's compose file to every one of them. Any
// other environment runs whatever its own branch's compose file declares, and a branch may run fewer (a
// main branch that still points at an outside database, say). Anything that looks at an environment's
// services by name, the deploy health check and a copy, asks this first, so a service the branch does
// not have is "not in this environment" rather than a container that failed to start.

import { isComposeService, type ProjectEntry, type ServiceEntry } from '../shared/registry.ts'
import { resolveCompose, type ComposeLocation, type ResolvedCompose, type Runner } from './compose.ts'

export type EnvironmentServices = Record<string, ServiceEntry>

// sqlite is kept whatever the compose file says: it is a file the site opens, never a compose service.
export function declaredServices(project: ProjectEntry, resolved: ResolvedCompose): EnvironmentServices {
    const services: EnvironmentServices = {}
    for (const [name, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry) || Object.hasOwn(resolved.services, name)) services[name] = entry
    }
    return services
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
