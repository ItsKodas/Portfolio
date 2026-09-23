// Every hostname hostd accepts passes through here first. It is the only place that decides what a
// hostname is, so the vhost renderer, the registry parser and the endpoints cannot disagree about it.

import { HOSTNAME } from './formats.ts'

// Names that may never appear in the registry's `allowed` list, whatever the operator writes. The
// carve-out exists so a test hostname can be exempted from `reserved`; it must never become a door to
// the apex or to the mail stack. This is in code rather than in the runbook because a runbook does not
// refuse a typo.
export const NEVER_ALLOWED_EXACT = ['horizons.gg']
export const NEVER_ALLOWED_SUBTREE = ['dev.horizons.gg']

// URL does the IDNA conversion and the lowercasing that punycode-by-hand gets wrong. node:punycode is
// deprecated and does not implement UTS-46, so it would accept names a browser would not.
export function normaliseHostname(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw === '') return null
    // A trailing dot is a valid fully qualified name but is not what goes in a ServerName, and it would
    // make two spellings of one hostname compare unequal everywhere else.
    const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw
    let host: string
    try {
        // Use a non-standard port (9999) so URL won't normalize away default ports from the input.
        const url = new URL(`https://${trimmed}:9999`)
        // Anything beyond the host itself means the caller passed a URL, a port or a path, none of which
        // is a hostname. Comparing the whole URL back is what catches all three at once.
        if (url.href !== `https://${url.hostname}:9999/`) return null
        host = url.hostname
    } catch {
        return null
    }
    if (!HOSTNAME.test(host)) return null
    // An IP address is not a name a client can prove they control, and it must never become a
    // ServerName: a dotted-quad is exactly a hostname whose labels are all numeric, and URL canonicalises
    // other IPv4 spellings (hex, octal) to that form before we ever see them.
    if (host.split('.').every(label => /^[0-9]+$/.test(label))) return null
    return host
}

export function atOrBelow(host: string, parent: string): boolean {
    return host === parent || host.endsWith(`.${parent}`)
}

export function isReserved(host: string, reserved: string[], allowed: string[]): boolean {
    // Exact match only. A subtree exemption would mean exempting one test name also exempted every name
    // below it, which is the hole this key is shaped to avoid.
    if (allowed.includes(host)) return false
    return reserved.some(entry => atOrBelow(host, entry))
}

export function allowedEntryProblem(host: string): string | null {
    const never = NEVER_ALLOWED_EXACT.includes(host)
        || NEVER_ALLOWED_SUBTREE.some(entry => atOrBelow(host, entry))
    return never ? `${host} can never be exempted from reserved` : null
}

// The registry's `openSubdomains` list: every name strictly below an entry may be a site's main domain,
// which only the operator sets. The entry itself stays reserved (opening horizons.gg opens its
// subdomains, never the apex), and so does everything the `allowed` carve-out could never reach.
export function isOpenSubdomain(host: string, open: string[]): boolean {
    if (allowedEntryProblem(host) !== null) return false
    return open.some(entry => host !== entry && atOrBelow(host, entry))
}

export function openSubdomainEntryProblem(entry: string): string | null {
    const never = NEVER_ALLOWED_SUBTREE.some(subtree => atOrBelow(entry, subtree))
    return never ? `${entry} can never be opened to subdomains` : null
}
