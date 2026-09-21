// Reading just enough of a hand-written vhost to know which hostnames it serves. This is not an Apache
// configuration parser and must never grow into one: it reads ServerName and ServerAlias, and when it
// meets a directive that could define a hostname somewhere it cannot see, it says so and adoption
// refuses. Half-understanding a file that is serving a client's site is the failure this exists to stop.

import { normaliseHostname } from '../shared/hostnames.ts'

export type VhostFile = { path: string, text: string }
export type ServerNames = { names: string[], unsupported: string | null }

const NAME_LINE = /^\s*Server(?:Name|Alias)\s+(.+?)\s*$/i
// Include and IncludeOptional pull in files this never read. Use is mod_macro, where the hostname is an
// argument expanded at load time and is not in this file in any readable form.
const UNSUPPORTED = /^\s*(Include|IncludeOptional|Use)\s+/i

export function parseServerNames(text: string): ServerNames {
    const names: string[] = []
    let unsupported: string | null = null
    for (const raw of text.split('\n')) {
        // Apache treats a line whose first non-space character is # as a comment in full; there is no
        // trailing-comment syntax, so this is the whole rule.
        if (/^\s*#/.test(raw)) continue

        const blocked = raw.match(UNSUPPORTED)
        if (blocked && unsupported === null) {
            unsupported = `${blocked[1]} is used, so the hostnames this file serves cannot be read here`
            continue
        }

        const match = raw.match(NAME_LINE)
        if (!match) continue
        // ServerAlias takes several names on one line, separated by whitespace.
        for (const candidate of match[1]!.split(/\s+/)) {
            const host = normaliseHostname(candidate)
            // A name that will not normalise is a variable, a wildcard or a typo. None of those is a
            // hostname this can claim to have understood, so it is dropped rather than carried.
            if (host !== null && !names.includes(host)) names.push(host)
        }
    }
    return { names, unsupported }
}

// The file itself is carried, not only what was understood of it. Adoption switches this file off and
// puts hostd's own in its place, in one reload, on a site that is serving somebody right now, and what
// this parser reads is two directives out of however many the file has. A custom rewrite, basic auth or
// a bespoke error page is invisible to everything above except the text, so the text travels with the
// claim and the operator sees the whole of what they are replacing before they confirm it. It is their
// own server's configuration, and every route that can reach it is admin-only.
export type Claim = { path: string, text: string, names: string[], unsupported: string | null }

export function findClaims(files: VhostFile[], hostnames: string[]): Claim[] {
    const claims: Claim[] = []
    for (const file of files) {
        const parsed = parseServerNames(file.text)
        if (!parsed.names.some(name => hostnames.includes(name))) continue
        claims.push({ path: file.path, text: file.text, names: parsed.names, unsupported: parsed.unsupported })
    }
    return claims
}
