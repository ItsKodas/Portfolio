// A site's environments beside live: adding one, deleting one, the deleted ones hostd keeps for 30
// days and can put back, and copying live's databases and storage into one. Every call here is the
// operator's alone, in hostd (policy verb provision) as here in the actions that call them. The shapes
// are the api contract in docs/superpowers/specs/2026-09-24-named-environments-design.md, "hostd api",
// and for the copies docs/superpowers/specs/2026-09-25-copy-live-data-design.md, "hostd pieces".

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
    // Whether hostd starts a copy of live's data into it straight after the add. Off unless asked for.
    copyFromLive?: boolean
}

// Only present when a domain was given. A failure here is beside an add that succeeded: the environment
// exists, and the message says what is left to do from the Domains tab. The same shape a new site has.
// copy is only present when a copy was asked for: the run hostd started, or why it would not start one.
// Either way the environment was added.
export type AddedEnvironment = {
    output?: string
    vhost?: { ok: true } | { ok: false, message: string }
    copy?: { run: string } | { refused: string }
}

// One copy of live's data into an environment, as hostd records it. step names where a failed run
// stopped (dump, prepare, load:<service>, sqlite:<service>, storage:<path>, restore-state, clean).
export type CopyRecord = {
    project: string
    environment: string
    run: string
    actor: string
    startedAt: string
    // null when hostd did not say, which is never read as no time at all
    durationMs: number | null
    outcome: 'ok' | 'failed' | 'running'
    step: string | null
    reason: string | null
    services: string[]
    storage: string[]
}

export type CopyRuns = { runs: CopyRecord[], running: boolean }

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
    // null when hostd did not say, which is never read as a port number
    port: number | null
    // Whether its old port was taken meanwhile, so it came back on another
    portChanged: boolean
    // Hostnames another site or environment claimed meanwhile, which it came back without
    droppedHostnames: string[]
    // What went wrong once it was back in the registry, in hostd's words: a vhost not written, a start that
    // failed, a folder left in the trash. Never undone, so the operator is told.
    warnings: string[]
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
const NOT_LIVE: HostdResult<never> = {
    ok: false, code: 'bad-request', message: 'live cannot be added, deleted, restored or copied into',
}
const BAD_NAME: HostdResult<never> = { ok: false, code: 'bad-request', message: 'not an environment name' }
const BAD_RUN: HostdResult<never> = { ok: false, code: 'bad-request', message: 'not a copy run id' }
const UNREADABLE: HostdResult<never> = { ok: false, code: 'unavailable', message: 'hostd answered with something unreadable' }

// A run id goes into a path, so only a plain segment is sent. hostd has the final word on which exist.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

// Every call here names an environment other than live, so the checks are the same for all of them
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
            body: JSON.stringify({
                name: environment.name,
                branch: environment.branch,
                domain: environment.domain,
                copyFromLive: environment.copyFromLive === true,
            }),
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
            ...copyOf(result.value.copy),
        },
    }
}

function copyOf(copy: unknown): { copy?: AddedEnvironment['copy'] } {
    if (typeof copy !== 'object' || copy === null) return {}
    const { run, refused } = copy as { run?: unknown, refused?: unknown }
    if (typeof run === 'string') return { copy: { run } }
    if (typeof refused === 'string') return { copy: { refused } }
    return {}
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
            port: typeof result.value.port === 'number' ? result.value.port : null,
            portChanged: result.value.portChanged === true,
            droppedHostnames: result.value.droppedHostnames ?? [],
            warnings: Array.isArray(result.value.warnings)
                ? result.value.warnings.filter((warning): warning is string => typeof warning === 'string')
                : [],
        },
    }
}

// Copies of live's data into an environment. Admin only in hostd (policy verb provision), never into live.

const OUTCOMES: readonly string[] = ['ok', 'failed', 'running']

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

// Only the fields this side reads, each checked, so a record hostd changes shape on is dropped rather
// than drawn with holes in it
function readRecord(value: unknown): CopyRecord | null {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const { project, environment, run, actor, startedAt, outcome } = record
    if (typeof project !== 'string' || typeof environment !== 'string' || typeof run !== 'string') return null
    if (typeof startedAt !== 'string' || typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null
    return {
        project,
        environment,
        run,
        actor: typeof actor === 'string' ? actor : '',
        startedAt,
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
        outcome: outcome as CopyRecord['outcome'],
        step: typeof record.step === 'string' ? record.step : null,
        reason: typeof record.reason === 'string' ? record.reason : null,
        services: strings(record.services),
        storage: strings(record.storage),
    }
}

// Answers at once with the run id: the copy itself goes on in the background, like a backup
export async function copyFromLive(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ run: string }>> {
    const bad = badTarget(id, environment)
    if (bad) return bad

    const result = await hostdRequest<{ run?: unknown }>(
        config, caller, `/projects/${id}/${environment}/copy-from-live`, { method: 'POST' }, fetchImpl,
    )
    if (!result.ok) return result
    return typeof result.value.run === 'string' ? { ok: true, value: { run: result.value.run } } : UNREADABLE
}

export async function copyRuns(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<CopyRuns>> {
    const bad = badTarget(id, environment)
    if (bad) return bad

    const result = await hostdRequest<{ runs?: unknown, running?: unknown }>(
        config, caller, `/projects/${id}/${environment}/copy-runs`, {}, fetchImpl,
    )
    if (!result.ok) return result
    const runs = Array.isArray(result.value.runs) ? result.value.runs.map(readRecord) : []
    return {
        ok: true,
        value: {
            runs: runs.filter((one): one is CopyRecord => one !== null),
            running: result.value.running === true,
        },
    }
}

export async function copyRun(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    run: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<CopyRecord>> {
    const bad = badTarget(id, environment)
    if (bad) return bad
    if (!RUN_ID.test(run)) return BAD_RUN

    const result = await hostdRequest<unknown>(
        config, caller, `/projects/${id}/${environment}/copy-runs/${encodeURIComponent(run)}`, {}, fetchImpl,
    )
    if (!result.ok) return result
    const record = readRecord(result.value)
    return record ? { ok: true, value: record } : UNREADABLE
}
