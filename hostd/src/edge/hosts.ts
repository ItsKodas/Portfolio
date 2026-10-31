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
//
// NPMplus (HOSTD_NPM_FLAVOUR=npmplus) differs in what may be written and how a record reads, never in
// the guard. Its schemas refuse any unknown key and its PUT is partial, so edge sends only the fields
// hostd manages and every NPMplus feature set by hand on a host (CrowdSec, access lists, HTTP/3,
// mTLS...) stays exactly as it is, on adopt, on every later write and on the adoption undo. Its nginx
// state is the top-level npmplus_nginx_online/npmplus_nginx_err rather than meta's.

import { describeError } from '../shared/formats.ts'
import {
    markerFor, ownerOf, type EdgeReply, type FoundHost, type HostsSpec, type Owner, type PreviousHosts, type ProxyFixed, type ProxyHostSpec, type RedirectionHostSpec,
} from '../shared/edge-protocol.ts'
import { npmIds, type NpmIds } from '../shared/registry.ts'
import { NpmError, type NpmClient, type NpmFlavour, type NpmHostKind, type NpmRecord } from './npm-client.ts'

// flavour defaults to stock NPM, which is what every caller that does not say meant before NPMplus.
export type HostsDeps = { npm: Pick<NpmClient, 'list' | 'get' | 'create' | 'update' | 'remove' | 'certificateIds'>, upstreamHost: string, flavour?: NpmFlavour }

function flavourOf(deps: HostsDeps): NpmFlavour {
    return deps.flavour ?? 'npm'
}

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

// What NPMplus accepts on a redirection host write (its post.json, certificate request keys left out),
// used only to recreate a deleted one as it was rather than with NPMplus's defaults.
const NPMPLUS_REDIRECTION_WRITABLE = [
    'domain_names', 'forward_http_code', 'forward_scheme', 'forward_domain_name', 'preserve_path', 'certificate_id', 'ssl_forced',
    'hsts_enabled', 'hsts_subdomains', 'npmplus_http3_support', 'advanced_config', 'npmplus_directory', 'npmplus_mtls_certificate_id',
    'npmplus_mtls_verify_client_optional',
]

const KIND_NAMES: Record<NpmHostKind, string> = { 'proxy-hosts': 'proxy host', 'redirection-hosts': 'redirection host', 'dead-hosts': '404 host' }

function refuse(problem: string, output?: string): EdgeReply {
    return output === undefined ? { ok: false, problem } : { ok: false, problem, output }
}

// An NPM error's body is NPM's own explanation (a duplicate domain, a schema complaint), which is worth
// showing; it never carries the credentials, which only go to /tokens.
function failure(error: unknown): EdgeReply {
    return error instanceof NpmError && error.body !== '' ? refuse(describeError(error), error.body) : refuse(describeError(error))
}

// restore is only ever the adoption undo's (applyHosts checks), giving a hand-made host its own values back.
// NPMplus gets the managed fields alone: there are no fixed fields to force or restore (websockets are
// always on there), and a field left out of its partial PUT keeps the value it had.
function proxyBody(flavour: NpmFlavour, spec: ProxyHostSpec, restore?: ProxyFixed): Record<string, unknown> {
    if (flavour === 'npmplus') {
        return {
            domain_names: spec.domain_names, forward_scheme: 'http', forward_host: spec.forward_host, forward_port: spec.forward_port,
            certificate_id: spec.certificate_id, ssl_forced: spec.ssl_forced, advanced_config: spec.advanced_config,
        }
    }
    return {
        domain_names: spec.domain_names, forward_host: spec.forward_host, forward_port: spec.forward_port,
        certificate_id: spec.certificate_id, ssl_forced: spec.ssl_forced, http2_support: spec.http2_support,
        advanced_config: spec.advanced_config, ...PROXY_FIXED, ...restore, locations: [], meta: {},
    }
}

