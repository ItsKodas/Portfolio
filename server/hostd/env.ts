// Env files, per environment. hostd confines writes to env files inside one environment's folder, and
// checks every path itself; this checks first anyway, so a portal bug cannot spend a request asking for
// something it already knows is wrong.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export type EnvironmentName = 'live' | 'test'

export type EnvFile = {
    path: string
    // The path of this file's .example sibling, or null when it has none
    example: string | null
    bytes: number
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }
const BAD_PATH: HostdResult<never> = { ok: false, code: 'bad-request', message: 'not a file inside this environment' }

// Relative, no climbing, no backslashes, no leading slash. hostd resolves the real path one component at
// a time and refuses a symlink at any position; this is only the obvious first pass.
function safePath(path: string): boolean {
    if (!path || path.startsWith('/') || path.includes('\\')) return false
    return !path.split('/').some(segment => segment === '..' || segment === '')
}

export async function listEnvFiles(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<EnvFile[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ files: EnvFile[] }>(config, caller, `/projects/${id}/${environment}/env`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.files } : result
}

export async function readEnvFile(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    path: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!safePath(path)) return BAD_PATH
    const result = await hostdRequest<{ text: string }>(config, caller, `/projects/${id}/${environment}/env/${path}`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.text } : result
}

export async function writeEnvFile(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    path: string,
    text: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output: string }>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!safePath(path)) return BAD_PATH
    // JSON, with text as its only key. hostd reads the body with readJsonBody and then refuses any other
    // key, so a raw body is answered with a 400.
    return hostdRequest<{ output: string }>(
        config,
        caller,
        `/projects/${id}/${environment}/env/${path}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
        fetchImpl,
    )
}
