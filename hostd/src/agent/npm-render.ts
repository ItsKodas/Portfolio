// One environment's Nginx Proxy Manager hosts, rendered from a fixed template: a proxy host for the
// primary and, when there are aliases, a redirection host that sends them to it (and a second one, with
// no certificate, for aliases no certificate covers under a Full SSL primary). Like vhost.ts, the only
// values that reach the output are ones the caller has already validated (hostnames through
// normaliseHostname, the port and id from the registry, the token from api), so nothing here escapes
// anything. The output is a HostsSpec for edge to apply; this module never talks to NPM.

import { markerFor, type HostsSpec, type RedirectionHostSpec } from '../shared/edge-protocol.ts'
import type { EnvironmentName } from '../shared/registry.ts'

export type HostsInput = {
    id: string
    environment: EnvironmentName
    primary: string
    // The aliases that share the primary's certificate (all of them under Flexible SSL)
    aliases: string[]
    // The aliases no certificate covers under a Full SSL primary (aliasCertificates says which). They go
    // on a second redirection host with no certificate, since Cloudflare reaches NPM over plain HTTP for
    // them. Left out, there are none.
    flexibleAliases?: string[]
    port: number
    flexibleSsl: boolean
    token: string
    // The NPM certificate covering these names, or null under Flexible SSL where the CDN terminates TLS
    certificateId: number | null
    upstreamHost: string
    edgeHost: string
    edgeHttpPort: number
}

// Where NPM's access log datagrams go. Fixed rather than an input: it is the agent's own listener, and
// every host hostd renders must agree on it.
export const HOSTD_EDGE_SYSLOG_PORT = 5514

// NPM's nginx rejects a request body it cannot decode with a confusing upstream error; the live hosts
// answer 415 instead, so the rendered ones must too.
export const BROTLI = String.raw`if ($http_content_encoding ~* "(^|,)\s*br\s*(,|$)") {
    return 415;
}`

// The verification token, answered by nginx itself so it works while the upstream is down or deploying.
function tokenLocation(token: string): string {
    return `location = /.well-known/hostd/${token} {
    add_header X-Hostd-Token "${token}" always;
    return 204;
}`
}

// A dead upstream gets the holding page edge serves rather than NPM's bare 502. proxy_pass has no URI
// part on purpose: with a rewrite ... break the rewritten path is what is sent, and a URI part would
// make nginx discard it.
function holdingPage(input: HostsInput): string {
    return `error_page 502 504 = @hostd_holding;
location @hostd_holding {
    rewrite ^ /holding/${input.id}-${input.environment} break;
    proxy_pass http://${input.edgeHost}:${input.edgeHttpPort};
}`
}

function proxyConfig(input: HostsInput): string {
    return [
        markerFor({ project: input.id, environment: input.environment }),
        BROTLI,
        tokenLocation(input.token),
        holdingPage(input),
        `access_log syslog:server=${input.edgeHost}:${HOSTD_EDGE_SYSLOG_PORT},tag=hostd,nohostname hostd;`,
    ].join('\n') + '\n'
}

// An alias only redirects, so it is not a visit: no holding page and no access log.
function redirectionConfig(input: HostsInput): string {
    return `${markerFor({ project: input.id, environment: input.environment })}\n${tokenLocation(input.token)}\n`
}

export function renderHosts(input: HostsInput): HostsSpec {
    // Flexible SSL means no certificate and plain HTTP all the way; Full forces https and offers HTTP/2.
    const certificate_id = input.flexibleSsl ? 0 : (input.certificateId ?? 0)
    const secure = !input.flexibleSsl
    const spec: HostsSpec = {
        proxy: {
            domain_names: [input.primary], forward_host: input.upstreamHost, forward_port: input.port, certificate_id,
            ssl_forced: secure, http2_support: secure, advanced_config: proxyConfig(input),
        },
        redirection: input.aliases.length === 0 ? null : {
            domain_names: input.aliases, forward_domain_name: input.primary, certificate_id,
            ssl_forced: secure, http2_support: secure, advanced_config: redirectionConfig(input),
        },
    }
    // Still https onward: the visitor ends up on the primary, which Cloudflare serves over https whatever
    // the alias's own zone does. The key only when there is such a host, as every writer emits it.
    const flexible = input.flexibleAliases ?? []
    if (flexible.length > 0) {
        spec.flexibleRedirection = {
            domain_names: flexible, forward_domain_name: input.primary, certificate_id: 0,
            ssl_forced: false, http2_support: false, advanced_config: redirectionConfig(input),
        }
    }
    return spec
}

type Zone = { zone: string, id: number }

// The zone in the map a hostname falls in, on a label boundary (spotondrones.com never matches
// spotondrones.com.au), the longest winning so a more specific certificate beats a broader one.
function zoneOf(certificates: Map<string, number>, hostname: string): Zone | null {
    let best: Zone | null = null
    for (const [zone, id] of certificates) {
        if (hostname !== zone && !hostname.endsWith(`.${zone}`)) continue
        if (best === null || zone.length > best.zone.length) best = { zone, id }
    }
    return best
}

