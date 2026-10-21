'use server'

// The "Email me" button's two calls. The Turnstile site key is fetched when someone clicks, because the home page is
// built ahead of time and so can't read it from the environment the way the quote page does.

import { headers } from 'next/headers'

import { revealEmail, type RevealResult } from '@/server/contact/reveal'
import { turnstileSecret } from '@/server/env'
import { clientIp } from '@/server/ratelimit'
import { verifyTurnstile } from '@/server/turnstile'

export async function emailCheckAction(): Promise<{ siteKey: string | null }> {
    return { siteKey: process.env.TURNSTILE_SITE_KEY || null }
}

export async function revealEmailAction(token: unknown): Promise<RevealResult> {
    return revealEmail(token, clientIp(await headers()), (t, ip) => verifyTurnstile(t, ip, turnstileSecret()))
}
