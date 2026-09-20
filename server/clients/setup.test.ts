import { describe, expect, it, vi } from 'vitest'

import { LINK_ERROR, acknowledgeRecoveryCodes, beginEnrolment, completeInvite, confirmEnrolment, tokenProblem } from './setup'

const now = new Date('2026-09-20T10:00:00Z')
const later = (ms: number) => new Date(now.getTime() + ms)

// Full ClientRecord shape, since Prisma makes nullable columns required-but-null rather than optional keys
const client = (overrides: Record<string, unknown> = {}) => ({
    id: 'cl_ABCDEFGH',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    name: 'Ann',
    company: null,
    email: 'ann@example.com',
    passwordHash: null,
    passwordUpdatedAt: null,
    totpSecret: null,
    totpConfirmedAt: null,
    suspendedAt: null,
    lastSignInAt: null,
    failedSignIns: 0,
    lockedUntil: null,
    ...overrides,
})

describe('tokenProblem', () => {
    const good = { purpose: 'INVITE' as const, usedAt: null, expiresAt: later(1000), client: { suspendedAt: null } }

    it('accepts a live, unused token for an active client', () => {
        expect(tokenProblem(good, 'INVITE', now)).toBeNull()
    })

    // Without this, a reset link (which arrives by email and needs no second factor at the invite endpoint)
    // could be spent to change a password, which is what the spec forbids
    it('refuses a reset token offered to the invite flow', () => {
        expect(tokenProblem({ ...good, purpose: 'PASSWORD_RESET' as const }, 'INVITE', now)).toBe(LINK_ERROR)
        expect(tokenProblem(good, 'PASSWORD_RESET', now)).toBe(LINK_ERROR)
    })

    // One message for every case, so the page can't be used to probe which tokens exist
    it.each([
        ['missing', null],
        ['used', { ...good, usedAt: now }],
        ['expired', { ...good, expiresAt: later(-1000) }],
        ['for a suspended client', { ...good, client: { suspendedAt: now } }],
    ])('refuses a %s token with the same message', (unused, token) => {
        expect(tokenProblem(token as never, 'INVITE', now)).toBe(LINK_ERROR)
    })
})

const inviteDeps = (overrides: Record<string, unknown> = {}) => ({
    tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'INVITE' as const, usedAt: null, expiresAt: later(1000), client: client() })),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    useToken: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 'session1' })),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('completeInvite', () => {
    it('sets the password, spends the token and opens a session that still needs the second factor', async () => {
        const deps = inviteDeps()
        const result = await completeInvite({ tokenHash: 'h', password: 'correct horse battery', userAgent: null }, deps)

        expect(result).toMatchObject({ ok: true, token: 'raw-token' })
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
        expect(deps.useToken).toHaveBeenCalledWith('token1', now)
        // mfaAt is not set anywhere in this flow: enrolment is still ahead
        expect(deps.createSession).toHaveBeenCalledWith('cl_ABCDEFGH', 'hashed:raw-token', expect.any(Date), null)
    })

    it('refuses a spent token and changes nothing', async () => {
        const deps = inviteDeps({
            tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'INVITE' as const, usedAt: now, expiresAt: later(1000), client: client() })),
        })
        expect(await completeInvite({ tokenHash: 'h', password: 'correct horse battery', userAgent: null }, deps))
            .toEqual({ ok: false, error: LINK_ERROR })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })
})

describe('beginEnrolment', () => {
    it('stores the new secret encrypted but unconfirmed, and hands back the URI and the typed form', async () => {
        const storeSecret = vi.fn(async () => {})
        const result = await beginEnrolment(client() as never, {
            newSecret: () => Buffer.from('12345678901234567890'),
            encryptSecret: (plain: string) => `encrypted:${plain}`,
            storeSecret,
            now: () => now,
        })

        expect(result.uri).toContain('otpauth://totp/Horizons%3Aann%40example.com')
        expect(result.typed).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
        // Stored straight away so a page reload doesn't strand a half-scanned QR code. Harmless: sign-in needs
        // totpConfirmedAt, and a session needs mfaAt, neither of which this sets.
        expect(storeSecret).toHaveBeenCalled()
    })
})

// Kept as a plain object (rather than casting straight to `never`) so it can still be spread below;
// spreading a variable already typed `never` is a distinct compile error, not the ClientRecord fixture gap.
const sessionBase = { id: 'session1', createdAt: now, client: client({ totpSecret: 'encrypted' }) }
const session = sessionBase as never

const confirmDeps = (overrides: Record<string, unknown> = {}) => ({
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    confirmTotp: vi.fn(async () => {}),
    newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
    hashRecoveryCode: vi.fn((code: string) => `hashed:${code}`),
    replaceRecoveryCodes: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('confirmEnrolment', () => {
    it('confirms the authenticator and returns ten codes, once', async () => {
        const deps = confirmDeps()
        const result = await confirmEnrolment({ session, code: '123456' }, deps)

        expect(result).toMatchObject({ ok: true })
        expect((result as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10)
        expect(deps.confirmTotp).toHaveBeenCalledWith('cl_ABCDEFGH', now)
        expect(deps.replaceRecoveryCodes).toHaveBeenCalledWith('cl_ABCDEFGH', expect.arrayContaining(['hashed:ABCDE-FGHJK']))
    })

    it('refuses a wrong code and confirms nothing', async () => {
        const deps = confirmDeps({ verifyTotp: vi.fn(() => null) })
        expect(await confirmEnrolment({ session, code: '000000' }, deps)).toMatchObject({ ok: false })
        expect(deps.confirmTotp).not.toHaveBeenCalled()
        expect(deps.replaceRecoveryCodes).not.toHaveBeenCalled()
    })

    it('refuses when there is no secret to confirm against', async () => {
        const noSecret = { ...sessionBase, client: client() } as never
        const deps = confirmDeps()
        expect(await confirmEnrolment({ session: noSecret, code: '123456' }, deps)).toMatchObject({ ok: false })
    })

    // The enrolling code is spent like any other, so it cannot be replayed at the sign-in page moments
    // later. signIn.test.ts covers the same property for codeStep; without this, confirmEnrolment's half
    // of it has no regression protection.
    it('refuses a code whose step was already recorded, and confirms nothing', async () => {
        const deps = confirmDeps({ recordTotpUse: vi.fn(async () => false) })
        expect(await confirmEnrolment({ session, code: '123456' }, deps)).toMatchObject({ ok: false })
        expect(deps.confirmTotp).not.toHaveBeenCalled()
        expect(deps.replaceRecoveryCodes).not.toHaveBeenCalled()
    })
})

describe('acknowledgeRecoveryCodes', () => {
    // This is the third and last place mfaAt is written, and it is reachable only after confirmEnrolment
    it('is what finally makes the session usable', async () => {
        const completeMfa = vi.fn(async () => {})
        await acknowledgeRecoveryCodes(session, { completeMfa, recordSuccess: vi.fn(async () => {}), now: () => now })
        expect(completeMfa).toHaveBeenCalledWith('session1', now, expect.any(Date))
    })
})
