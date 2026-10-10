// The calls the screens make. Every project id is checked against hostd's own id grammar before it reaches
// a URL, and a client's ownership is checked here as well as in hostd, because neither check should be the
// only one.

import 'server-only'

import type { Permission } from '../sites/permissions'
import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
// EnvironmentName lives beside the env file calls, which were the first thing to need it
import type { EnvironmentName } from './env'

// Matches hostd's registry id rule, so a bad id is refused before it can be interpolated into a path
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// Kept in step with hostd's own ServiceStatus in hostd/src/shared/protocol.ts. Every field past the
// service name is nullable rather than optional: a container hostd cannot inspect still gets a row, with
// nulls where the readings would be.
export type ServiceStatus = {
    service: string
    role: 'site' | 'database'
    state: string
    health: string | null
    startedAt: string | null
    restartCount: number | null
    image: string | null
}

// One project's status inside a list. hostd refuses a project it could not read on its own rather than
// failing the whole list, so a caller has to handle both arms: the dashboard still draws the other sites.
export type ProjectStatus =
    | { ok: true, services: ServiceStatus[] }
    | { ok: false, code: string, message: string }

// One environment of a project, as hostd's registry holds it. The last four fields go to anyone who may
// see the project; the first three are the operator's alone, and hostd leaves them out of a client's
// answer entirely rather than sending them as null (hostd/src/api/routes.ts, environmentsFor), which is
// why they are optional here rather than nullable.
export type Environment = {
    name: EnvironmentName
    branch: string | null
    domain: string | null
    certificate: 'letsencrypt' | 'cloudflare-origin' | null
    // The commit serving right now, null before the first deploy
    deployed: string | null
    // Whether hostd's vhost passes WebSocket upgrades through. Optional because a hostd from before the
    // flag existed does not send it, which means off.
    websockets?: boolean
    // Whether the origin serves the site on port 80 for a CDN in Flexible mode. Optional for the same
    // reason as websockets.
    flexibleSsl?: boolean
    // Every hostname beside the primary, each redirecting to it. Optional because a hostd from before
    // named environments does not send it.
    aliases?: string[]
    dir?: string
    composePaths?: string[]
    port?: number
}

export type Project = {
    id: string
    // Absent for a registry entry hostd itself could not parse: those are answered with an id and a
    // reason and nothing else, so a caller has to fall back to the id.
    name?: string
    valid: boolean
    reason?: string
    capabilities?: string[]
    // Answered for the operator alone, so it is absent for a client rather than null
    repo?: string | null
    // Answered for the operator alone, like repo, so it is absent for a client rather than null
    credential?: string | null
    // The site's own domain, the base new environments sit under. For the operator alone, like repo.
    rootDomain?: string | null
    // Live first, then the rest. Absent only from an entry the registry itself could not parse, which is
    // answered with an id and a reason and nothing else: there is no such thing as a valid project with
    // no environments.
    environments?: Environment[]
    // Present only when hostd was asked for it, and only ever on a list. Never assume it is there.
    status?: ProjectStatus
    services?: ServiceStatus[]
}

// What a client may do on one site, from the portal's own database: null for no access at all
export type FindAccess = (clientId: string, projectId: string) => Promise<readonly Permission[] | null>

// One site's root domain as hostd has it now, for an action to check an address against. The plain listing
// rather than status=1, so it costs no Docker read. null when the site names none or is not in the list.
export async function readRootDomain(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string | null>> {
    const result = await hostdRequest<{ projects: Project[] }>(config, caller, '/projects', {}, fetchImpl)
    if (!result.ok) return result
    return { ok: true, value: result.value.projects.find(project => project.id === id)?.rootDomain ?? null }
}

export async function listProjects(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Project[]>> {
    // status=1 makes hostd read every project's containers and answer them in this one request. Without
    // it the listing is the cheap one (names, and whether an entry is valid) and the dashboard would need
    // a further request per site on every render. hostd accepts 1 or 0 here and refuses anything else.
    const result = await hostdRequest<{ projects: Project[] }>(config, caller, '/projects?status=1', {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.projects } : result
}

// One project's containers, and only those. GET /projects/:id answers hostd's StatusReply, which is
// `{ ok: true, services }` and carries no id, name, valid or capabilities (hostd/src/api/routes.ts, the
// `status` case, which sends the agent's reply through untouched). This was typed as a whole Project,
// which meant `name` and `valid` read back undefined from every call and nothing ever said so. Those
// fields come from listProjects, which is the only endpoint that answers them.
export async function getProject(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<ServiceStatus[]>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const result = await hostdRequest<{ services: ServiceStatus[] }>(config, caller, `/projects/${id}`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.services } : result
}

// One project's environments, and nothing else. The same request as getProject: hostd answers the
// registry's environments beside the services, so the actions can check a name against the site's own
// list without reading every project's containers the way the status listing does.
export async function listEnvironments(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Environment[]>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const result = await hostdRequest<{ environments?: Environment[] }>(config, caller, `/projects/${id}`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.environments ?? [] } : result
}

// hostd answers a lifecycle call when compose has finished, not when it has started: up to 120 seconds in
// the agent (hostd/src/agent/compose.ts) inside a 150 second call. A stop waits out each container's grace
// period before Docker kills it, which is ten seconds for anything that ignores SIGTERM, so the default
// timeout gave up on every such stop and reported hostd as not answering while the stop went on regardless.
export const LIFECYCLE_TIMEOUT_MS = 180_000

// live's is /projects/:id/<action>, as it was before other environments had controls; any other environment's
// is /projects/:id/<environment>/<action>. The caller has checked the name against the site's own list.
export async function lifecycle(
    config: HostdConfig,
    caller: Caller,
    id: string,
    action: 'start' | 'stop' | 'restart',
    environment: EnvironmentName = 'live',
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const path = environment === 'live' ? `/projects/${id}/${action}` : `/projects/${id}/${encodeURIComponent(environment)}/${action}`
    return hostdRequest<{ ok: boolean }>(config, caller, path, { method: 'POST' }, fetchImpl, LIFECYCLE_TIMEOUT_MS)
}

// One environment's containers, for the controls on that environment. getProject answers live's.
export async function getEnvironmentStatus(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<ServiceStatus[]>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const path = `/projects/${id}/${encodeURIComponent(environment)}/status`
    const result = await hostdRequest<{ services: ServiceStatus[] }>(config, caller, path, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.services } : result
}

// The portal's own access check. hostd runs its own, and describes it as a second line of defence against
// portal bugs; that only works if there is a first line. Without a permission named, any access to the site
// will do, which is what its Overview needs.
export async function hasAccess(clientId: string, projectId: string, findAccess: FindAccess, permission?: Permission): Promise<boolean> {
    const permissions = await findAccess(clientId, projectId)
    return permissions !== null && (permission === undefined || permissions.includes(permission))
}
