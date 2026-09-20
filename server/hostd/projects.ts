// The calls the screens make. Every project id is checked against hostd's own id grammar before it reaches
// a URL, and a client's ownership is checked here as well as in hostd, because neither check should be the
// only one.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

// Matches hostd's registry id rule, so a bad id is refused before it can be interpolated into a path
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export type ServiceStatus = {
    service: string
    state: string
    health?: string
    startedAt?: string
    restarts?: number
    image?: string
}

export type Project = {
    id: string
    name: string
    valid: boolean
    reason?: string
    services?: ServiceStatus[]
}

export type SiteRow = { projectId: string, clientId: string }
export type FindSite = (projectId: string) => Promise<SiteRow | null>

export async function listProjects(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Project[]>> {
    const result = await hostdRequest<{ projects: Project[] }>(config, caller, '/projects', {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.projects } : result
}

export async function getProject(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Project>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<Project>(config, caller, `/projects/${id}`, {}, fetchImpl)
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
