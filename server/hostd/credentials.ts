// The names of the GitHub tokens the fetcher holds, for the Settings tab's Account select. Names only:
// hostd never answers a token value to anything, and nothing here ever holds one.
//
// Machine level, not per project: which accounts exist is a fact about the dedi, and one project's
// Settings form offers exactly the same list as another's. Failure is ordinary here, not exceptional
// (hostd down, the fetcher down, a client asking): the caller decides what to show for that, and this
// module only carries hostd's own words along.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export async function listCredentials(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string[]>> {
    const result = await hostdRequest<{ credentials: string[] }>(config, caller, '/credentials', {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.credentials } : result
}
