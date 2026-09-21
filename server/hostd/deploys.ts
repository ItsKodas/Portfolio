// Deploys, per environment. Five calls: the history, the commit list behind it, and the three things
// that start work (deploy, roll back, switch branch).
//
// Every type here is copied from hostd's own source rather than from any description of it:
// hostd/src/shared/deploys.ts for a record, hostd/src/shared/protocol.ts for the replies and
// hostd/src/api/routes.ts for the routes. Writing an integration's field names out of prose is how this
// portal has been wrong before, twice without anything failing.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import type { EnvironmentName } from './env'

// 'poll' is hostd noticing a push by itself; the other three are somebody asking.
export type DeployTrigger = 'poll' | 'manual' | 'rollback' | 'branch'
// 'rolled-back' is its own outcome: the deploy landed, failed its health check, and hostd put the
// previous copy back before anyone saw it. That is not the same as a build that never finished.
export type DeployOutcome = 'ok' | 'failed' | 'rolled-back'

export type DeployRecord = {
    commit: string
    // Absent when the commit's subject could not be read, which hostd treats as cosmetic and never fails
    // a deploy over
    subject: string | null
    // 'hostd' for a poll, 'admin' for everything a person asked for. The agent never learns which user,
    // so this is never a name: hostd's own audit log is where that is recorded.
    actor: string
    trigger: DeployTrigger
    startedAt: string
    durationMs: number
    outcome: DeployOutcome
    reason: string | null
    // The tail of whatever command failed, so a broken build is readable from here. hostd guarantees this
    // never holds an env file's contents.
    output: string | null
}

export type DeployHistory = {
    environment: EnvironmentName
    // The branch this environment follows, null for an environment registered without one
    branch: string | null
    // The commit serving right now, null before the first deploy
    deployed: string | null
    // hostd stops polling a branch after PAUSE_AFTER_FAILURES consecutive bad deploys. Deploying or
    // switching branch by hand is what resumes it.
    paused: boolean
    consecutiveFailures: number
    // Newest first, capped by hostd at MAX_DEPLOY_RECORDS
    deploys: DeployRecord[]
}

export type Commit = { commit: string, subject: string, author: string, at: string }

// What a deploy, a rollback and a branch switch all answer with. A deploy is minutes of building and
// hostd's own call timeout is 150 seconds, so all three answer as soon as the work has started and the
// outcome lands in the history later.
export type DeployStarted = { environment: EnvironmentName, trigger: DeployTrigger }

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// hostd's own GIT_REF, from hostd/src/shared/registry.ts, which parseDeployArgs checks a set-branch
// against. Copied so the box on the page can refuse a name immediately instead of after a round trip;
// hostd checks it again, and the registry writer a third time.
const GIT_REF = /^(?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

// hostd answers 1 to 100 and refuses anything else with a 400
const MAX_COMMITS = 100

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }

export async function listDeploys(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<DeployHistory>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ ok: true } & DeployHistory>(
        config, caller, `/projects/${id}/${environment}/deploys`, {}, fetchImpl,
    )
    if (!result.ok) return result
    // The reply is the history with an ok flag on top of it, so the flag is dropped rather than carried
    // into the page as a field of the thing it describes.
    const { ok: _ok, ...history } = result.value
    return { ok: true, value: history }
}

export async function listCommits(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    limit?: number,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Commit[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMMITS)) {
        return { ok: false, code: 'bad-request', message: `limit must be a whole number from 1 to ${MAX_COMMITS}` }
    }
    // Left off entirely when nobody asked, so hostd's own default is what decides rather than a second
    // copy of that number living here
    const query = limit === undefined ? '' : `?limit=${limit}`
    const result = await hostdRequest<{ commits: Commit[] }>(
        config, caller, `/projects/${id}/${environment}/commits${query}`, {}, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.commits } : result
}

async function started(
    config: HostdConfig,
    caller: Caller,
    path: string,
    init: RequestInit,
    fetchImpl: typeof fetch,
): Promise<HostdResult<DeployStarted>> {
    const result = await hostdRequest<{ started: DeployStarted }>(config, caller, path, init, fetchImpl)
    return result.ok ? { ok: true, value: result.value.started } : result
}

export async function startDeploy(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<DeployStarted>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    return started(config, caller, `/projects/${id}/${environment}/deploy`, { method: 'POST' }, fetchImpl)
}

// Which commit this goes back to is hostd's to decide, not the caller's: it is the newest one this
// environment served healthily that is not the one serving now (lastHealthyCommit, in
// hostd/src/shared/deploys.ts). There is deliberately no way to name a different one from here.
export async function rollback(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<DeployStarted>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    return started(config, caller, `/projects/${id}/${environment}/rollback`, { method: 'POST' }, fetchImpl)
}

// Switching branch deploys it: the environment is left following the new branch and a deploy of its tip
// starts straight away, which is also what resumes a paused environment.
export async function setBranch(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    branch: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<DeployStarted>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!GIT_REF.test(branch)) return { ok: false, code: 'bad-request', message: 'branch must be a plain branch name' }
    return started(
        config,
        caller,
        `/projects/${id}/${environment}/branch`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch }) },
        fetchImpl,
    )
}
