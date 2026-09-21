// The calls the screens make. Every project id is checked against hostd's own id grammar before it reaches
// a URL, and a client's ownership is checked here as well as in hostd, because neither check should be the
// only one.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

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

export type Project = {
    id: string
    // Absent for a registry entry hostd itself could not parse: those are answered with an id and a
    // reason and nothing else, so a caller has to fall back to the id.
    name?: string
    valid: boolean
    reason?: string
    capabilities?: string[]
    // Present only when hostd was asked for it, and only ever on a list. Never assume it is there.
    status?: ProjectStatus
    services?: ServiceStatus[]
}

export type SiteRow = { projectId: string, clientId: string }
export type FindSite = (projectId: string) => Promise<SiteRow | null>

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

export async function lifecycle(
    config: HostdConfig,
    caller: Caller,
    id: string,
    action: 'start' | 'stop' | 'restart',
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<{ ok: boolean }>(config, caller, `/projects/${id}/${action}`, { method: 'POST' }, fetchImpl)
}

// The portal's own ownership check. hostd runs its own, and describes it as a second line of defence
// against portal bugs; that only works if there is a first line.
export async function assertOwned(clientId: string, projectId: string, findSite: FindSite): Promise<boolean> {
    const site = await findSite(projectId)
    return site !== null && site.clientId === clientId
}
