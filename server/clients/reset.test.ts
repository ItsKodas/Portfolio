import { describe, expect, it, vi } from 'vitest'

import { LINK_ERROR } from './setup'
import { LOCKED_ERROR, TOO_MANY_ERROR } from './signIn'
import { RESET_SENT_MESSAGE, completeReset, requestReset } from './reset'

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
    passwordHash: 'stored-hash',
    passwordUpdatedAt: null,
    totpSecret: 'encrypted',
    totpConfirmedAt: new Date('2026-09-01T00:00:00Z'),
    suspendedAt: null,
    lastSignInAt: null,
    failedSignIns: 0,
    lockedUntil: null,
    ...overrides,
})

const requestDeps = (overrides: Record<string, unknown> = {}) => ({
    findByEmail: vi.fn(async () => client()),
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    invalidateTokens: vi.fn(async () => {}),
    createToken: vi.fn(async () => {}),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendReset: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('requestReset', () => {
    it('sends a link and invalidates any earlier one', async () => {
        const deps = requestDeps()
        expect(await requestReset({ email: 'ann@example.com' }, deps)).toEqual({ message: RESET_SENT_MESSAGE })
        expect(deps.invalidateTokens).toHaveBeenCalledWith('cl_ABCDEFGH', 'PASSWORD_RESET', now)
        expect(deps.createToken).toHaveBeenCalledWith('cl_ABCDEFGH', 'PASSWORD_RESET', 'hashed:raw-token', later(60 * 60 * 1000))
    })

    // Identical answers, so the page cannot be used to find out who the clients are
    it.each([
        ['an unknown address', { findByEmail: vi.fn(async () => null) }],
        ['a suspended client', { findByEmail: vi.fn(async () => client({ suspendedAt: now })) }],
    ])('says the same thing for %s, and sends nothing', async (unused, overrides) => {
        const deps = requestDeps(overrides)
        expect(await requestReset({ email: 'ann@example.com' }, deps)).toEqual({ message: RESET_SENT_MESSAGE })
        expect(deps.createToken).not.toHaveBeenCalled()
        expect(deps.sendReset).not.toHaveBeenCalled()
    })

    // Sending inline would make a request for a real address measurably slower than one for an address that
    // does not exist, which would undo the point of the identical answer
    it('hands the email to after(), never awaiting the relay', async () => {
        const deps = requestDeps()
        await requestReset({ email: 'ann@example.com' }, deps)
        expect(deps.sendLater).toHaveBeenCalled()
    })

    it('counts every request against the IP limit, matched or not', async () => {
        const deps = requestDeps({ findByEmail: vi.fn(async () => null) })
        await requestReset({ email: 'nobody@example.com' }, deps)
        expect(deps.recordAttempt).toHaveBeenCalled()
    })

    it('refuses over the IP limit', async () => {
        const deps = requestDeps({ countAttempts: vi.fn(async () => 99) })
        await requestReset({ email: 'ann@example.com' }, deps)
        expect(deps.createToken).not.toHaveBeenCalled()
    })
})

const completeDeps = (overrides: Record<string, unknown> = {}) => ({
    tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000), client: client() })),
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    unusedRecoveryCodes: vi.fn(async () => []),
    recoveryCodeMatches: vi.fn(() => false),
    useRecoveryCode: vi.fn(async () => {}),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    useToken: vi.fn(async () => {}),
    deleteSessionsFor: vi.fn(async () => {}),
    clearLock: vi.fn(async () => {}),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendChanged: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

const input = { tokenHash: 'h', password: 'a brand new passphrase', code: '123456' }

