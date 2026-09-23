// Creating a site: hostd clones the repo into its folder under /var/www, checks the compose files resolve,
// registers it, and writes its first vhost when it was given a domain. Admin only, in hostd as here.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export type NewSite = {
    id: string
    name: string
    // Absent for a site the operator runs for themselves
    client?: string
    repo: string
    // The name of one of the fetcher's tokens. Absent means the default one.
    credential?: string
    branch: string
    domain: string | null
    certificate: 'letsencrypt' | 'cloudflare-origin' | null
    dir: string
    compose: string[]
    capabilities: string[]
    websockets: boolean
    flexibleSsl: boolean
}

// Only present when a domain was given. A failure here is beside a create that succeeded: the site
// exists, and the message says what is left to do from its Domains tab.
export type Created = { vhost?: { ok: true } | { ok: false, message: string } }

// hostd's own PROJECT_ID and HOSTNAME, from hostd/src/shared/formats.ts, so a bad id never reaches a
// request and a bad hostname is said without a round trip. hostd checks both again.
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

// Longer than hostd's own 150 second call to the agent, so hostd's answer (even a timeout of its own)
// is what comes back, rather than this giving up on a clone that is still going.
const CREATE_TIMEOUT_MS = 180_000

export async function createProject(
    config: HostdConfig,
    caller: Caller,
    site: NewSite,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Created>> {
    if (!PROJECT_ID.test(site.id)) return { ok: false, code: 'bad-request', message: 'id must be lowercase letters, digits and hyphens' }
    if (site.domain !== null && !HOSTNAME.test(site.domain)) return { ok: false, code: 'bad-request', message: 'hostname must be a plain domain name' }

    const result = await hostdRequest<Created>(
        config,
        caller,
        '/projects',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(site) },
        fetchImpl,
        CREATE_TIMEOUT_MS,
    )
    return result.ok ? { ok: true, value: result.value.vhost ? { vhost: result.value.vhost } : {} } : result
}
