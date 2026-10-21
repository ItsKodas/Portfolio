// Hands out Koda's email address to a visitor who has passed Cloudflare's Turnstile check, so the address is never in
// the page for a scraper to find: the "Email me" button asks for it only after the check (see app/(landing)/EmailLink.tsx).
// server-only keeps this module, and the address in it, out of every browser bundle.

import 'server-only'

export const CONTACT_EMAIL = 'koda@horizons.gg'

export type RevealResult = { ok: true, email: string } | { ok: false }

export async function revealEmail(token: unknown, ip: string, verify: (token: string, ip: string) => Promise<boolean>): Promise<RevealResult> {
    if (typeof token !== 'string' || !token) return { ok: false }
    try {
        return await verify(token, ip) ? { ok: true, email: CONTACT_EMAIL } : { ok: false }
    } catch {
        return { ok: false }
    }
}
