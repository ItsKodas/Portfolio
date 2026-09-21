// Domains, per environment. Six calls: the list, adding one, removing one, verifying one, and the two
// that adopt a hand-written vhost (a preview, then the adopt itself).
//
// Every type here is copied from hostd's own source rather than from any description of it:
// hostd/src/api/domain-state.ts for a record, hostd/src/shared/protocol.ts for the replies and
// hostd/src/api/routes.ts for the routes. Writing an integration's field names out of prose is how this
// portal has been wrong before, twice without anything failing.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import type { EnvironmentName } from './env'

export type DomainState = 'unmanaged' | 'pending' | 'active' | 'failed' | 'broken'

export type Domain = {
    hostname: string
    primary: boolean
    state: DomainState
    checkedAt: string | null
    error: string | null
    // Apache's raw words about a configuration it refused. hostd omits this for a client, so null here
    // can mean either nothing went wrong or that the caller was not allowed to see what did.
    vhost: { ok: boolean, output: string } | null
    // The environment's own certificate mode, joined on by hostd when it answers rather than stored per
    // hostname: it belongs to the environment, not to any one hostname.
    certificate: 'cloudflare-origin' | 'letsencrypt' | null
}

export type AdoptPreview = {
    proposed: string
    // text is the claiming file verbatim, and it is the point of the preview rather than a detail of it:
    // adoption switches this file off and puts hostd's own in its place on a site serving somebody right
    // now, and the two directives hostd's parser reads are not the whole of what the file does.
    claims: { path: string, text: string, names: string[], unsupported: string | null }[]
    extraNames: string[]
    adoptable: boolean
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// hostd's own HOSTNAME, from hostd/src/shared/formats.ts. Copied so the box on the page can refuse a
// hostname immediately instead of after a round trip; hostd checks it again.
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }
const BAD_HOSTNAME: HostdResult<never> = { ok: false, code: 'bad-request', message: 'hostname must be a plain domain name' }

export async function listDomains(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Domain[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ domains: Domain[] }>(
        config, caller, `/projects/${id}/${environment}/domains`, {}, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.domains } : result
}

export async function addDomain(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    hostname: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Domain[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!HOSTNAME.test(hostname)) return BAD_HOSTNAME
    const result = await hostdRequest<{ domains: Domain[] }>(
        config, caller, `/projects/${id}/${environment}/domains`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname }) },
        fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.domains } : result
}

export async function removeDomain(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    hostname: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Domain[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!HOSTNAME.test(hostname)) return BAD_HOSTNAME
    const result = await hostdRequest<{ domains: Domain[] }>(
        config, caller, `/projects/${id}/${environment}/domains/${encodeURIComponent(hostname)}`,
        { method: 'DELETE' }, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.domains } : result
}

export async function verifyDomain(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    hostname: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Domain>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!HOSTNAME.test(hostname)) return BAD_HOSTNAME
    // Singular, deliberately: this answers the one record it just re-checked, not the whole list.
    const result = await hostdRequest<{ domain: Domain }>(
        config, caller, `/projects/${id}/${environment}/domains/${encodeURIComponent(hostname)}/verify`,
        { method: 'POST' }, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.domain } : result
}

export async function previewAdopt(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<AdoptPreview>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ preview: AdoptPreview }>(
        config, caller, `/projects/${id}/${environment}/adopt`, {}, fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.preview } : result
}

export async function adoptSite(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    // The project's name, not its id: the id is already in the URL the operator is on, so typing it back
    // would confirm nothing about which site they meant. hostd checks this again.
    confirm: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Domain[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ domains: Domain[] }>(
        config, caller, `/projects/${id}/${environment}/adopt`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) },
        fetchImpl,
    )
    return result.ok ? { ok: true, value: result.value.domains } : result
}
