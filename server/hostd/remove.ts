// Deleting a site: hostd stops it, unregisters it and takes its own vhost off, leaving the folder, volumes
// and databases where they are. Admin only, and hostd wants the site's name typed back as the confirmation.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// Stopping the containers comes first and can take a while, so this waits past hostd's own 150 second call
// to the agent, the same as a create does.
const REMOVE_TIMEOUT_MS = 180_000

export async function removeProject(
    config: HostdConfig,
    caller: Caller,
    id: string,
    name: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output?: string }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<{ output?: string }>(
        config,
        caller,
        `/projects/${id}`,
        { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) },
        fetchImpl,
        REMOVE_TIMEOUT_MS,
    )
}
