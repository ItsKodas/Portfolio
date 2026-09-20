// The guard every portal page and action calls first. Middleware only checks that a cookie exists, because
// Prisma doesn't run in the edge runtime, so this is the layer that actually decides. Same two-layer design
// the admin area uses, and for the same reason: middleware has been bypassed before (CVE-2025-29927).

import 'server-only'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { getDb } from '../db'
import { clientRepo, type ClientRecord, type SessionWithClient } from './repo'
import { activeExpiry, cookieName, cookieOptions, hashSessionToken, isPending, isUsable, shouldTouch } from './session'

export const SIGN_IN_PATH = '/portal/sign-in'
export const CODE_PATH = '/portal/sign-in/code'
export const SETUP_PATH = '/portal/setup'
export const PORTAL_HOME = '/portal'

const secure = process.env.NODE_ENV === 'production'

export async function readSession(): Promise<SessionWithClient | null> {
    const token = (await cookies()).get(cookieName(secure))?.value
    if (!token) return null
    return clientRepo(getDb()).sessionByHash(hashSessionToken(token))
}

export async function currentClient(): Promise<{ client: ClientRecord, sessionId: string } | null> {
    const session = await readSession()
    const now = new Date()
    if (!session || !isUsable(session, now)) return null
    // Suspending deletes sessions, but a request already in flight can still be carrying one
    if (session.client.suspendedAt) return null
    if (shouldTouch(session.lastUsedAt, now)) {
        await clientRepo(getDb()).touchSession(session.id, now, activeExpiry(session.createdAt, now))
    }
    return { client: session.client, sessionId: session.id }
}

export async function requireClient(): Promise<{ client: ClientRecord, sessionId: string }> {
    const current = await currentClient()
    if (current) return current
    // A half-finished sign-in goes back to the step it stopped at rather than to the beginning
    const session = await readSession()
    if (session && isPending(session, new Date()) && !session.client.suspendedAt) {
        redirect(session.client.totpConfirmedAt ? CODE_PATH : SETUP_PATH)
    }
    redirect(SIGN_IN_PATH)
}

// For the second-factor and enrolment pages, which need the half-session and must refuse a finished one
export async function requirePendingSession(): Promise<SessionWithClient> {
    const session = await readSession()
    if (!session || !isPending(session, new Date()) || session.client.suspendedAt) redirect(SIGN_IN_PATH)
    return session
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
    const jar = await cookies()
    jar.set(cookieName(secure), token, { ...cookieOptions(secure), expires: expiresAt })
}

export async function clearSessionCookie(): Promise<void> {
    const jar = await cookies()
    jar.delete(cookieName(secure))
}
