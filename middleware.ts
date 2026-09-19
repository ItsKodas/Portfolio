// Sends anyone without a session from /admin to the sign-in page (see server/auth/config.ts)

import NextAuth from 'next-auth'

import { authConfig } from './server/auth/config'

export const { auth: middleware } = NextAuth(authConfig)

export const config = { matcher: ['/admin/:path*'] }
