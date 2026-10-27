// The edge process's protocol: one JSON request line in, one JSON reply line out over a Unix socket, the
// same shape as the fetcher's. edge holds the Nginx Proxy Manager credentials and is the only thing that
// writes to NPM, so this is the one place the agent says what a site's hosts should look like. Parsing
// is strict (unknown keys and wrong types give null) because a malformed spec must never reach NPM.

import { isRecord, isEnvironmentName, PROJECT_ID } from './formats.ts'
import type { EnvironmentName, NpmIds } from './registry.ts'

export type Owner = { project: string, environment: EnvironmentName }

export type ProxyHostSpec = {
    domain_names: string[], forward_host: string, forward_port: number, certificate_id: number,
    ssl_forced: boolean, http2_support: boolean, advanced_config: string,
}
export type RedirectionHostSpec = {
    domain_names: string[], forward_domain_name: string, certificate_id: number,
    ssl_forced: boolean, http2_support: boolean, advanced_config: string,
}
export type HostsSpec = { proxy: ProxyHostSpec, redirection: RedirectionHostSpec | null }

// A host found in NPM. owner is read from its marker, so null means hostd did not write it. 'dead' is a
// 404 host, which has no forward target.
export type FoundHost = {
    kind: 'proxy' | 'redirection' | 'dead', id: number, domain_names: string[], owner: Owner | null,
    forward_host: string | null, forward_port: number | null, hasLocations: boolean, spec: ProxyHostSpec | RedirectionHostSpec | null,
}

export type EdgeRequest =
    | { verb: 'health' }
    | { verb: 'certificates' }
    | { verb: 'find', domains: string[] }
    | { verb: 'get', owner: Owner, ids: NpmIds }
    | { verb: 'apply', owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean }
    | { verb: 'remove', owner: Owner, ids: NpmIds }

export type EdgeReply =
    | { ok: true, verb: 'health', npmAge: number | null }
    | { ok: true, verb: 'certificates', ids: number[] }
    | { ok: true, verb: 'find', hosts: FoundHost[] }
    | { ok: true, verb: 'get', current: HostsSpec | null }
    | { ok: true, verb: 'apply', ids: NpmIds, previous: HostsSpec | null }
    | { ok: true, verb: 'remove' }
    | { ok: false, problem: string, output?: string }

// The first line of every advanced_config hostd writes. It is how hostd knows a host is its own.
export function markerFor(owner: Owner): string {
    return `# hostd: ${owner.project}/${owner.environment}. Managed by hostd; edits here are overwritten.`
}

const MARKER = /^# hostd: ([^/\s]+)\/([^\s.]+)\. Managed by hostd; edits here are overwritten\.$/

