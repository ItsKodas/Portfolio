// A site's environments beside live: adding one, deleting one, and the deleted ones hostd keeps for 30
// days and can put back. All four are the operator's alone, in hostd (policy verb provision) as here in
// the actions that call them. The shapes are the api contract in
// docs/superpowers/specs/2026-09-24-named-environments-design.md, "hostd api".

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import { isEnvironmentName, LIVE, type EnvironmentName } from './env'

export type NewEnvironment = {
    name: EnvironmentName
    // A branch of the site's repository, which hostd fetches and checks out for it
    branch: string
    // Its first hostname, or null for none yet. hostd writes the vhost straight after when there is one.
    domain: string | null
}

// Only present when a domain was given. A failure here is beside an add that succeeded: the environment
// exists, and the message says what is left to do from the Domains tab. The same shape a new site has.
export type AddedEnvironment = { output?: string, vhost?: { ok: true } | { ok: false, message: string } }

export type DeletedEnvironment = {
    environment: EnvironmentName
    // When it was deleted, which also names this deletion if the same name was deleted more than once
    deletedAt: string
    // When hostd purges it, 30 days after deletedAt
    purgeAt: string
    branch: string | null
    domain: string | null
    aliases: string[]
}

export type RestoredEnvironment = {
    port: number
    // Whether its old port was taken meanwhile, so it came back on another
    portChanged: boolean
    // Hostnames another site or environment claimed meanwhile, which it came back without
    droppedHostnames: string[]
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// hostd's own HOSTNAME, from hostd/src/shared/formats.ts, as create.ts and domains.ts copy it
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

// Each of these does real work before it answers: an add fetches the branch and resolves compose, a
// delete stops the containers first, a restore starts them. So each waits past hostd's own 150 second
// call to the agent, the same as a create does.
const SLOW_MS = 180_000

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }
const NOT_LIVE: HostdResult<never> = { ok: false, code: 'bad-request', message: 'live cannot be added, deleted or restored' }
const BAD_NAME: HostdResult<never> = { ok: false, code: 'bad-request', message: 'not an environment name' }

// Every call here names an environment other than live, so the checks are the same for all four
function badTarget(id: string, environment: string): HostdResult<never> | null {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (environment === LIVE) return NOT_LIVE
    if (!isEnvironmentName(environment)) return BAD_NAME
    return null
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export async function addEnvironment(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: NewEnvironment,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<AddedEnvironment>> {
    const bad = badTarget(id, environment.name)
    if (bad) return bad
    if (environment.domain !== null && !HOSTNAME.test(environment.domain)) {
        return { ok: false, code: 'bad-request', message: 'hostname must be a plain domain name' }
    }

    const result = await hostdRequest<AddedEnvironment>(
        config,
        caller,
        `/projects/${id}/environments`,
        {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ name: environment.name, branch: environment.branch, domain: environment.domain }),
        },
        fetchImpl,
        SLOW_MS,
    )
    if (!result.ok) return result
    return {
        ok: true,
        value: {
            ...(result.value.output !== undefined ? { output: result.value.output } : {}),
            ...(result.value.vhost ? { vhost: result.value.vhost } : {}),
        },
    }
}

// hostd wants the site's name typed back, the same confirmation deleting the whole site asks for
export async function deleteEnvironment(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    name: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output?: string }>> {
    const bad = badTarget(id, environment)
    if (bad) return bad

    const result = await hostdRequest<{ output?: string }>(
        config,
        caller,
        `/projects/${id}/environments/${environment}`,
        { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ name }) },
        fetchImpl,
        SLOW_MS,
    )
    if (!result.ok) return result
    return { ok: true, value: result.value.output !== undefined ? { output: result.value.output } : {} }
}

export async function listDeletedEnvironments(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<DeletedEnvironment[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ environments: DeletedEnvironment[] }>(
        config, caller, `/projects/${id}/deleted-environments`, {}, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.environments ?? [] } : result
}

// deletedAt says which deletion, since the same name can have been deleted more than once
export async function restoreEnvironment(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    deletedAt: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<RestoredEnvironment>> {
    const bad = badTarget(id, environment)
    if (bad) return bad

    const result = await hostdRequest<Partial<RestoredEnvironment>>(
        config,
        caller,
        `/projects/${id}/deleted-environments/${environment}/restore`,
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ deletedAt }) },
        fetchImpl,
        SLOW_MS,
    )
    if (!result.ok) return result
    return {
        ok: true,
        value: {
            port: result.value.port ?? 0,
            portChanged: result.value.portChanged === true,
            droppedHostnames: result.value.droppedHostnames ?? [],
        },
    }
}
