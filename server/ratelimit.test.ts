import { describe, expect, it } from 'vitest'

import { clientIp, hashIp } from './ratelimit'

const headers = (values: Record<string, string>) => new Headers(values)

describe('clientIp', () => {
    it("prefers Cloudflare's header", () => {
        expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.9')
    })

    it('falls back to the first X-Forwarded-For entry', () => {
        expect(clientIp(headers({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' }))).toBe('198.51.100.1')
    })

    it('uses "unknown" when neither is there, as in local development', () => {
        expect(clientIp(headers({}))).toBe('unknown')
    })
})

describe('hashIp', () => {
    it('is stable for the same IP and key, and never the IP itself', () => {
        const hash = hashIp('203.0.113.9', 'key')
        expect(hash).toBe(hashIp('203.0.113.9', 'key'))
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hash).not.toContain('203.0.113.9')
    })

    it('changes with the key, so the hashes cannot be reversed with a lookup table', () => {
        expect(hashIp('203.0.113.9', 'one')).not.toBe(hashIp('203.0.113.9', 'two'))
    })
})
