// Asks Cloudflare whether a Turnstile token (from the widget on the form) came from a person

import 'server-only'

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstile(token: string, ip: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (!token) return false
    const body = new URLSearchParams({ secret, response: token })
    if (ip !== 'unknown') body.set('remoteip', ip)
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return false
    const result = await response.json() as { success?: unknown }
    return result.success === true
}
