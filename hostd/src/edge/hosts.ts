// edge's core: putting an environment's rendered hosts onto Nginx Proxy Manager, and nothing else.
// NPM also fronts services hostd has no business with (WireGuard, DNS admin, Proxmox), so every update
// or delete first re-reads the host and refuses unless its first advanced_config line is this
// environment's marker. The one exception is adopt, which may take over an unmarked host only when it
// is plainly this environment's (serves its primary, forwards to its upstream).
//
// NPM answers 200 even when the nginx config it wrote fails `nginx -t`; it then moves that host's
// config aside, so the host is offline. Each write's meta.nginx_online is therefore checked, and on a
// failure (or any NPM error part-way) every write this call made is undone in reverse order, so the
// site comes back as it was. The undo lives here because only edge holds the previous state.

import { describeError } from '../shared/formats.ts'
import { markerFor, ownerOf, type EdgeReply, type FoundHost, type HostsSpec, type Owner, type ProxyHostSpec, type RedirectionHostSpec } from '../shared/edge-protocol.ts'
import type { NpmIds } from '../shared/registry.ts'
import { NpmError, type NpmClient, type NpmHostKind, type NpmRecord } from './npm-client.ts'

export type HostsDeps = { npm: Pick<NpmClient, 'list' | 'get' | 'create' | 'update' | 'remove' | 'certificateIds'>, upstreamHost: string }

// The values hostd always writes (Global Constraints). Redirection hosts get only the ones NPM's
// redirection-host schema accepts: it refuses unknown keys such as locations or caching_enabled.
const PROXY_FIXED = {
    forward_scheme: 'http', hsts_enabled: false, hsts_subdomains: false, caching_enabled: false,
    access_list_id: 0, block_exploits: true, allow_websocket_upgrade: true,
} as const
const REDIRECTION_FIXED = {
    forward_scheme: 'https', forward_http_code: 301, preserve_path: true,
    hsts_enabled: false, hsts_subdomains: false, block_exploits: true,
} as const

const KIND_NAMES: Record<NpmHostKind, string> = { 'proxy-hosts': 'proxy host', 'redirection-hosts': 'redirection host', 'dead-hosts': '404 host' }

function refuse(problem: string, output?: string): EdgeReply {
    return output === undefined ? { ok: false, problem } : { ok: false, problem, output }
}

// An NPM error's body is NPM's own explanation (a duplicate domain, a schema complaint), which is worth
// showing; it never carries the credentials, which only go to /tokens.
function failure(error: unknown): EdgeReply {
    return error instanceof NpmError && error.body !== '' ? refuse(describeError(error), error.body) : refuse(describeError(error))
}

function proxyBody(spec: ProxyHostSpec): Record<string, unknown> {
    return {
        domain_names: spec.domain_names, forward_host: spec.forward_host, forward_port: spec.forward_port,
        certificate_id: spec.certificate_id, ssl_forced: spec.ssl_forced, http2_support: spec.http2_support,
        advanced_config: spec.advanced_config, ...PROXY_FIXED, locations: [], meta: {},
    }
}

function redirectionBody(spec: RedirectionHostSpec): Record<string, unknown> {
    return {
        domain_names: spec.domain_names, forward_domain_name: spec.forward_domain_name,
        certificate_id: spec.certificate_id, ssl_forced: spec.ssl_forced, http2_support: spec.http2_support,
        advanced_config: spec.advanced_config, ...REDIRECTION_FIXED, meta: {},
    }
}

// NPM's sqlite answers booleans as 0/1.
function bool(value: unknown): boolean {
    return value === true || value === 1
}

