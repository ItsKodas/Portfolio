import { describe, expect, it, vi } from 'vitest'

import { CODE_ERROR, GENERIC_ERROR, LOCKED_ERROR, REPLAYED_ERROR, TOO_MANY_ERROR, codeStep, passwordStep } from './signIn'

const now = new Date('2026-09-20T10:00:00Z')

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

const passwordDeps = (overrides: Record<string, unknown> = {}) => ({
    findByEmail: vi.fn(async () => client()),
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
    burnTime: vi.fn(async () => {}),
    rehash: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 'session1' })),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

const input = { email: 'ann@example.com', password: 'correct horse battery', userAgent: 'Firefox' }

describe('passwordStep', () => {
    it('creates a pending session and sends a set-up client to the code step', async () => {
        const deps = passwordDeps()
        const result = await passwordStep(input, deps)

        expect(result).toEqual({ ok: true, next: 'code', token: 'raw-token', expiresAt: new Date('2026-09-20T10:10:00Z') })
        // Stored hashed, never raw
        expect(deps.createSession).toHaveBeenCalledWith('cl_ABCDEFGH', 'hashed:raw-token', expect.any(Date), 'Firefox')
    })

    it('sends a client with no authenticator to enrolment instead', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ totpConfirmedAt: null })) })
        expect(await passwordStep(input, deps)).toMatchObject({ ok: true, next: 'setup' })
    })

    // The expensive path must sit behind the cheap one, or the form is a memory lever
    it('checks the IP limit before hashing anything', async () => {
        const order: string[] = []
        const deps = passwordDeps({
            countAttempts: vi.fn(async () => { order.push('count'); return 99 }),
            verifyPassword: vi.fn(async () => { order.push('hash'); return { ok: true, needsRehash: false } }),
            burnTime: vi.fn(async () => { order.push('hash') }),
        })

        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: TOO_MANY_ERROR })
        expect(order).toEqual(['count'])
    })

    // A missing account and a wrong password must be indistinguishable, in answer and in timing
    it('burns hashing time when the email is unknown, and gives the same message as a wrong password', async () => {
        const unknown = passwordDeps({ findByEmail: vi.fn(async () => null) })
        const wrong = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })

        expect(await passwordStep(input, unknown)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(await passwordStep(input, wrong)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(unknown.burnTime).toHaveBeenCalled()
    })

    it('gives the same message for an invited client who has not set a password', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ passwordHash: null })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(deps.burnTime).toHaveBeenCalled()
    })

    it('gives the same message for a suspended client, even with the right password', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ suspendedAt: now })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(deps.createSession).not.toHaveBeenCalled()
    })

    // Revealed only to someone who already has the password, so it enumerates nothing
    it('tells a locked client it is locked once the password is right', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ lockedUntil: new Date('2026-09-20T10:05:00Z') })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: LOCKED_ERROR })
    })

    it('keeps the vague message for a locked client when the password is wrong', async () => {
        const deps = passwordDeps({
            findByEmail: vi.fn(async () => client({ lockedUntil: new Date('2026-09-20T10:05:00Z') })),
            verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })),
        })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
    })

    it('records the attempt and the failure when the password is wrong', async () => {
        const deps = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })
        await passwordStep(input, deps)
        expect(deps.recordAttempt).toHaveBeenCalledWith(expect.any(String))
        expect(deps.recordFailure).toHaveBeenCalledWith('cl_ABCDEFGH', { failedSignIns: 1, lockedUntil: null })
    })

    it('upgrades a hash stored at an old cost, without making the client do anything', async () => {
        const deps = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: true })) })
        await passwordStep(input, deps)
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
    })

    // The password step must never finish a sign-in on its own
    it('never marks the second factor as done', async () => {
        const deps = passwordDeps()
        await passwordStep(input, deps)
        expect(deps).not.toHaveProperty('completeMfa')
    })
})

const session = { id: 'session1', createdAt: now, client: client() } as never