// Only the first line counts: a marker pasted further down is not a claim of ownership.
export function ownerOf(advancedConfig: string): Owner | null {
    const found = MARKER.exec(advancedConfig.split('\n', 1)[0] ?? '')
    const [, project, environment] = found ?? []
    if (project === undefined || environment === undefined) return null
    if (!PROJECT_ID.test(project) || !isEnvironmentName(environment)) return null
    return { project, environment }
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function isInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseOwner(value: unknown): Owner | null {
    if (!isRecord(value) || !onlyKeys(value, ['project', 'environment'])) return null
    if (typeof value.project !== 'string' || !PROJECT_ID.test(value.project)) return null
    if (!isEnvironmentName(value.environment)) return null
    return { project: value.project, environment: value.environment }
}

function parseIds(value: unknown): NpmIds | null {
    if (!isRecord(value) || !onlyKeys(value, ['proxyHost', 'redirectionHost'])) return null
    if (!isInt(value.proxyHost)) return null
    if (value.redirectionHost !== null && !isInt(value.redirectionHost)) return null
    return { proxyHost: value.proxyHost, redirectionHost: value.redirectionHost }
}

function parseProxy(value: unknown): ProxyHostSpec | null {
    if (!isRecord(value) || !onlyKeys(value, ['domain_names', 'forward_host', 'forward_port', 'certificate_id', 'ssl_forced', 'http2_support', 'advanced_config'])) return null
    if (!isStringArray(value.domain_names) || typeof value.forward_host !== 'string') return null
    if (!isInt(value.forward_port) || !isInt(value.certificate_id)) return null
    if (typeof value.ssl_forced !== 'boolean' || typeof value.http2_support !== 'boolean' || typeof value.advanced_config !== 'string') return null
    return {
        domain_names: value.domain_names, forward_host: value.forward_host, forward_port: value.forward_port, certificate_id: value.certificate_id,
        ssl_forced: value.ssl_forced, http2_support: value.http2_support, advanced_config: value.advanced_config,
    }
}

function parseRedirection(value: unknown): RedirectionHostSpec | null {
    if (!isRecord(value) || !onlyKeys(value, ['domain_names', 'forward_domain_name', 'certificate_id', 'ssl_forced', 'http2_support', 'advanced_config'])) return null
    if (!isStringArray(value.domain_names) || typeof value.forward_domain_name !== 'string' || !isInt(value.certificate_id)) return null
    if (typeof value.ssl_forced !== 'boolean' || typeof value.http2_support !== 'boolean' || typeof value.advanced_config !== 'string') return null
    return {
        domain_names: value.domain_names, forward_domain_name: value.forward_domain_name, certificate_id: value.certificate_id,
        ssl_forced: value.ssl_forced, http2_support: value.http2_support, advanced_config: value.advanced_config,
    }
}

function parseSpec(value: unknown): HostsSpec | null {
    if (!isRecord(value) || !onlyKeys(value, ['proxy', 'redirection'])) return null
    const proxy = parseProxy(value.proxy)
    if (!proxy) return null
    if (value.redirection === null) return { proxy, redirection: null }
    const redirection = parseRedirection(value.redirection)
    return redirection ? { proxy, redirection } : null
}

export function parseEdgeRequest(value: unknown): EdgeRequest | null {
    if (!isRecord(value)) return null
    switch (value.verb) {
        case 'health':
        case 'certificates':
            return onlyKeys(value, ['verb']) ? { verb: value.verb } : null

        case 'find':
            if (!onlyKeys(value, ['verb', 'domains']) || !isStringArray(value.domains)) return null
            return { verb: 'find', domains: value.domains }

        case 'get':
        case 'remove': {
            if (!onlyKeys(value, ['verb', 'owner', 'ids'])) return null
            const owner = parseOwner(value.owner)
            const ids = parseIds(value.ids)
            return owner && ids ? { verb: value.verb, owner, ids } : null
        }

        case 'apply': {
            if (!onlyKeys(value, ['verb', 'owner', 'ids', 'spec', 'adopt'])) return null
            const owner = parseOwner(value.owner)
            const ids = value.ids === null ? null : parseIds(value.ids)
            const spec = parseSpec(value.spec)
            if (!owner || !spec || (value.ids !== null && !ids) || typeof value.adopt !== 'boolean') return null
            return { verb: 'apply', owner, ids, spec, adopt: value.adopt }
        }

        default:
            return null
    }
}

function parseFound(value: unknown): FoundHost | null {
    if (!isRecord(value) || !onlyKeys(value, ['kind', 'id', 'domain_names', 'owner', 'forward_host', 'forward_port', 'hasLocations', 'spec'])) return null
    if (value.kind !== 'proxy' && value.kind !== 'redirection' && value.kind !== 'dead') return null
    if (!isInt(value.id) || !isStringArray(value.domain_names) || typeof value.hasLocations !== 'boolean') return null
    const owner = value.owner === null ? null : parseOwner(value.owner)
    if (value.owner !== null && !owner) return null
    if (value.forward_host !== null && typeof value.forward_host !== 'string') return null
    if (value.forward_port !== null && !isInt(value.forward_port)) return null
    let spec: ProxyHostSpec | RedirectionHostSpec | null = null
    if (value.spec !== null) {
        spec = value.kind === 'proxy' ? parseProxy(value.spec) : value.kind === 'redirection' ? parseRedirection(value.spec) : null
        if (!spec) return null
    }
    return {
        kind: value.kind, id: value.id, domain_names: value.domain_names, owner,
        forward_host: value.forward_host, forward_port: value.forward_port, hasLocations: value.hasLocations, spec,
    }
}

// The reply is parsed as strictly as the request: the agent acts on it, and a half-understood answer
// from edge is worse than a refusal.
export function parseEdgeReply(value: unknown): EdgeReply | null {
    if (!isRecord(value)) return null
    if (value.ok === false) {
        if (!onlyKeys(value, ['ok', 'problem', 'output']) || typeof value.problem !== 'string') return null
        if (value.output === undefined) return { ok: false, problem: value.problem }
        return typeof value.output === 'string' ? { ok: false, problem: value.problem, output: value.output } : null
    }
    if (value.ok !== true) return null
    switch (value.verb) {
        case 'health':
            if (!onlyKeys(value, ['ok', 'verb', 'npmAge'])) return null
            if (value.npmAge !== null && typeof value.npmAge !== 'number') return null
            return { ok: true, verb: 'health', npmAge: value.npmAge }

        case 'certificates':
            if (!onlyKeys(value, ['ok', 'verb', 'ids']) || !Array.isArray(value.ids) || !value.ids.every(isInt)) return null
            return { ok: true, verb: 'certificates', ids: value.ids }

        case 'find': {
            if (!onlyKeys(value, ['ok', 'verb', 'hosts']) || !Array.isArray(value.hosts)) return null
            const hosts = value.hosts.map(parseFound)
            return hosts.every(host => host !== null) ? { ok: true, verb: 'find', hosts } : null
        }

        case 'get': {
            if (!onlyKeys(value, ['ok', 'verb', 'current'])) return null
            if (value.current === null) return { ok: true, verb: 'get', current: null }
            const current = parseSpec(value.current)
            return current ? { ok: true, verb: 'get', current } : null
        }

        case 'apply': {
            if (!onlyKeys(value, ['ok', 'verb', 'ids', 'previous'])) return null
            const ids = parseIds(value.ids)
            if (!ids) return null
            if (value.previous === null) return { ok: true, verb: 'apply', ids, previous: null }
            const previous = parseSpec(value.previous)
            return previous ? { ok: true, verb: 'apply', ids, previous } : null
        }

        case 'remove':
            return onlyKeys(value, ['ok', 'verb']) ? { ok: true, verb: 'remove' } : null

        default:
            return null
    }
}
