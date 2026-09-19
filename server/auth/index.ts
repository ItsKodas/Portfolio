import 'server-only'

import NextAuth, { type Session } from 'next-auth'
import { redirect } from 'next/navigation'

import { isAdminSession } from './allow'
import { SIGN_IN_PATH, authConfig } from './config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

// Every admin page and server action calls this first. The middleware already turns away requests without a session,
// but this doesn't rely on it: middleware has been bypassed before (CVE-2025-29927), so one bug mustn't expose the
// inbox.
export async function requireAdmin(): Promise<Session> {
    const session = await auth()
    if (!session || !isAdminSession(session, process.env.ADMIN_EMAIL)) redirect(SIGN_IN_PATH)
    return session
}
