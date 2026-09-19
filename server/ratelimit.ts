// Who is submitting, as far as the rate limit is concerned: a keyed hash of their IP, so the IP itself is never stored

import 'server-only'

import { createHmac } from 'node:crypto'

// At most 5 saved quotes from one IP in an hour
export const RATE_LIMIT = 5
export const RATE_WINDOW_MS = 60 * 60 * 1000

// The site sits behind Cloudflare, which sets CF-Connecting-IP. Anyone reaching the origin port directly could forge
// it, which only lets them dodge the rate limit: Turnstile still has to pass (see the spec's accepted weaknesses).
export function clientIp(headers: { get(name: string): string | null }): string {
    const cloudflare = headers.get('cf-connecting-ip')?.trim()
    if (cloudflare) return cloudflare
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return forwarded || 'unknown'
}

export const hashIp = (ip: string, key: string) => createHmac('sha256', key).update(ip).digest('hex')
