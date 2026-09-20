// Two matchers, two jobs. /admin is Auth.js's, exactly as before. /portal only checks that some session cookie
// is present, client's or operator's, because Prisma doesn't run in the edge runtime, so the page is the layer
// that decides. The operator carries an Auth.js session and no client cookie: accepting only the latter locked
// them out of their own portal.

import NextAuth from 'next-auth'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'

import { authConfig } from './server/auth/config'

const { auth: adminMiddleware } = NextAuth(authConfig)

const PORTAL_SIGN_IN = '/portal/sign-in'
// Reachable without a session: the two email links, the sign-in pages and the forgot form
const OPEN_PORTAL_PATHS = [PORTAL_SIGN_IN, '/portal/forgot', '/portal/invite', '/portal/reset']

// Matches server/clients/session.ts's cookieName(), duplicated rather than imported: that module is
// server-only and reaches for node:crypto, neither of which the edge runtime middleware runs in. Both
// names are listed rather than picked by NODE_ENV, because presence is all that is being asked.
const CLIENT_COOKIES = ['horizons-client', '__Secure-horizons-client']

// Auth.js's own cookie, under both names it uses. Matched by presence only: the edge runtime cannot verify
// it, and it does not need to. This gate decides who may reach a page, and every page decides for itself
// who is actually signed in.
const ADMIN_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token']

export function hasPortalSession(names: string[]): boolean {
    return names.some(name => CLIENT_COOKIES.includes(name) || ADMIN_COOKIES.includes(name))
}

export default function middleware(request: NextRequest, event: NextFetchEvent) {
    const { pathname } = request.nextUrl
    // Branch before delegating, so a /portal request never reaches the Auth.js handler and server/auth/config.ts
    // stays untouched. Both arguments are forwarded, because Next calls middleware with (request, event) and
    // that is the shape Auth.js's handler expects when it is invoked rather than wrapped.
    if (!pathname.startsWith('/portal')) {
        return (adminMiddleware as unknown as (request: NextRequest, event: NextFetchEvent) => Response)(request, event)
    }
    if (OPEN_PORTAL_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))) return NextResponse.next()
    if (hasPortalSession(request.cookies.getAll().map(cookie => cookie.name))) return NextResponse.next()
    return NextResponse.redirect(new URL(PORTAL_SIGN_IN, request.url))
}

export const config = { matcher: ['/admin/:path*', '/portal/:path*'] }
