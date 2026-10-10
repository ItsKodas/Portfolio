// Who is calling. The token proves the caller is the portal; the actor header says which client the
// portal is acting for. hostd cannot verify that claim (the portal is what signs users in), which is why
// the agent re-checks everything that does not depend on it.
//
// For a client, X-Hostd-Sites says which projects the portal has given them access to, read from its own
// database for this one request. It is trusted exactly as far as the actor header is, and for the same reason.
// Absent means a portal from before site access existed, and the registry's own client field decides instead.
//
// X-Hostd-Env-Sites is the part of that list where the portal has also given the client their env files to
// read and edit. It is read, and trusted, the same way, and policy.ts still asks for ownership on top of it.
// X-Hostd-Restore-Sites is the same again for putting a backup back over live.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { CLIENT_ID, PROJECT_ID, USER_ID } from '../shared/formats.ts'

// sites is the projects the portal says this client may reach. Optional rather than nullable so an actor
// built without it reads as the older portal it stands for (see policy.ts, ownsProject). envSites is the
// projects whose env files they may read and edit, and restoreSites those whose backups they may restore over
// live; absent is none, which is what every client had before each existed.
export type Actor =
    | { kind: 'admin' }
    | { kind: 'client', client: string, sites?: ReadonlySet<string>, envSites?: ReadonlySet<string>, restoreSites?: ReadonlySet<string> }
export type Caller = { actor: Actor, user: string }
export type AuthFailure = {
    ok: false
    status: 400 | 401
    code: 'unauthorized' | 'bad-request'
    message: string
    label: string
    user: string
}

// Hashing both sides first gives equal-length inputs, so the comparison is constant-time whatever the
// length of the guess.
export function tokensMatch(given: string, expected: string): boolean {
    const a = createHash('sha256').update(given).digest()
    const b = createHash('sha256').update(expected).digest()
    return timingSafeEqual(a, b)
}

export function parseActor(raw: string | undefined): Actor | null {
    if (raw === 'admin') return { kind: 'admin' }
    const client = raw?.startsWith('client:') ? raw.slice('client:'.length) : null
    return client && CLIENT_ID.test(client) ? { kind: 'client', client } : null
}

// Far more than any one client will ever be given, and small enough that a header cannot be used to make
// hostd build a large set.
const MAX_SITES = 500

// A comma separated list of project ids, possibly empty: a client with access to nothing is still a client.
// Anything else is refused rather than half read, because a list that is quietly shorter than the portal
// meant is a client locked out for no stated reason, and one that is longer is worse.
export function parseSites(raw: string): ReadonlySet<string> | null {
    if (raw === '') return new Set()
    const ids = raw.split(',')
    if (ids.length > MAX_SITES || !ids.every(id => PROJECT_ID.test(id))) return null
    return new Set(ids)
}

export function actorLabel(actor: Actor): string {
    return actor.kind === 'admin' ? 'admin' : `client:${actor.client}`
}

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined)

export function authenticate(headers: IncomingHttpHeaders, token: string): { ok: true, caller: Caller } | AuthFailure {
    const authorization = single(headers.authorization)
    const given = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    const actorHeader = single(headers['x-hostd-actor'])
    const userHeader = single(headers['x-hostd-user'])
    // For the audit line only: what the request claimed to be, whatever it turns out to be.
    const claimed = (actorHeader ?? 'none').slice(0, 80)
    const userLabel = userHeader && USER_ID.test(userHeader) ? userHeader : 'unknown'

    if (!tokensMatch(given, token)) {
        return { ok: false, status: 401, code: 'unauthorized', message: 'missing or wrong bearer token', label: `unauthenticated (claimed ${claimed})`, user: userLabel }
    }
    const actor = parseActor(actorHeader)
    if (!actor) {
        return { ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-Actor must be admin or client:<id>', label: `invalid (${claimed})`, user: userLabel }
    }
    if (!userHeader || !USER_ID.test(userHeader)) {
        return { ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-User is missing or malformed', label: actorLabel(actor), user: 'unknown' }
    }
    // Only a client's is read: the operator reaches every project whatever a header says.
    const sitesHeader = headers['x-hostd-sites']
    if (actor.kind === 'client' && sitesHeader !== undefined) {
        const sites = typeof sitesHeader === 'string' ? parseSites(sitesHeader) : null
        if (!sites) {
            return { ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-Sites must be a comma separated list of project ids', label: actorLabel(actor), user: userLabel }
        }
        // The narrower grants, each optional and each refused whole when malformed, like the list itself
        const grants: { envSites?: ReadonlySet<string>, restoreSites?: ReadonlySet<string> } = {}
        for (const [key, name] of [['envSites', 'X-Hostd-Env-Sites'], ['restoreSites', 'X-Hostd-Restore-Sites']] as const) {
            const header = headers[name.toLowerCase()]
            if (header === undefined) continue
            const parsed = typeof header === 'string' ? parseSites(header) : null
            if (!parsed) {
                return { ok: false, status: 400, code: 'bad-request', message: `${name} must be a comma separated list of project ids`, label: actorLabel(actor), user: userLabel }
            }
            grants[key] = parsed
        }
        return { ok: true, caller: { actor: { ...actor, sites, ...grants }, user: userHeader } }
    }
    return { ok: true, caller: { actor, user: userHeader } }
}
