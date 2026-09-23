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
    // The name of one of the fetcher's tokens, never a token. null clears it, back to the default.
    credential?: string | null
    branches?: Record<string, string | null>
    // An environment's primary address. No null member, unlike branches: this gives an environment an
    // address or moves it to another one, and never clears one. Moving it makes hostd rewrite the vhost
    // it owns, so the page that sends one is expected to have confirmed it first.
    domains?: Record<string, string>
    // Whether each environment's vhost passes WebSocket upgrades through. hostd rewrites the vhost it owns
    // when this changes; a site still served by hand only has it recorded until it is adopted.
    websockets?: Record<string, boolean>
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// hostd's own HOSTNAME, from hostd/src/shared/formats.ts. Copied so the box on the page can refuse a
// hostname immediately instead of after a round trip; hostd checks it again.
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export async function writeSettings(
    config: HostdConfig,
    caller: Caller,
    id: string,
    settings: SiteSettings,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    for (const domain of Object.values(settings.domains ?? {})) {
        if (!HOSTNAME.test(domain)) return { ok: false, code: 'bad-request', message: 'hostname must be a plain domain name' }
    }
    return hostdRequest<{ ok: boolean }>(
        config,
        caller,
        `/projects/${id}/settings`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) },
        fetchImpl,
    )
}
