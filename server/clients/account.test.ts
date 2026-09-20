import { describe, expect, it, vi } from 'vitest'

import { WRONG_PASSWORD, changePassword, describeDevice, regenerateRecoveryCodes } from './account'

const now = new Date('2026-09-20T10:00:00Z')
const client = {
    id: 'cl_ABCDEFGH',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    name: 'Ann',
    company: null,
    email: 'ann@example.com',
    passwordHash: 'stored',
    passwordUpdatedAt: null,
    totpSecret: null,
    totpConfirmedAt: null,
    suspendedAt: null,
    lastSignInAt: null,
    failedSignIns: 0,
    lockedUntil: null,
} as never

const changeDeps = (overrides: Record<string, unknown> = {}) => ({
    verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    deleteSessionsFor: vi.fn(async () => {}),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendChanged: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('changePassword', () => {
    // Every other session goes, and the one doing the changing stays, so nobody signs themselves out
    it('keeps the current session and drops the others', async () => {
        const deps = changeDeps()
        expect(await changePassword({ client, sessionId: 'session1', current: 'old one', next: 'a new passphrase' }, deps))
            .toEqual({ ok: true })
        expect(deps.deleteSessionsFor).toHaveBeenCalledWith('cl_ABCDEFGH', 'session1')
        expect(deps.sendChanged).toHaveBeenCalled()
    })

    it('refuses when the current password is wrong, and changes nothing', async () => {
        const deps = changeDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })
        expect(await changePassword({ client, sessionId: 'session1', current: 'wrong', next: 'a new passphrase' }, deps))
            .toEqual({ ok: false, error: WRONG_PASSWORD })
        expect(deps.setPassword).not.toHaveBeenCalled()
        expect(deps.deleteSessionsFor).not.toHaveBeenCalled()
    })
})

describe('regenerateRecoveryCodes', () => {
    it('replaces the whole set after the password is confirmed', async () => {
        const deps = {
            verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
            newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
            hashRecoveryCode: vi.fn((code: string) => `hashed:${code}`),
            replaceRecoveryCodes: vi.fn(async () => {}),
        }
        const result = await regenerateRecoveryCodes({ client, password: 'right' }, deps)
        expect((result as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10)
        expect(deps.replaceRecoveryCodes).toHaveBeenCalled()
    })

    it('refuses without the password', async () => {
        const deps = {
            verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })),
            newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
            hashRecoveryCode: vi.fn((code: string) => code),
            replaceRecoveryCodes: vi.fn(async () => {}),
        }
        expect(await regenerateRecoveryCodes({ client, password: 'wrong' }, deps)).toEqual({ ok: false, error: WRONG_PASSWORD })
        expect(deps.replaceRecoveryCodes).not.toHaveBeenCalled()
    })
})

describe('describeDevice', () => {
    it.each([
        ['Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Windows'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome on macOS'],
    ])('reads %j as %j', (userAgent, expected) => {
        expect(describeDevice(userAgent)).toBe(expected)
    })

    // The device identifier must be tested before the browser one: Chrome's user agent contains "Safari/",
    // so if Safari is tested first, the Chrome test fails. Edge's contains both, so Edge must be tested first too.
    it.each([
        ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0', 'Edge on Windows'],
    ])('reads %j as %j', (userAgent, expected) => {
        expect(describeDevice(userAgent)).toBe(expected)
    })

    it('falls back rather than showing a raw user agent string', () => {
        expect(describeDevice(null)).toBe('Unknown device')
        expect(describeDevice('something else entirely')).toBe('Unknown device')
    })
})
