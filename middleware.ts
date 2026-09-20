// Two matchers, two jobs. /admin is Auth.js's, exactly as before. /portal only checks that a session cookie is
// present, because Prisma doesn't run in the edge runtime, so requireClient() is the layer that decides.

import NextAuth from 'next-auth'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'

import { authConfig } from './server/auth/config'

const { auth: adminMiddleware } = NextAuth(authConfig)

const PORTAL_SIGN_IN = '/portal/sign-in'
// Reachable without a session: the two email links, the sign-in pages and the forgot form
const OPEN_PORTAL_PATHS = [PORTAL_SIGN_IN, '/portal/forgot', '/portal/invite', '/portal/reset']

// Matches server/clients/session.ts's cookieName(), duplicated rather than imported: that module is
// server-only and reaches for node:crypto, neither of which the edge runtime middleware runs in.
const cookieName = process.env.NODE_ENV === 'production' ? '__Secure-horizons-client' : 'horizons-client'

export default function middleware(request: NextRequest, event: NextFetchEvent) {
    const { pathname } = request.nextUrl
    // Branch before delegating, so a /portal request never reaches the Auth.js handler and server/auth/config.ts
    // stays untouched. Both arguments are forwarded, because Next calls middleware with (request, event) and
    // that is the shape Auth.js's handler expects when it is invoked rather than wrapped.
    if (!pathname.startsWith('/portal')) {
        return (adminMiddleware as unknown as (request: NextRequest, event: NextFetchEvent) => Response)(request, event)
    }
    if (OPEN_PORTAL_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))) return NextResponse.next()
    if (request.cookies.get(cookieName)) return NextResponse.next()
    return NextResponse.redirect(new URL(PORTAL_SIGN_IN, request.url))
}

export const config = { matcher: ['/admin/:path*', '/portal/:path*'] }
