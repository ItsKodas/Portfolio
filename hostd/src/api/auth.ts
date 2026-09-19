// Who is calling. The token proves the caller is the portal; the actor header says which client the
// portal is acting for. hostd cannot verify that claim (the portal is what signs users in), which is why
// the agent re-checks everything that does not depend on it.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { CLIENT_ID, USER_ID } from '../shared/formats.ts'

export type Actor = { kind: 'admin' } | { kind: 'client', client: string }
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
    return { ok: true, caller: { actor, user: userHeader } }
}
