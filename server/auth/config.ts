// Auth.js settings shared by the middleware and the server. Kept free of server-only and Node-specific imports because
// the middleware runs in Next's edge runtime.

import type { NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'

import { isAllowedAdmin } from './allow'

export const SIGN_IN_PATH = '/admin/sign-in'

export const authConfig = {
    // Reads AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET
    providers: [Google],
    // A refused sign-in comes back to the sign-in page with ?error=AccessDenied
    pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
    // Signed cookies rather than database sessions, so checking one never touches Postgres
    session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
    // The site sits behind Cloudflare, and AUTH_URL pins the public address
    trustHost: true,
    callbacks: {
        signIn: ({ account, profile }) => account?.provider === 'google' && isAllowedAdmin(profile, process.env.ADMIN_EMAIL),
        // Used by the middleware: the sign-in page is open, everything else under /admin needs a session. Pages and
        // actions check the email again themselves with requireAdmin().
        authorized: ({ auth, request }) => request.nextUrl.pathname === SIGN_IN_PATH || !!auth?.user,
    },
} satisfies NextAuthConfig
