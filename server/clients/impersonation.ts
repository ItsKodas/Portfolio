// What "View as client" is, as arithmetic and constants: the cookie that says which client the operator is
// looking through, and how it is signed. No database and no next/* imports, so it can be tested without either.
//
// The cookie is never a session of its own. It only counts beside the operator's Auth.js session, which
// server/clients/impersonating.ts checks first, so on its own (stolen, or left behind after signing out) it
// is worth nothing. It is signed anyway, so a browser cannot edit the client id in it to look through
// somebody else.

import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

import { CLIENT_ID_PATTERN } from './ids'

// Long enough to click through a client's sites, short enough that a forgotten one does not outlive the day
export const IMPERSONATION_MS = 2 * 60 * 60 * 1000

// The __Secure- prefix requires HTTPS, so development would silently lose a cookie that carried it
export const impersonationCookieName = (secure: boolean) => (secure ? '__Secure-horizons-view-as' : 'horizons-view-as')

export const impersonationCookieOptions = (secure: boolean) => ({
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
})

// The admin's email is inside the MAC rather than inside the cookie: the cookie only holds for the admin
// it was made for, without saying who that is to anyone who reads it.
const mac = (clientId: string, expiresAt: number, admin: string, key: string) =>
    createHmac('sha256', key).update(`view-as\n${admin.trim().toLowerCase()}\n${clientId}\n${expiresAt}`).digest('base64url')

export function signImpersonation(clientId: string, admin: string, expiresAt: Date, key: string): string {
    if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('Not one of our client ids')
    if (!key) throw new Error('No key to sign with')
    const at = expiresAt.getTime()
    return `${clientId}.${at}.${mac(clientId, at, admin, key)}`
}

// The client id the cookie names, or null for anything that is not a cookie this admin was given and that
// is still in date. Never throws: a bad cookie is simply not impersonating anyone.
export function readImpersonation(value: string | undefined, admin: string, key: string, now: Date): string | null {
    if (!value || !key) return null
    const parts = value.split('.')
    if (parts.length !== 3) return null
    const [clientId, at, given] = parts
    if (!CLIENT_ID_PATTERN.test(clientId) || !/^[0-9]{1,15}$/.test(at)) return null
    const expected = Buffer.from(mac(clientId, Number(at), admin, key))
    const actual = Buffer.from(given)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    if (Number(at) <= now.getTime()) return null
    return clientId
}

export type ImpersonationEvent = { kind: 'start' | 'stop', admin: string, clientId: string, at: Date }

// The hook for the admin activity log. Nothing records admin actions in the database yet, so this writes one
// structured line to the server log, which is where `docker compose logs` finds it. When the activity log
// exists, this is the one place to send these events to it.
export function recordImpersonation(event: ImpersonationEvent, write: (line: string) => void = console.info): void {
    write(`[admin] ${event.admin} ${event.kind === 'start' ? 'started' : 'stopped'} viewing as client ${event.clientId} at ${event.at.toISOString()}`)
}
