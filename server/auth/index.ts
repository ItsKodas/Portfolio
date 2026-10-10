import 'server-only'

import NextAuth, { type Session } from 'next-auth'
import { redirect } from 'next/navigation'

import { isAdminSession } from './allow'
import { SIGN_IN_PATH, authConfig } from './config'

// The events are here rather than in authConfig, which the middleware also reads in the edge runtime, where
// Prisma does not run. The recorder is imported when one fires, so loading this module never loads Prisma.
export const { handlers, auth, signIn, signOut } = NextAuth({
    ...authConfig,
    events: {
        signIn: async ({ user }) => {
            const { record } = await import('../audit/record')
            await record({
                kind: 'auth.adminSignIn',
                actor: { type: 'ADMIN', id: user.email ?? 'admin', name: user.name ?? null },
                summary: `${user.email ?? 'The operator'} signed in with Google`,
            })
        },
        signOut: async message => {
            const email = 'token' in message ? message.token?.email : null
            const { record } = await import('../audit/record')
            await record({
                kind: 'auth.adminSignOut',
                actor: { type: 'ADMIN', id: email ?? 'admin' },
                summary: `${email ?? 'The operator'} signed out`,
            })
        },
    },
})

// Every admin page and server action calls this first. The middleware already turns away requests without a session,
// but this doesn't rely on it: middleware has been bypassed before (CVE-2025-29927), so one bug mustn't expose the
// inbox.
export async function requireAdmin(): Promise<Session> {
    const session = await auth()
    if (!session || !isAdminSession(session, process.env.ADMIN_EMAIL)) redirect(SIGN_IN_PATH)
    return session
}
