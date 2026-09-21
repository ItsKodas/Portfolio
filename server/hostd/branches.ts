// The repository's branches, for the Settings tab's branch fields to offer as a dropdown. Project level,
// not per environment: hostd answers this from the registry entry's own repo, which both environments
// draw from.
//
// hostd reads this straight off the remote (git ls-remote --heads), not out of anything cloned on disk,
// so it answers even for a project that has a repo set and has never been deployed. Failure is ordinary
// here, not exceptional: no repo, an unreachable one, a bad token, hostd down. The caller decides what to
// show for that; this module only carries hostd's own words along.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export async function listBranches(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string[]>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const result = await hostdRequest<{ branches: string[] }>(config, caller, `/projects/${id}/branches`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.branches } : result
}