function redirectionBody(flavour: NpmFlavour, spec: RedirectionHostSpec): Record<string, unknown> {
    if (flavour === 'npmplus') {
        return {
            domain_names: spec.domain_names, forward_domain_name: spec.forward_domain_name, forward_scheme: REDIRECTION_FIXED.forward_scheme,
            forward_http_code: REDIRECTION_FIXED.forward_http_code, preserve_path: REDIRECTION_FIXED.preserve_path,
            certificate_id: spec.certificate_id, ssl_forced: spec.ssl_forced, advanced_config: spec.advanced_config,
        }
    }
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

// NPMplus has no per-host HTTP/2 switch: its nginx.conf turns http2 on for every TLS listener, so a
// host serves HTTP/2 exactly when it has a certificate. Reading it that way keeps drift quiet about a
// field NPMplus does not have, while still telling the truth about what the host serves.
function http2Of(flavour: NpmFlavour, record: NpmRecord): boolean {
    return flavour === 'npmplus' ? int(record.certificate_id) > 0 : bool(record.http2_support)
}

function proxySpecOf(flavour: NpmFlavour, record: NpmRecord): ProxyHostSpec {
    return {
        domain_names: [...record.domain_names], forward_host: text(record.forward_host), forward_port: int(record.forward_port),
        certificate_id: int(record.certificate_id), ssl_forced: bool(record.ssl_forced), http2_support: http2Of(flavour, record),
        advanced_config: text(record.advanced_config),
    }
}

function redirectionSpecOf(flavour: NpmFlavour, record: NpmRecord): RedirectionHostSpec {
    return {
        domain_names: [...record.domain_names], forward_domain_name: text(record.forward_domain_name),
        certificate_id: int(record.certificate_id), ssl_forced: bool(record.ssl_forced), http2_support: http2Of(flavour, record),
        advanced_config: text(record.advanced_config),
    }
}

// A proxy host's fixed fields as it has them, each falling back to hostd's own value when NPM left it out.
function fixedOf(record: NpmRecord): ProxyFixed {
    const flag = (key: keyof typeof PROXY_FIXED, fallback: boolean) => record[key] === undefined || record[key] === null ? fallback : bool(record[key])
    return {
        forward_scheme: record.forward_scheme === 'https' ? 'https' : 'http',
        block_exploits: flag('block_exploits', PROXY_FIXED.block_exploits),
        allow_websocket_upgrade: flag('allow_websocket_upgrade', PROXY_FIXED.allow_websocket_upgrade),
        hsts_enabled: flag('hsts_enabled', PROXY_FIXED.hsts_enabled),
        hsts_subdomains: flag('hsts_subdomains', PROXY_FIXED.hsts_subdomains),
        caching_enabled: flag('caching_enabled', PROXY_FIXED.caching_enabled),
    }
}

// The body that puts a host back as it was: the managed fields from the pre-call spec, and the fixed
// fields as the record had them, so a hand-made host's own choices (HSTS, say) come back too. On NPMplus
// only the managed fields were written, so only they go back (with the record's own scheme, code and
// path setting); the partial PUT leaves everything else as it still is.
function revertBody(flavour: NpmFlavour, kind: 'proxy-hosts' | 'redirection-hosts', record: NpmRecord): Record<string, unknown> {
    if (flavour === 'npmplus') {
        const body = kind === 'proxy-hosts' ? proxyBody(flavour, proxySpecOf(flavour, record)) : redirectionBody(flavour, redirectionSpecOf(flavour, record))
        for (const key of ['forward_scheme', 'forward_http_code', 'preserve_path']) {
            if (!(key in body) || record[key] === undefined || record[key] === null) continue
            body[key] = key === 'preserve_path' ? bool(record[key]) : record[key]
        }
        return body
    }
    const fixed: Record<string, unknown> = kind === 'proxy-hosts' ? PROXY_FIXED : REDIRECTION_FIXED
    const body = kind === 'proxy-hosts' ? proxyBody(flavour, proxySpecOf(flavour, record)) : redirectionBody(flavour, redirectionSpecOf(flavour, record))
    for (const [key, value] of Object.entries(fixed)) {
        if (record[key] === undefined || record[key] === null) continue
        body[key] = typeof value === 'boolean' ? bool(record[key]) : record[key]
    }
    if (kind === 'proxy-hosts' && Array.isArray(record.locations)) body.locations = record.locations
    return body
}

// A deleted redirection host recreated by an undo. On NPMplus a create takes NPMplus's defaults for
// whatever it leaves out, so every setting the record had that NPMplus accepts goes back with it.
function recreateBody(flavour: NpmFlavour, record: NpmRecord): Record<string, unknown> {
    const body = revertBody(flavour, 'redirection-hosts', record)
    if (flavour !== 'npmplus') return body
    for (const key of NPMPLUS_REDIRECTION_WRITABLE) {
        if (!(key in body) && record[key] !== undefined && record[key] !== null) body[key] = record[key]
    }
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
    const flavour = flavourOf(deps)
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
    if (flavour === 'npm') {
        // hostd writes access_list_id 0, so adopting would silently open a host that is meant to be private.
        // NPMplus needs no such refusal: edge never sends its access list fields, so they stay as they are.
        const accessList = int(record.access_list_id)
        if (accessList !== 0) return `NPM proxy host ${record.id} has access list ${accessList}; remove it in NPM or leave this host to be managed by hand`
    } else {
        const problem = npmplusAdoptProblem(record)
        if (problem) return problem
    }
    const directives = customDirectives('proxy-hosts', record)
    if (directives) return directives
    const covered = allDomains(spec).map(hostname)
    const stray = record.domain_names.find(name => !covered.includes(hostname(name)))
    if (stray !== undefined) return `NPM proxy host ${record.id} also serves ${stray}, which this environment does not list, so hostd will not adopt it`
    return null
}

// What NPMplus can put in front of a proxy host that adopting would break or lose. Its auth_request, a
// required client certificate and its custom location config all sit in front of
// /.well-known/hostd/<token>, so verification would fail. hostd writes forward_scheme http, and with no fixed fields on NPMplus the adoption undo
// could not put https back, so a host forwarding over https is left to be managed by hand.
function npmplusAdoptProblem(record: NpmRecord): string | null {
    const auth = text(record.npmplus_auth_request)
    if (auth !== '' && auth !== 'none') {
        return `NPM proxy host ${record.id} puts ${auth} auth in front of every request (npmplus_auth_request), which hostd's verification cannot pass; turn it off in NPMplus or leave this host to be managed by hand`
    }
    // A required client certificate turns away the verifier's request, which carries none. An optional
    // one lets it through.
    const mtls = int(record.npmplus_mtls_certificate_id)
    if (mtls > 0 && !bool(record.npmplus_mtls_verify_client_optional)) {
        return `NPM proxy host ${record.id} requires a client certificate (mTLS, certificate ${mtls}), which hostd's verification cannot present; make it optional or turn it off in NPMplus, or leave this host to be managed by hand`
    }
    const locations = text(record.npmplus_location_config).replace(/\r\n/g, '\n').trim()
    if (locations !== '') {
        return `NPM proxy host ${record.id} has custom location config: ${locations.split('\n', 1)[0]!.trim()} (move it out in NPMplus or leave this host to be managed by hand)`
    }
    const scheme = text(record.forward_scheme)
    if (scheme !== '' && scheme !== 'http') {
        return `NPM proxy host ${record.id} forwards over ${scheme}, and hostd forwards over http; change it in NPMplus or leave this host to be managed by hand`
    }
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

// The two redirection hosts an environment may have: the covered one, with the environment's
// certificate, and the flexible one, with none, for aliases no certificate covers (Full SSL primary).
// They are the same kind of NPM host, so the guard, adopt rules and undo are the same for both.
type Slot = 'covered' | 'flexible'
const SLOTS: Slot[] = ['covered', 'flexible']
const SLOT_NAMES: Record<Slot, string> = { covered: 'redirection host', flexible: 'flexible redirection host' }

function slotSpec(spec: HostsSpec, slot: Slot): RedirectionHostSpec | null {
    return slot === 'covered' ? spec.redirection : spec.flexibleRedirection ?? null
}

function allDomains(spec: HostsSpec): string[] {
    return [...spec.proxy.domain_names, ...SLOTS.flatMap(slot => slotSpec(spec, slot)?.domain_names ?? [])]
}

function foundHost(flavour: NpmFlavour, kind: NpmHostKind, record: NpmRecord): FoundHost {
    const owner = ownerOf(text(record.advanced_config))
    if (kind === 'proxy-hosts') {
        return {
            kind: 'proxy', id: record.id, domain_names: [...record.domain_names], owner,
            forward_host: text(record.forward_host), forward_port: int(record.forward_port), hasLocations: hasLocations(record), spec: proxySpecOf(flavour, record),
        }
    }
    if (kind === 'redirection-hosts') {
        return {
            kind: 'redirection', id: record.id, domain_names: [...record.domain_names], owner,
            forward_host: null, forward_port: null, hasLocations: false, spec: redirectionSpecOf(flavour, record),
        }
    }
    return { kind: 'dead', id: record.id, domain_names: [...record.domain_names], owner, forward_host: null, forward_port: null, hasLocations: false, spec: null }
}

async function find(deps: HostsDeps, domains: string[]): Promise<{ kind: NpmHostKind, host: FoundHost }[]> {
    const wanted = domains.map(hostname)
    const out: { kind: NpmHostKind, host: FoundHost }[] = []
    for (const kind of ['proxy-hosts', 'redirection-hosts', 'dead-hosts'] as const) {
        for (const record of await deps.npm.list(kind)) {
            if (record.domain_names.some(name => wanted.includes(hostname(name)))) out.push({ kind, host: foundHost(flavourOf(deps), kind, record) })
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

// The one place a write's nginx state is read. NPM keeps it in meta, NPMplus at the top level.
function offline(flavour: NpmFlavour, record: NpmRecord): NginxRefused | null {
    const state = flavour === 'npmplus'
        ? { online: record.npmplus_nginx_online, err: record.npmplus_nginx_err }
        : { online: record.meta?.nginx_online, err: record.meta?.nginx_err }
    if (state.online !== false && state.online !== 0) return null
    return new NginxRefused(state.err === undefined || state.err === null || state.err === '' ? undefined : String(state.err))
}

function firstLine(config: string): string {
    return config.split('\n', 1)[0] ?? ''
}

function carriesMarker(spec: HostsSpec, owner: Owner): boolean {
    const marker = markerFor(owner)
    return firstLine(spec.proxy.advanced_config) === marker && SLOTS.every(slot => {
        const redirection = slotSpec(spec, slot)
        return !redirection || firstLine(redirection.advanced_config) === marker
    })
}

// "7 and 8", "7, 8 and 9"
function idList(ids: number[]): string {
    return ids.length === 1 ? String(ids[0]) : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
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

type Orphans = { ok: true, found: Partial<Record<Slot, NpmRecord>> } | { ok: false, problem: string }

// This owner's redirection hosts that no recorded id names, matched to the slots (open) whose id named
// nothing. Only a host carrying this owner's exact marker is ever considered. Each is taken for the slot
// whose aliases it serves; one serving aliases of both, or two serving one slot's, is a guess hostd will
// not make, so it refuses and names them for Koda to sort out in NPM.
async function orphanedRedirections(deps: HostsDeps, owner: Owner, spec: HostsSpec, open: Slot[], known: number[]): Promise<Orphans> {
    if (open.length === 0) return { ok: true, found: {} }
    const ours = (await deps.npm.list('redirection-hosts'))
        .filter(record => !known.includes(record.id) && sameOwner(ownerOf(text(record.advanced_config)), owner))
    const serves = (record: NpmRecord, slot: Slot): boolean => {
        const wanted = (slotSpec(spec, slot)?.domain_names ?? []).map(hostname)
        return record.domain_names.some(name => wanted.includes(hostname(name)))
    }
    const claims: Record<Slot, NpmRecord[]> = { covered: [], flexible: [] }
    const unplaced: NpmRecord[] = []
    for (const record of ours) {
        const slots = open.filter(slot => serves(record, slot))
        if (slots.length > 1) {
            return {
                ok: false,
                problem: `NPM redirection host ${record.id} carries the marker for ${ownerName(owner)} and serves aliases of both its redirection hosts, `
                    + 'so hostd cannot tell which one it is; delete it in NPM and try again',
            }
        }
        if (slots.length === 1) claims[slots[0]!].push(record)
        else unplaced.push(record)
    }
    for (const slot of open) {
        const competing = claims[slot]
        if (competing.length > 1) {
            return {
                ok: false,
                problem: `NPM redirection hosts ${idList(competing.map(record => record.id))} ${competing.length === 2 ? 'both' : 'all'} carry the marker for `
                    + `${ownerName(owner)} and serve the aliases of its ${SLOT_NAMES[slot]}; delete all but one in NPM and try again`,
            }
        }
    }
    // One sharing no alias with either slot (it holds the primary, or names since removed) was taken for
    // the redirection host before the flexible one existed, to be trimmed or deleted, and still is. The
    // flexible slot only ever takes a host serving its own aliases: every environment recorded before it
    // existed has that slot open, and it must not start sweeping up other marked hosts. Any other is left
    // alone, and one holding a name this spec wants then clashes as any other host would.
    const leftover = unplaced[0]
    if (leftover && open.includes('covered') && claims.covered.length === 0) claims.covered.push(leftover)
    const found: Partial<Record<Slot, NpmRecord>> = {}
    for (const slot of open) if (claims[slot][0]) found[slot] = claims[slot][0]
    return { ok: true, found }
}

// This owner's proxy host when the registry's id names none: a migration (NPM to NPMplus) or a restore
// that gave the hosts new ids. Only one carrying this owner's exact marker on its first line is taken;
// several prefer the one serving the primary, the rest then clash as any other host would.
async function orphanedProxy(deps: HostsDeps, owner: Owner, spec: HostsSpec): Promise<NpmRecord | null> {
    const ours = (await deps.npm.list('proxy-hosts')).filter(record => sameOwner(ownerOf(text(record.advanced_config)), owner))
    const primary = hostname(spec.proxy.domain_names[0]!)
    return ours.find(record => record.domain_names.some(name => hostname(name) === primary)) ?? ours[0] ?? null
}

// An undo step answers a note when it changed something the caller must hear about (a host recreated
// under a new id), otherwise null.
type Undo = () => Promise<string | null>

export async function applyHosts(
    deps: HostsDeps, owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean, restoreFixed?: ProxyFixed,
): Promise<EdgeReply> {
    const primary = spec.proxy.domain_names[0]
    if (primary === undefined) return refuse('The proxy host has no domain names')
    // hostd must never point an NPM host at another machine on the LAN, so every apply forwards to the upstream only.
    if (spec.proxy.forward_host !== deps.upstreamHost) return refuse(`hostd only forwards to ${deps.upstreamHost}; refusing a proxy host that forwards to ${spec.proxy.forward_host}`)
    // Adopt takes over a host that exists; with nothing to take over it must not quietly create one.
    if (adopt && ids === null) return refuse(`Adopt needs the NPM proxy host to take over for ${ownerName(owner)}`)
    const recorded: Record<Slot, number | null> = { covered: ids?.redirectionHost ?? null, flexible: ids?.flexibleRedirectionHost ?? null }
    if (recorded.covered !== null && recorded.covered === recorded.flexible) {
        return refuse(`The ids for ${ownerName(owner)} name the same NPM redirection host ${recorded.covered} as both of its redirection hosts`)
    }
    const proxyDomains = spec.proxy.domain_names.map(hostname)
    // NPM refuses one name on two hosts, and so does the spec, between any two of the three
    const named: [string, string[]][] = [
        ['proxy host', spec.proxy.domain_names],
        ...SLOTS.map(slot => [SLOT_NAMES[slot], slotSpec(spec, slot)?.domain_names ?? []] as [string, string[]]),
    ]
    for (const [at, [first, firstNames]] of named.entries()) {
        for (const [second, secondNames] of named.slice(at + 1)) {
            const taken = firstNames.map(hostname)
            const doubled = secondNames.find(name => taken.includes(hostname(name)))
            if (doubled !== undefined) return refuse(`${doubled} is on both the ${first} and the ${second}`)
        }
    }
    // A host created or adopted without its marker could never be touched again. An update of a host
    // that already carries the marker may drop it: that is how the adoption undo hands a host back, and
    // the guard that matters, the current host's marker, is checked below before anything is written.
    if ((ids === null || adopt) && !carriesMarker(spec, owner)) return refuse(`The hosts for ${ownerName(owner)} must start with its marker`)
    // Another host's own fixed fields are only ever written back by the adoption undo: an update of an
    // owned host that hands it back without the marker. Every render hostd keeps gets hostd's own values.
    if (restoreFixed && (ids === null || adopt || sameOwner(ownerOf(spec.proxy.advanced_config), owner))) {
        return refuse(`Only putting a hand-made host back may restore its own settings, not a write for ${ownerName(owner)}`)
    }

    const flavour = flavourOf(deps)
    const undo: Undo[] = []
    try {
        const certificates = [spec.proxy.certificate_id, ...SLOTS.map(slot => slotSpec(spec, slot)?.certificate_id ?? 0)].filter(id => id !== 0)
        if (certificates.length > 0) {
            const known = await deps.npm.certificateIds()
            const missing = certificates.find(id => !known.includes(id))
            if (missing !== undefined) return refuse(`NPM has no certificate ${missing}`)
        }

        let proxyRecord: NpmRecord | null = null
        const records: Record<Slot, NpmRecord | null> = { covered: null, flexible: null }
        if (ids) {
            proxyRecord = await deps.npm.get('proxy-hosts', ids.proxyHost)
            // A recorded id that is gone, while this environment's host lives on under another id, is taken
            // the same way as an orphaned redirection host below, and its id answered for the agent to
            // record. Never under adopt: adopt takes over the host it was pointed at and nothing else.
            if (!proxyRecord && !adopt) proxyRecord = await orphanedProxy(deps, owner, spec)
            if (!proxyRecord) return refuse(`NPM proxy host ${ids.proxyHost} does not exist`)
            const proxyProblem = proxyClaimProblem(deps, proxyRecord, owner, spec, adopt)
            if (proxyProblem) return refuse(proxyProblem)
            // A redirection host deleted by hand leaves nothing to protect: a new one is created below.
            for (const slot of SLOTS) {
                const id = recorded[slot]
                if (id !== null) records[slot] = await deps.npm.get('redirection-hosts', id)
            }
            // An id may be stale while this environment's redirection host lives on under another: edge's
            // own undo recreated it, a reply on the delete-then-create path was lost, or the agent could not
            // record the new id. Left alone it would clash with every write from now on. One carrying this
            // owner's exact marker is provably this environment's, so it is taken as the record and its id
            // answered for the agent to record. Nothing without that marker is ever taken this way.
            const open = SLOTS.filter(slot => records[slot] === null)
            const known = SLOTS.flatMap(slot => records[slot] ? [records[slot]!.id] : [])
            const orphans = await orphanedRedirections(deps, owner, spec, open, known)
            if (!orphans.ok) return refuse(orphans.problem)
            for (const slot of open) records[slot] = orphans.found[slot] ?? null
            for (const slot of SLOTS) {
                const record = records[slot]
                const redirectionProblem = record && redirectionClaimProblem(record, owner, spec, adopt)
                if (redirectionProblem) return refuse(redirectionProblem)
            }
        }
        const ownIds = SLOTS.flatMap(slot => records[slot] ? [records[slot]!.id] : [])

        // NPM refuses a domain that another host has; checking first gives an error the portal can show,
        // and means no write is attempted that would have to be undone.
        const elsewhere = (await find(deps, allDomains(spec))).filter(({ kind, host }) =>
            !(kind === 'proxy-hosts' && host.id === proxyRecord?.id) && !(kind === 'redirection-hosts' && ownIds.includes(host.id)))
        const clash = elsewhere[0]
        if (clash) {
            const taken = clash.host.domain_names.map(hostname)
            const domain = allDomains(spec).find(name => taken.includes(hostname(name)))!
            return refuse(`${domain} is already on NPM ${KIND_NAMES[clash.kind]} ${clash.host.id}`)
        }

        const previous: PreviousHosts | null = proxyRecord
            // NPMplus has no fixed fields for the adoption undo to put back, so none are kept. The flexible
            // host only when there was one, as every writer emits it.
            ? {
                proxy: proxySpecOf(flavour, proxyRecord), redirection: records.covered ? redirectionSpecOf(flavour, records.covered) : null,
                ...(records.flexible ? { flexibleRedirection: redirectionSpecOf(flavour, records.flexible) } : {}),
                proxyFixed: flavour === 'npmplus' ? null : fixedOf(proxyRecord),
            }
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
            const refused = offline(flavour, record)
            if (refused) throw refused
            return record.id
        }
        // Registered before the call: NPM may store the write and still fail the reply (a timeout), and
        // writing the before-state again is harmless when it did not.
        const update = async (kind: 'proxy-hosts' | 'redirection-hosts', before: NpmRecord, body: Record<string, unknown>): Promise<void> => {
            undo.push(async () => {
                const back = await deps.npm.update(kind, before.id, revertBody(flavour, kind, before))
                if (offline(flavour, back)) throw new Error(`NPM ${KIND_NAMES[kind]} ${before.id} is still offline after putting it back`)
                return null
            })
            const refused = offline(flavour, await deps.npm.update(kind, before.id, body))
            if (refused) throw refused
        }
        // Registered before the call for the same reason. If the host is gone it is recreated, and NPM
        // gives it a new id, which the agent has to record, so the undo says which.
        const remove = async (kind: 'redirection-hosts', before: NpmRecord): Promise<void> => {
            undo.push(async () => {
                if (await deps.npm.get(kind, before.id)) {
                    const back = await deps.npm.update(kind, before.id, revertBody(flavour, kind, before))
                    if (offline(flavour, back)) throw new Error(`NPM ${KIND_NAMES[kind]} ${before.id} is still offline after putting it back`)
                    return null
                }
                const back = await deps.npm.create(kind, recreateBody(flavour, before))
                const moved = `NPM ${KIND_NAMES[kind]} ${before.id} was put back as NPM ${KIND_NAMES[kind]} ${back.id}`
                if (offline(flavour, back)) throw new Error(`${moved}, which is offline`)
                return moved
            })
            await deps.npm.remove(kind, before.id)
        }

        // NPM will not let two hosts hold one domain, so every host that gives a domain up is written
        // before any host that gains it, in three steps. First each redirection host lets go of whatever
        // another host is to hold (the adoption undo puts the aliases back on a hand-made proxy host; a
        // certificate added to or dropped from the map moves an alias between the covered and flexible
        // hosts): trimmed, or deleted if nothing it should keep is left, and gaining nothing yet. Then the
        // proxy, which gives up what the redirection hosts are to gain (aliases moving off a hand-made host
        // on adopt) and gains only what step one released. Last, each redirection host takes its full
        // spec, every name it gains now free. The undo runs in reverse, so it releases before it restores
        // in the same way.
        const current: Record<Slot, NpmRecord | null> = { ...records }
        const written: Record<Slot, boolean> = { covered: false, flexible: false }
        for (const slot of SLOTS) {
            const record = current[slot]
            if (!record) continue
            const others = [...proxyDomains, ...SLOTS.filter(other => other !== slot).flatMap(other => (slotSpec(spec, other)?.domain_names ?? []).map(hostname))]
            if (!record.domain_names.some(name => others.includes(hostname(name)))) continue
            const remaining = record.domain_names.filter(name => !others.includes(hostname(name)))
            const target = slotSpec(spec, slot)
            if (!target || remaining.length === 0) {
                await remove('redirection-hosts', record)
                current[slot] = null
            } else {
                written[slot] = sameDomains(remaining, target.domain_names)
                const interim = written[slot] ? target : { ...redirectionSpecOf(flavour, record), domain_names: remaining }
                await update('redirection-hosts', record, redirectionBody(flavour, interim))
            }
        }

        let proxyHost: number
        if (proxyRecord) {
            // restoreFixed has been checked above in both flavours; NPMplus has nothing it could restore.
            await update('proxy-hosts', proxyRecord, proxyBody(flavour, spec.proxy, restoreFixed))
            proxyHost = proxyRecord.id
        } else {
            proxyHost = await create('proxy-hosts', proxyBody(flavour, spec.proxy))
        }

        const placed: Record<Slot, number | null> = { covered: null, flexible: null }
        for (const slot of SLOTS) {
            const target = slotSpec(spec, slot)
            const record = current[slot]
            if (target) {
                if (record) {
                    if (!written[slot]) await update('redirection-hosts', record, redirectionBody(flavour, target))
                    placed[slot] = record.id
                } else {
                    placed[slot] = await create('redirection-hosts', redirectionBody(flavour, target))
                }
            } else if (record) {
                await remove('redirection-hosts', record)
            }
        }
        return { ok: true, verb: 'apply', ids: npmIds(proxyHost, placed.covered, placed.flexible), previous }
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

// The recorded redirection hosts that still exist, covered then flexible.
async function redirectionsOf(deps: HostsDeps, ids: NpmIds): Promise<Record<Slot, NpmRecord | null>> {
    const recorded: Record<Slot, number | null> = { covered: ids.redirectionHost, flexible: ids.flexibleRedirectionHost ?? null }
    const out: Record<Slot, NpmRecord | null> = { covered: null, flexible: null }
    for (const slot of SLOTS) {
        const id = recorded[slot]
        if (id !== null) out[slot] = await deps.npm.get('redirection-hosts', id)
    }
    return out
}

// Every host is checked before any is deleted, so a refusal deletes nothing. The redirection hosts go
// first, as they always have.
export async function removeHosts(deps: HostsDeps, owner: Owner, ids: NpmIds): Promise<EdgeReply> {
    try {
        const redirections = await redirectionsOf(deps, ids)
        const proxy = await deps.npm.get('proxy-hosts', ids.proxyHost)
        for (const slot of SLOTS) {
            const record = redirections[slot]
            const problem = record && notOwned('redirection-hosts', record, owner)
            if (problem) return refuse(problem)
        }
        const proxyProblem = proxy && notOwned('proxy-hosts', proxy, owner)
        if (proxyProblem) return refuse(proxyProblem)
        for (const slot of SLOTS) {
            const record = redirections[slot]
            if (record) await deps.npm.remove('redirection-hosts', record.id)
        }
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
        const redirections = await redirectionsOf(deps, ids)
        for (const slot of SLOTS) {
            const record = redirections[slot]
            const problem = record && notOwned('redirection-hosts', record, owner)
            if (problem) return refuse(problem)
        }
        const flavour = flavourOf(deps)
        const current: HostsSpec = { proxy: proxySpecOf(flavour, proxy), redirection: redirections.covered ? redirectionSpecOf(flavour, redirections.covered) : null }
        // Only when there is one, as every writer emits it
        if (redirections.flexible) current.flexibleRedirection = redirectionSpecOf(flavour, redirections.flexible)
        return { ok: true, verb: 'get', current }
    } catch (error) {
        return failure(error)
    }
}
