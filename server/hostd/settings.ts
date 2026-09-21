// The registry entry's own editable fields. hostd checks everything here again, and the registry
// validator has the final say on what a capability, a repo and a branch may be; this checks the project
// id first so a portal bug cannot spend a request asking for something it already knows is wrong.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export type SiteSettings = {
    capabilities?: string[]
    repo?: string | null
    branches?: Record<string, string | null>
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export async function writeSettings(
    config: HostdConfig,
    caller: Caller,
    id: string,
    settings: SiteSettings,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<{ ok: boolean }>(
        config,
        caller,
        `/projects/${id}/settings`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) },
        fetchImpl,
    )
}
