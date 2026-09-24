// A site's port: whether one is free (the forms' live check) and moving an environment to another. hostd
// decides both, against its registry and everything listening on the dedi; this only refuses what it
// already knows hostd would.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import { isEnvironmentName, type EnvironmentName } from './env'

export const PORT_MIN = 5000
export const PORT_MAX = 65535

export type PortCheck = { suggested: number, problem: string | null }

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// Longer than hostd's own call to the agent: a port change recreates the site's containers first.
const PORT_TIMEOUT_MS = 180_000
// The live check probes the host, and the first probe after an agent restart looks up the agent's own
// image too, which can take about 25 seconds: the client's usual 10 would call the port unreadable.
const CHECK_TIMEOUT_MS = 30_000

export async function checkPort(
    config: HostdConfig,
    caller: Caller,
    query: { port?: number, own?: { project: string, environment: EnvironmentName } },
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<PortCheck>> {
    const params = new URLSearchParams()
    if (query.port !== undefined) params.set('port', String(query.port))
    if (query.own) {
        params.set('project', query.own.project)
        params.set('environment', query.own.environment)
    }
    const search = params.size > 0 ? `?${params}` : ''
    const result = await hostdRequest<PortCheck>(config, caller, `/ports${search}`, {}, fetchImpl, CHECK_TIMEOUT_MS)
    return result.ok ? { ok: true, value: { suggested: result.value.suggested, problem: result.value.problem } } : result
}

export async function setPort(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    port: number,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output: string }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    if (!isEnvironmentName(environment)) return { ok: false, code: 'bad-request', message: 'no such environment' }
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
        return { ok: false, code: 'bad-request', message: `Use a port from ${PORT_MIN} to ${PORT_MAX}.` }
    }
    const result = await hostdRequest<{ output: string }>(
        config,
        caller,
        `/projects/${id}/${environment}/port`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) },
        fetchImpl,
        PORT_TIMEOUT_MS,
    )
    return result.ok ? { ok: true, value: { output: result.value.output } } : result
}