const codeDeps = (overrides: Record<string, unknown> = {}) => ({
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    unusedRecoveryCodes: vi.fn(async () => [{ id: 'code1', codeHash: 'hash1' }]),
    recoveryCodeMatches: vi.fn(() => false),
    useRecoveryCode: vi.fn(async () => {}),
    completeMfa: vi.fn(async () => {}),
    recordSuccess: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('codeStep', () => {
    it('accepts a valid code, finishes the session and records the step against replay', async () => {
        const deps = codeDeps()
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: true })
        expect(deps.recordTotpUse).toHaveBeenCalledWith('cl_ABCDEFGH', 37037036n)
        expect(deps.completeMfa).toHaveBeenCalled()
        expect(deps.recordSuccess).toHaveBeenCalledWith('cl_ABCDEFGH', now)
        expect(deps.prune).toHaveBeenCalled()
    })

    it('refuses a code whose step was already used, and does not finish the session', async () => {
        const deps = codeDeps({ recordTotpUse: vi.fn(async () => false) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: REPLAYED_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
    })

    it('accepts a recovery code when the authenticator code does not match, and spends it', async () => {
        const deps = codeDeps({ verifyTotp: vi.fn(() => null), recoveryCodeMatches: vi.fn(() => true) })
        expect(await codeStep({ session, code: 'ABCDE-FGHJK' }, deps)).toEqual({ ok: true })
        expect(deps.useRecoveryCode).toHaveBeenCalledWith('code1', now)
        expect(deps.completeMfa).toHaveBeenCalled()
    })

    it('refuses when neither reading matches, and counts the failure', async () => {
        const deps = codeDeps({ verifyTotp: vi.fn(() => null) })
        expect(await codeStep({ session, code: '000000' }, deps)).toEqual({ ok: false, error: CODE_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
        expect(deps.recordFailure).toHaveBeenCalled()
    })

    // A secret that will not decrypt means the key is wrong. Refuse, never fall through to "no second factor".
    it('refuses rather than letting anyone past when the secret cannot be decrypted', async () => {
        const deps = codeDeps({ decryptSecret: vi.fn(() => { throw new Error('bad key') }) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: CODE_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
        expect(deps.log).toHaveBeenCalled()
    })

    it('refuses over the IP limit without touching the secret', async () => {
        const deps = codeDeps({ countAttempts: vi.fn(async () => 99) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: TOO_MANY_ERROR })
        expect(deps.decryptSecret).not.toHaveBeenCalled()
    })

    // The ladder this step writes on every wrong code is only a bound if it is read back here. Without it,
    // someone holding the password grinds codes through a locked account and only the per-IP counter stops
    // them, which a pool of addresses sidesteps.
    it('refuses a locked client, even with a valid code', async () => {
        const deps = codeDeps()
        const locked = { id: 'session1', createdAt: now, client: client({ lockedUntil: new Date('2026-09-20T10:05:00Z') }) } as never
        expect(await codeStep({ session: locked, code: '123456' }, deps)).toEqual({ ok: false, error: LOCKED_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
        expect(deps.decryptSecret).not.toHaveBeenCalled()
    })
})

// The test the whole design rests on
describe('the only ways to finish a sign-in', () => {
    it('completes the second factor only after a verified code or a spent recovery code', async () => {
        const good = codeDeps()
        await codeStep({ session, code: '123456' }, good)
        expect(good.completeMfa).toHaveBeenCalledTimes(1)

        const recovery = codeDeps({ verifyTotp: vi.fn(() => null), recoveryCodeMatches: vi.fn(() => true) })
        await codeStep({ session, code: 'ABCDE-FGHJK' }, recovery)
        expect(recovery.completeMfa).toHaveBeenCalledTimes(1)

        for (const deps of [
            codeDeps({ verifyTotp: vi.fn(() => null) }),
            codeDeps({ recordTotpUse: vi.fn(async () => false) }),
            codeDeps({ countAttempts: vi.fn(async () => 99) }),
            codeDeps({ decryptSecret: vi.fn(() => { throw new Error('bad key') }) }),
        ]) {
            await codeStep({ session, code: '123456' }, deps)
            expect(deps.completeMfa).not.toHaveBeenCalled()
        }
    })
})
