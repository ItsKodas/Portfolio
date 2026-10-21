import { describe, expect, it, vi } from 'vitest'

import { CONTACT_EMAIL, revealEmail } from './reveal'

describe('revealEmail', () => {
    it('hands out the address for a token Cloudflare accepts', async () => {
        const verify = vi.fn(async () => true)
        expect(await revealEmail('tok', '203.0.113.9', verify)).toEqual({ ok: true, email: CONTACT_EMAIL })
        expect(verify).toHaveBeenCalledWith('tok', '203.0.113.9')
    })

    it('keeps it back when the check fails', async () => {
        expect(await revealEmail('tok', '203.0.113.9', async () => false)).toEqual({ ok: false })
    })

    it('keeps it back without asking Cloudflare when there is no token', async () => {
        const verify = vi.fn(async () => true)
        expect(await revealEmail('', 'unknown', verify)).toEqual({ ok: false })
        expect(await revealEmail(42, 'unknown', verify)).toEqual({ ok: false })
        expect(verify).not.toHaveBeenCalled()
    })

    it('keeps it back when Cloudflare cannot be reached', async () => {
        expect(await revealEmail('tok', 'unknown', async () => { throw new Error('timeout') })).toEqual({ ok: false })
    })

    it('is my address', () => {
        expect(CONTACT_EMAIL).toBe('koda@horizons.gg')
    })
})
