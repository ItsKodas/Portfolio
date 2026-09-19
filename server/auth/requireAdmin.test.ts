import { redirect } from 'next/navigation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SIGN_IN_PATH } from './config'

// The real auth() reads cookies and a database adapter, none of which exist under Vitest, so the whole next-auth
// instance is replaced with one whose auth() a test controls directly.
const authMock = vi.fn()

vi.mock('next-auth', () => ({
    default: () => ({ handlers: {}, auth: authMock, signIn: vi.fn(), signOut: vi.fn() }),
}))

// The real redirect() throws to stop the render, so the mock does the same, and a test can tell it happened either
// by the throw or by checking the mock's calls
vi.mock('next/navigation', () => ({
    redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`) }),
}))

const ADMIN_EMAIL = 'koda@horizons.gg'

describe('requireAdmin', () => {
    beforeEach(() => {
        vi.stubEnv('ADMIN_EMAIL', ADMIN_EMAIL)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        authMock.mockReset()
        vi.mocked(redirect).mockClear()
    })

    it('redirects to sign-in when there is no session', async () => {
        authMock.mockResolvedValue(null)
        const { requireAdmin } = await import('./index')

        await expect(requireAdmin()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`)
        expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH)
    })

    it('redirects to sign-in when the session is not the admin', async () => {
        authMock.mockResolvedValue({ user: { email: 'someone@gmail.com' } })
        const { requireAdmin } = await import('./index')

        await expect(requireAdmin()).rejects.toThrow(`REDIRECT:${SIGN_IN_PATH}`)
        expect(redirect).toHaveBeenCalledWith(SIGN_IN_PATH)
    })

    it('returns the session for the admin, without redirecting', async () => {
        const session = { user: { email: ADMIN_EMAIL } }
        authMock.mockResolvedValue(session)
        const { requireAdmin } = await import('./index')

        await expect(requireAdmin()).resolves.toBe(session)
        expect(redirect).not.toHaveBeenCalled()
    })
})
