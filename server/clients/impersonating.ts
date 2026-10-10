// Reading and writing the "View as client" cookie for the request in hand. Whether the operator is looking
// through a client is only ever answered here, and always from the operator's own Auth.js session first: the
// cookie is a choice the operator made, never a session in its own right.

import 'server-only'

import { cookies } from 'next/headers'

import { isAdminSession } from '../auth/allow'
import { getDb } from '../db'
import {
    IMPERSONATION_MS, impersonationCookieName, impersonationCookieOptions, readImpersonation, signImpersonation,
} from './impersonation'

const secure = process.env.NODE_ENV === 'production'

// AUTH_SECRET is what signs the operator's own session, so a cookie made with it is no easier to forge
// than the session it rides beside. Read at the point of use, as server/env.ts's keys are.
const key = () => process.env.AUTH_SECRET?.trim() ?? ''

export type Impersonation = { admin: string, client: { id: string, name: string } }

// The client this admin is looking through, or null. A client that has since been deleted or suspended is
// nobody to look through: a suspended client cannot sign in, so there is nothing of theirs to see.
export async function impersonatedClient(admin: string): Promise<{ id: string, name: string } | null> {
    const value = (await cookies()).get(impersonationCookieName(secure))?.value
    const clientId = readImpersonation(value, admin, key(), new Date())
    if (!clientId) return null
    const client = await getDb().client.findUnique({ where: { id: clientId }, select: { id: true, name: true, suspendedAt: true } })
    if (!client || client.suspendedAt) return null
    return { id: client.id, name: client.name }
}

// For the banner and the account page, which need to know without having been handed a caller
export async function currentImpersonation(): Promise<Impersonation | null> {
    const { auth } = await import('../auth')
    const session = await auth()
    const admin = session?.user?.email
    if (!admin || !isAdminSession(session, process.env.ADMIN_EMAIL)) return null
    const client = await impersonatedClient(admin)
    return client ? { admin, client } : null
}

// Only ever called by an action that has already run requireAdmin()
export async function setImpersonationCookie(clientId: string, admin: string, now: Date = new Date()): Promise<void> {
    const expiresAt = new Date(now.getTime() + IMPERSONATION_MS)
    const jar = await cookies()
    jar.set(impersonationCookieName(secure), signImpersonation(clientId, admin, expiresAt, key()), {
        ...impersonationCookieOptions(secure),
        expires: expiresAt,
    })
}

// The client id the cookie named, read before it goes so the stop can be recorded against them. Whatever
// was in it, the cookie is gone afterwards.
export async function clearImpersonationCookie(admin: string | null): Promise<string | null> {
    const jar = await cookies()
    const name = impersonationCookieName(secure)
    const clientId = admin ? readImpersonation(jar.get(name)?.value, admin, key(), new Date(0)) : null
    jar.delete(name)
    return clientId
}