function int(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function proxySpecOf(record: NpmRecord): ProxyHostSpec {
    return {
        domain_names: [...record.domain_names], forward_host: text(record.forward_host), forward_port: int(record.forward_port),
        certificate_id: int(record.certificate_id), ssl_forced: bool(record.ssl_forced), http2_support: bool(record.http2_support),
        advanced_config: text(record.advanced_config),
    }
}

function redirectionSpecOf(record: NpmRecord): RedirectionHostSpec {
    return {
        domain_names: [...record.domain_names], forward_domain_name: text(record.forward_domain_name),
        certificate_id: int(record.certificate_id), ssl_forced: bool(record.ssl_forced), http2_support: bool(record.http2_support),
        advanced_config: text(record.advanced_config),
    }
}

// The body that puts a host back as it was: the managed fields from the pre-call spec, and the fixed
// fields as the record had them, so a hand-made host's own choices (HSTS, say) come back too.
function revertBody(kind: 'proxy-hosts' | 'redirection-hosts', record: NpmRecord): Record<string, unknown> {
    const fixed: Record<string, unknown> = kind === 'proxy-hosts' ? PROXY_FIXED : REDIRECTION_FIXED
    const body = kind === 'proxy-hosts' ? proxyBody(proxySpecOf(record)) : redirectionBody(redirectionSpecOf(record))
    for (const [key, value] of Object.entries(fixed)) {
        if (record[key] === undefined || record[key] === null) continue
        body[key] = typeof value === 'boolean' ? bool(record[key]) : record[key]
    }
    if (kind === 'proxy-hosts' && Array.isArray(record.locations)) body.locations = record.locations
    return body
}

// Hostnames reach edge already normalised by the agent; hand-made NPM hosts may not be.
function hostname(name: string): string {
    return name.toLowerCase().replace(/\.$/, '')
}

function sameOwner(found: Owner | null, owner: Owner): boolean {
    return found !== null && found.project === owner.project && found.environment === owner.environment
}

function ownerName(owner: Owner): string {
    return `${owner.project}/${owner.environment}`
}

function hasLocations(record: NpmRecord): boolean {
    return Array.isArray(record.locations) && record.locations.length > 0
}

function notOwned(kind: NpmHostKind, record: NpmRecord, owner: Owner): string | null {
    if (sameOwner(ownerOf(text(record.advanced_config)), owner)) return null
    return `NPM ${KIND_NAMES[kind]} ${record.id} does not carry the marker for ${ownerName(owner)}, so hostd will not change it`
}

// The brotli snippet every live host carries (Global Constraints); hostd renders it too, so it is the
// one piece of a hand-made advanced_config that adopting keeps rather than strips.
const BROTLI = 'if ($http_content_encoding ~* "(^|,)\\s*br\\s*(,|$)") {\n    return 415;\n}'

// Adopt overwrites advanced_config, so anything in it besides the brotli snippet would be lost silently.
function customDirectives(kind: 'proxy-hosts' | 'redirection-hosts', record: NpmRecord): string | null {
    const config = text(record.advanced_config).replace(/\r\n/g, '\n').trim()
    if (config === '' || config === BROTLI) return null
    const first = config.split('\n', 1)[0]!.trim()
    return `NPM ${KIND_NAMES[kind]} ${record.id} has custom nginx directives: ${first} (move them out in NPM or leave this host to be managed by hand)`
}

// Whether this call may write over the proxy host it was given. An owned host always; an unmarked one
// only under adopt, and only when it is unmistakably this environment's site.
function proxyClaimProblem(deps: HostsDeps, record: NpmRecord, owner: Owner, spec: HostsSpec, adopt: boolean): string | null {
    const marked = ownerOf(text(record.advanced_config))
    if (sameOwner(marked, owner)) return null
    const refusal = notOwned('proxy-hosts', record, owner)!
    // Another environment's marker is never adoptable: that host is already hostd's, just not this one's.
    if (!adopt || marked !== null) return refusal
    const primary = spec.proxy.domain_names[0]!
    const domains = record.domain_names.map(hostname)
    if (!domains.includes(hostname(primary))) return `NPM proxy host ${record.id} does not serve ${primary}, so hostd will not adopt it`
    const forward = `${text(record.forward_host)}:${int(record.forward_port)}`
    const wanted = `${deps.upstreamHost}:${spec.proxy.forward_port}`
    if (forward !== wanted || spec.proxy.forward_host !== deps.upstreamHost) {
        return `NPM proxy host ${record.id} forwards to ${forward}, not ${wanted}, so hostd will not adopt it`
    }
    // hostd writes locations: [], so adopting would silently drop them.
    if (hasLocations(record)) return `NPM proxy host ${record.id} has custom locations, so hostd will not adopt it`
    // hostd writes access_list_id 0, so adopting would silently open a host that is meant to be private.
    const accessList = int(record.access_list_id)
    if (accessList !== 0) return `NPM proxy host ${record.id} has access list ${accessList}; remove it in NPM or leave this host to be managed by hand`
    const directives = customDirectives('proxy-hosts', record)
    if (directives) return directives
    const covered = allDomains(spec).map(hostname)
    const stray = record.domain_names.find(name => !covered.includes(hostname(name)))
    if (stray !== undefined) return `NPM proxy host ${record.id} also serves ${stray}, which this environment does not list, so hostd will not adopt it`
    return null
}

function redirectionClaimProblem(record: NpmRecord, owner: Owner, spec: HostsSpec, adopt: boolean): string | null {
    const marked = ownerOf(text(record.advanced_config))
    if (sameOwner(marked, owner)) return null
    const refusal = notOwned('redirection-hosts', record, owner)!
    if (!adopt || marked !== null) return refusal
    const primary = spec.proxy.domain_names[0]!
    if (hostname(text(record.forward_domain_name)) !== hostname(primary)) {
        return `NPM redirection host ${record.id} redirects to ${text(record.forward_domain_name)}, not ${primary}, so hostd will not adopt it`
    }
    const directives = customDirectives('redirection-hosts', record)
    if (directives) return directives
    const covered = allDomains(spec).map(hostname)
    const stray = record.domain_names.find(name => !covered.includes(hostname(name)))
    if (stray !== undefined) return `NPM redirection host ${record.id} also serves ${stray}, which this environment does not list, so hostd will not adopt it`
    return null
}

function allDomains(spec: HostsSpec): string[] {
    return [...spec.proxy.domain_names, ...(spec.redirection?.domain_names ?? [])]
}

function foundHost(kind: NpmHostKind, record: NpmRecord): FoundHost {
    const owner = ownerOf(text(record.advanced_config))
    if (kind === 'proxy-hosts') {
        return {
            kind: 'proxy', id: record.id, domain_names: [...record.domain_names], owner,
            forward_host: text(record.forward_host), forward_port: int(record.forward_port), hasLocations: hasLocations(record), spec: proxySpecOf(record),
        }
    }
    if (kind === 'redirection-hosts') {
        return {
            kind: 'redirection', id: record.id, domain_names: [...record.domain_names], owner,
            forward_host: null, forward_port: null, hasLocations: false, spec: redirectionSpecOf(record),
        }
    }
    return { kind: 'dead', id: record.id, domain_names: [...record.domain_names], owner, forward_host: null, forward_port: null, hasLocations: false, spec: null }
}

async function find(deps: HostsDeps, domains: string[]): Promise<{ kind: NpmHostKind, host: FoundHost }[]> {
    const wanted = domains.map(hostname)
    const out: { kind: NpmHostKind, host: FoundHost }[] = []
    for (const kind of ['proxy-hosts', 'redirection-hosts', 'dead-hosts'] as const) {
        for (const record of await deps.npm.list(kind)) {
            if (record.domain_names.some(name => wanted.includes(hostname(name)))) out.push({ kind, host: foundHost(kind, record) })
        }
    }
    return out
}

export async function findHosts(deps: HostsDeps, domains: string[]): Promise<EdgeReply> {
    try {
        return { ok: true, verb: 'find', hosts: (await find(deps, domains)).map(entry => entry.host) }
    } catch (error) {
        return failure(error)
    }
}

// Raised inside applyHosts when a write lands with nginx offline; carries NPM's nginx -t output.
class NginxRefused extends Error {
    output: string | undefined
    constructor(output: string | undefined) {
        super('nginx refused the configuration')
        this.output = output
    }
}

function offline(record: NpmRecord): NginxRefused | null {
    const meta = record.meta
    if (!meta || meta.nginx_online !== false) return null
    return new NginxRefused(meta.nginx_err === undefined || meta.nginx_err === null ? undefined : String(meta.nginx_err))
}

function firstLine(config: string): string {
    return config.split('\n', 1)[0] ?? ''
}

function carriesMarker(spec: HostsSpec, owner: Owner): boolean {
    const marker = markerFor(owner)
    return firstLine(spec.proxy.advanced_config) === marker && (!spec.redirection || firstLine(spec.redirection.advanced_config) === marker)
}

function sameDomains(a: string[], b: string[]): boolean {
    const left = a.map(hostname).sort()
    const right = b.map(hostname).sort()
    return left.length === right.length && left.every((name, at) => name === right[at])
}

// A create that throws may still have landed (a timeout after NPM stored it), and then there is a host
// hostd holds no id for. A 4xx is NPM saying no, so nothing was created and there is nothing to check.
function mayHaveCreated(kind: NpmHostKind, error: unknown): unknown {
    if (error instanceof NpmError && error.status !== null && error.status >= 400 && error.status < 500) return error
    const message = `${describeError(error)}; NPM may have created the ${KIND_NAMES[kind]} anyway, so check NPM for it`
    return error instanceof NpmError ? new NpmError(message, error.status, error.body) : new Error(message)
}

// An undo step answers a note when it changed something the caller must hear about (a host recreated
// under a new id), otherwise null.
type Undo = () => Promise<string | null>

export async function applyHosts(deps: HostsDeps, owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean): Promise<EdgeReply> {
    const primary = spec.proxy.domain_names[0]
    if (primary === undefined) return refuse('The proxy host has no domain names')
    // Adopt takes over a host that exists; with nothing to take over it must not quietly create one.
    if (adopt && ids === null) return refuse(`Adopt needs the NPM proxy host to take over for ${ownerName(owner)}`)
    const proxyDomains = spec.proxy.domain_names.map(hostname)
    const doubled = spec.redirection?.domain_names.find(name => proxyDomains.includes(hostname(name)))
    if (doubled !== undefined) return refuse(`${doubled} is on both the proxy host and the redirection host`)
    // A host created or adopted without its marker could never be touched again. An update of a host
    // that already carries the marker may drop it: that is how the adoption undo hands a host back, and
    // the guard that matters, the current host's marker, is checked below before anything is written.
    if ((ids === null || adopt) && !carriesMarker(spec, owner)) return refuse(`The hosts for ${ownerName(owner)} must start with its marker`)

    const undo: Undo[] = []
    try {
        const certificates = [spec.proxy.certificate_id, spec.redirection?.certificate_id ?? 0].filter(id => id !== 0)
        if (certificates.length > 0) {
            const known = await deps.npm.certificateIds()
            const missing = certificates.find(id => !known.includes(id))
            if (missing !== undefined) return refuse(`NPM has no certificate ${missing}`)
        }

        let proxyRecord: NpmRecord | null = null
        let redirectionRecord: NpmRecord | null = null
        if (ids) {
            proxyRecord = await deps.npm.get('proxy-hosts', ids.proxyHost)
            if (!proxyRecord) return refuse(`NPM proxy host ${ids.proxyHost} does not exist`)
            const proxyProblem = proxyClaimProblem(deps, proxyRecord, owner, spec, adopt)
            if (proxyProblem) return refuse(proxyProblem)
            // A redirection host deleted by hand leaves nothing to protect: a new one is created below.
            if (ids.redirectionHost !== null) redirectionRecord = await deps.npm.get('redirection-hosts', ids.redirectionHost)
            const redirectionProblem = redirectionRecord && redirectionClaimProblem(redirectionRecord, owner, spec, adopt)
            if (redirectionProblem) return refuse(redirectionProblem)
        }

        // NPM refuses a domain that another host has; checking first gives an error the portal can show,
        // and means no write is attempted that would have to be undone.
        const elsewhere = (await find(deps, allDomains(spec))).filter(({ kind, host }) =>
            !(kind === 'proxy-hosts' && host.id === proxyRecord?.id) && !(kind === 'redirection-hosts' && host.id === redirectionRecord?.id))
        const clash = elsewhere[0]
        if (clash) {
            const taken = clash.host.domain_names.map(hostname)
            const domain = allDomains(spec).find(name => taken.includes(hostname(name)))!
            return refuse(`${domain} is already on NPM ${KIND_NAMES[clash.kind]} ${clash.host.id}`)
        }

        const previous: HostsSpec | null = proxyRecord
            ? { proxy: proxySpecOf(proxyRecord), redirection: redirectionRecord ? redirectionSpecOf(redirectionRecord) : null }
            : null

        // A create's undo is registered once there is an id to delete, and before its result is judged,
        // so an offline host is removed too.
        const create = async (kind: 'proxy-hosts' | 'redirection-hosts', body: Record<string, unknown>): Promise<number> => {
            let record: NpmRecord
            try {
                record = await deps.npm.create(kind, body)
            } catch (error) {
                throw mayHaveCreated(kind, error)
            }
            undo.push(async () => {
                await deps.npm.remove(kind, record.id)
                return null
            })
            const refused = offline(record)
            if (refused) throw refused
            return record.id
        }
        // Registered before the call: NPM may store the write and still fail the reply (a timeout), and
        // writing the before-state again is harmless when it did not.
        const update = async (kind: 'proxy-hosts' | 'redirection-hosts', before: NpmRecord, body: Record<string, unknown>): Promise<void> => {
            undo.push(async () => {
                const back = await deps.npm.update(kind, before.id, revertBody(kind, before))
                if (offline(back)) throw new Error(`NPM ${KIND_NAMES[kind]} ${before.id} is still offline after putting it back`)
                return null
            })
            const refused = offline(await deps.npm.update(kind, before.id, body))
            if (refused) throw refused
        }
        // Registered before the call for the same reason. If the host is gone it is recreated, and NPM
        // gives it a new id, which the agent has to record, so the undo says which.
        const remove = async (kind: 'redirection-hosts', before: NpmRecord): Promise<void> => {
            undo.push(async () => {
                if (await deps.npm.get(kind, before.id)) {
                    const back = await deps.npm.update(kind, before.id, revertBody(kind, before))
                    if (offline(back)) throw new Error(`NPM ${KIND_NAMES[kind]} ${before.id} is still offline after putting it back`)
                    return null
                }
                const back = await deps.npm.create(kind, revertBody(kind, before))
                const moved = `NPM ${KIND_NAMES[kind]} ${before.id} was put back as NPM ${KIND_NAMES[kind]} ${back.id}`
                if (offline(back)) throw new Error(`${moved}, which is offline`)
                return moved
            })
            await deps.npm.remove(kind, before.id)
        }

        // NPM will not let two hosts hold one domain, so whichever host gives a domain up is written
        // first. Usually that is the proxy (aliases move off it onto the redirection host). When the proxy
        // takes domains back from the redirection host (the adoption undo puts the aliases back on a
        // hand-made proxy host), the redirection host lets go of them first: trimmed, or deleted if
        // nothing is left.
        let redirection = redirectionRecord
        let redirectionWritten = false
        if (redirection && redirection.domain_names.some(name => proxyDomains.includes(hostname(name)))) {
            const remaining = redirection.domain_names.filter(name => !proxyDomains.includes(hostname(name)))
            if (!spec.redirection || remaining.length === 0) {
                await remove('redirection-hosts', redirection)
                redirection = null
            } else {
                redirectionWritten = sameDomains(remaining, spec.redirection.domain_names)
                const interim = redirectionWritten ? spec.redirection : { ...redirectionSpecOf(redirection), domain_names: remaining }
                await update('redirection-hosts', redirection, redirectionBody(interim))
            }
        }

        let proxyHost: number
        if (proxyRecord) {
            await update('proxy-hosts', proxyRecord, proxyBody(spec.proxy))
            proxyHost = proxyRecord.id
        } else {
            proxyHost = await create('proxy-hosts', proxyBody(spec.proxy))
        }

        let redirectionHost: number | null = null
        if (spec.redirection) {
            if (redirection) {
                if (!redirectionWritten) await update('redirection-hosts', redirection, redirectionBody(spec.redirection))
                redirectionHost = redirection.id
            } else {
                redirectionHost = await create('redirection-hosts', redirectionBody(spec.redirection))
            }
        } else if (redirection) {
            await remove('redirection-hosts', redirection)
        }
        return { ok: true, verb: 'apply', ids: { proxyHost, redirectionHost }, previous }
    } catch (error) {
        const notes: string[] = []
        const undoProblems: string[] = []
        for (const step of undo.reverse()) {
            try {
                const note = await step()
                if (note) notes.push(note)
            } catch (undoError) {
                undoProblems.push(describeError(undoError))
            }
        }
        const reply = error instanceof NginxRefused
            ? refuse(`NPM refused the configuration for ${owner.project} ${owner.environment}`, error.output)
            : failure(error)
        if (reply.ok) return reply
        let problem = reply.problem
        // The site may be down: say so plainly rather than leave it to be found.
        if (undoProblems.length > 0) problem += `, and putting the previous state back failed: ${undoProblems.join('; ')}`
        if (notes.length > 0) problem += `. ${notes.join('. ')}`
        return { ...reply, problem }
    }
}

// Both hosts are checked before either is deleted, so a refusal deletes nothing.
export async function removeHosts(deps: HostsDeps, owner: Owner, ids: NpmIds): Promise<EdgeReply> {
    try {
        const redirection = ids.redirectionHost === null ? null : await deps.npm.get('redirection-hosts', ids.redirectionHost)
        const proxy = await deps.npm.get('proxy-hosts', ids.proxyHost)
        const problem = (redirection && notOwned('redirection-hosts', redirection, owner)) || (proxy && notOwned('proxy-hosts', proxy, owner))
        if (problem) return refuse(problem)
        if (redirection) await deps.npm.remove('redirection-hosts', redirection.id)
        if (proxy) await deps.npm.remove('proxy-hosts', proxy.id)
        return { ok: true, verb: 'remove' }
    } catch (error) {
        return failure(error)
    }
}

// Read-only, but still owner-checked: a host whose marker was removed is no longer hostd's to report on
// as its own, and the refusal is how health learns that.
export async function getHosts(deps: HostsDeps, owner: Owner, ids: NpmIds): Promise<EdgeReply> {
    try {
        const proxy = await deps.npm.get('proxy-hosts', ids.proxyHost)
        if (!proxy) return { ok: true, verb: 'get', current: null }
        const proxyProblem = notOwned('proxy-hosts', proxy, owner)
        if (proxyProblem) return refuse(proxyProblem)
        const redirection = ids.redirectionHost === null ? null : await deps.npm.get('redirection-hosts', ids.redirectionHost)
        const redirectionProblem = redirection && notOwned('redirection-hosts', redirection, owner)
        if (redirectionProblem) return refuse(redirectionProblem)
        return { ok: true, verb: 'get', current: { proxy: proxySpecOf(proxy), redirection: redirection ? redirectionSpecOf(redirection) : null } }
    } catch (error) {
        return failure(error)
    }
}