describe('completeReset', () => {
    it('sets the password, spends the token and signs every session out', async () => {
        const deps = completeDeps()
        expect(await completeReset(input, deps)).toEqual({ ok: true })
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
        expect(deps.useToken).toHaveBeenCalledWith('token1', now)
        // A reset is exactly the moment to end anything already signed in
        expect(deps.deleteSessionsFor).toHaveBeenCalledWith('cl_ABCDEFGH')
        expect(deps.sendChanged).toHaveBeenCalled()
    })

    // A compromised mailbox alone must not be enough to take the account
    it('refuses without a valid second factor, and changes nothing', async () => {
        const deps = completeDeps({ verifyTotp: vi.fn(() => null) })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    // A code spent on a reset must not be replayable at the sign-in page moments later. signIn.test.ts
    // and setup.test.ts cover the same property for the other two flows; without this, completeReset's
    // half of it has no regression protection.
    it('refuses a code whose step was already recorded, and changes nothing', async () => {
        const deps = completeDeps({ recordTotpUse: vi.fn(async () => false) })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        expect(deps.setPassword).not.toHaveBeenCalled()
        expect(deps.useToken).not.toHaveBeenCalled()
        expect(deps.deleteSessionsFor).not.toHaveBeenCalled()
    })

    // A secret that will not decrypt means the key is wrong or the row was tampered with. The answer is
    // "no", never a fall-through to the recovery-code branch. Nothing currently exercises this catch.
    it('refuses when the stored secret cannot be read, and changes nothing', async () => {
        const deps = completeDeps({ decryptSecret: vi.fn(() => { throw new Error('bad key') }) })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        // The fixture's empty recovery-code list would make a silent fall-through read as "refused" too, so
        // the call itself, not just the outcome, is what proves the catch never reaches that branch
        expect(deps.unusedRecoveryCodes).not.toHaveBeenCalled()
        expect(deps.useRecoveryCode).not.toHaveBeenCalled()
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    // Fails closed: an enrolled client whose secret has gone missing is refused, not exempted
    it('refuses an enrolled client whose secret is missing, rather than exempting them', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({
                id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000),
                client: client({ totpSecret: null }),
            })),
        })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    // The branch a client hits when their phone is lost. Every refusal here is covered; without this the whole
    // recovery-code loop could be deleted and the suite would stay green.
    it('accepts a recovery code when the authenticator code does not match, and spends it', async () => {
        const deps = completeDeps({
            verifyTotp: vi.fn(() => null),
            unusedRecoveryCodes: vi.fn(async () => [{ id: 'code1', codeHash: 'hash1' }]),
            recoveryCodeMatches: vi.fn(() => true),
        })
        expect(await completeReset({ ...input, code: 'ABCDE-FGHJK' }, deps)).toEqual({ ok: true })
        expect(deps.useRecoveryCode).toHaveBeenCalledTimes(1)
        expect(deps.useRecoveryCode).toHaveBeenCalledWith('code1', now)
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
    })

    // A client who never enrolled has no second factor to give, and is forced through enrolment afterwards anyway
    it('accepts the token alone when the client has no authenticator yet', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({
                id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000),
                client: client({ totpSecret: null, totpConfirmedAt: null }),
            })),
        })
        expect(await completeReset({ ...input, code: '' }, deps)).toEqual({ ok: true })
        expect(deps.setPassword).toHaveBeenCalled()
    })

    // Nothing else bounds guessing at the code: a wrong guess does no hashing and does not spend the link,
    // so without this the second factor this page demands can be ground down for the link's full hour
    it('refuses over the IP limit, before the token is even looked up', async () => {
        const deps = completeDeps({ countAttempts: vi.fn(async () => 99) })
        expect(await completeReset(input, deps)).toEqual({ ok: false, error: TOO_MANY_ERROR })
        expect(deps.tokenByHash).not.toHaveBeenCalled()
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    it('counts a wrong code against the IP and against the account', async () => {
        const deps = completeDeps({ verifyTotp: vi.fn(() => null) })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        expect(deps.recordAttempt).toHaveBeenCalledWith(expect.any(String))
        expect(deps.recordFailure).toHaveBeenCalledWith('cl_ABCDEFGH', { failedSignIns: 1, lockedUntil: null })
    })

    // Recording the ladder is pointless unless it is read back somewhere
    it('refuses a locked account even with a valid code', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({
                id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000),
                client: client({ lockedUntil: later(5 * 60 * 1000) }),
            })),
        })
        expect(await completeReset(input, deps)).toEqual({ ok: false, error: LOCKED_ERROR })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    it('refuses an expired link with the same message as a missing one', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(-1), client: client() })),
        })
        expect(await completeReset(input, deps)).toEqual({ ok: false, error: LINK_ERROR })
    })
})