// A zone certificate (spotondrones.com) covers the zone itself and one label below it, the way a wildcard
// does. A name two deep is not covered, and would be rendered against a certificate the browser rejects.
function tooDeep(hostname: string, zone: Zone): string | null {
    if (hostname === zone.zone || !hostname.slice(0, hostname.length - zone.zone.length - 1).includes('.')) return null
    return `${hostname} is two labels below ${zone.zone}, which the certificate for ${zone.zone} does not cover.`
}

function different(chosen: Zone, other: Zone): string {
    return `These names need different certificates (${chosen.zone} and ${other.zone}), and one site gets only one.`
}

// The certificate that covers every name, chosen by zone.
export function certificateFor(certificates: Map<string, number>, hostnames: string[]):
    { ok: true, id: number } | { ok: false, problem: string } {
    let chosen: Zone | null = null
    for (const hostname of hostnames) {
        const best = zoneOf(certificates, hostname)
        if (best === null) return { ok: false, problem: `No certificate in Nginx Proxy Manager covers ${hostname}.` }
        const deep = tooDeep(hostname, best)
        if (deep) return { ok: false, problem: deep }
        if (chosen !== null && chosen.id !== best.id) return { ok: false, problem: different(chosen, best) }
        chosen = best
    }
    if (chosen === null) return { ok: false, problem: 'There are no hostnames to find a certificate for.' }
    return { ok: true, id: chosen.id }
}

// A Full SSL environment's certificate, and which aliases it covers. The primary must be covered. An
// alias whose zone is in the map is covered too, and must take the primary's certificate (one site, one
// certificate) and sit no deeper than one label below its zone. An alias no zone in the map reaches is
// flexible: its Cloudflare zone is taken to be on Flexible, so it is redirected over plain HTTP from a
// host with no certificate. The split comes from the map alone, with no flag: a flexible alias whose zone
// is really on Full fails verification in the portal, and the fix (its Origin certificate added to the
// map) moves it to the covered host on the next write.
export function aliasCertificates(certificates: Map<string, number>, primary: string, aliases: string[]):
    { ok: true, id: number, covered: string[], flexible: string[] } | { ok: false, problem: string } {
    const chosen = certificateFor(certificates, [primary])
    if (!chosen.ok) return chosen
    const own = zoneOf(certificates, primary)!
    const covered: string[] = []
    const flexible: string[] = []
    for (const alias of aliases) {
        const zone = zoneOf(certificates, alias)
        if (zone === null) {
            flexible.push(alias)
            continue
        }
        // A deeper name is refused rather than made flexible: its zone is in the map, so it is on Full in
        // Cloudflare, where a host with no certificate would not serve it either.
        const deep = tooDeep(alias, zone)
        if (deep) return { ok: false, problem: deep }
        if (zone.id !== chosen.id) return { ok: false, problem: different(own, zone) }
        covered.push(alias)
    }
    return { ok: true, id: chosen.id, covered, flexible }
}

// The token out of hosts this module wrote, or null when the config carries none. The same pattern as
// tokenFromVhost: DOMAIN_TOKEN's hex class, with a lookahead so a longer run of hex is not read as a
// valid prefix of itself.
export function tokenFromHosts(spec: HostsSpec): string | null {
    const found = /location = \/\.well-known\/hostd\/([0-9a-f]{6,64})(?![0-9a-f])/.exec(spec.proxy.advanced_config)
    return found?.[1] ?? null
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

function indent(text: string): string {
    return text.trimEnd().split('\n').map(line => `    ${line}`).join('\n')
}

// What will be written, for an operator to read before adopting. Plain lines, in a fixed order.
export function describeHosts(spec: HostsSpec): string {
    const { proxy, redirection } = spec
    const flexible = spec.flexibleRedirection ?? null
    const lines = [
        'Proxy host',
        `Domains: ${proxy.domain_names.join(', ')}`,
        `Upstream: ${proxy.forward_host}:${proxy.forward_port}`,
        `Certificate: ${proxy.certificate_id === 0 ? 'none' : proxy.certificate_id}`,
        `SSL forced: ${yesNo(proxy.ssl_forced)}`,
        `HTTP/2: ${yesNo(proxy.http2_support)}`,
        'Advanced config:',
        indent(proxy.advanced_config),
    ]
    if (redirection) lines.push('', ...describeRedirection('Redirection host', redirection))
    // Named apart from the other so an operator sees why these aliases carry no certificate
    if (flexible) lines.push('', ...describeRedirection('Flexible redirection host (aliases no certificate covers)', flexible))
    return lines.join('\n')
}

export function describeRedirection(title: string, redirection: RedirectionHostSpec): string[] {
    return [
        title,
        `Domains: ${redirection.domain_names.join(', ')}`,
        `Redirects to: ${redirection.forward_domain_name}`,
        `Certificate: ${redirection.certificate_id === 0 ? 'none' : redirection.certificate_id}`,
        `SSL forced: ${yesNo(redirection.ssl_forced)}`,
        `HTTP/2: ${yesNo(redirection.http2_support)}`,
        'Advanced config:',
        indent(redirection.advanced_config),
    ]
}
