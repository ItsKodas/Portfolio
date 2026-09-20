import { describe, expect, it } from 'vitest'

import { MIN_PASSWORD_LENGTH, clientDetailsSchema, codeSchema, emailSchema, passwordSchema, siteSchema } from './schema'

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success

describe('passwordSchema', () => {
    it('demands twelve characters', () => {
        // The literal matters: asserting only against the constant would let someone lower the policy
        // to six and still see a green suite
        expect(MIN_PASSWORD_LENGTH).toBe(12)
        expect(ok(passwordSchema, 'a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true)
        expect(ok(passwordSchema, 'a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false)
        expect(ok(passwordSchema, 'a'.repeat(12))).toBe(true)
        expect(ok(passwordSchema, 'a'.repeat(11))).toBe(false)
    })

    // No composition rules. A long all lower-case passphrase is exactly what current NIST guidance wants.
    it('accepts a plain passphrase with no digits or symbols', () => {
        expect(ok(passwordSchema, 'correct horse battery staple')).toBe(true)
    })

    it('refuses something absurdly long, which would only be a way to burn scrypt time', () => {
        expect(ok(passwordSchema, 'x'.repeat(5000))).toBe(false)
    })
})

describe('codeSchema', () => {
    it('accepts a six digit code and a recovery code', () => {
        expect(ok(codeSchema, '123456')).toBe(true)
        expect(ok(codeSchema, 'ABCDE-FGHJK')).toBe(true)
    })

    it('refuses empty and overlong input', () => {
        expect(ok(codeSchema, '')).toBe(false)
        expect(ok(codeSchema, 'x'.repeat(100))).toBe(false)
    })
})

describe('clientDetailsSchema', () => {
    const valid = { name: 'Ann Example', company: 'Acme', email: 'ann@example.com' }

    it('accepts a full set of details', () => {
        expect(ok(clientDetailsSchema, valid)).toBe(true)
    })

    it('turns an empty company into null, so the column is never an empty string', () => {
        expect(clientDetailsSchema.parse({ ...valid, company: '  ' }).company).toBeNull()
    })

    it('lower-cases and trims the email, because it is the sign-in identity', () => {
        expect(clientDetailsSchema.parse({ ...valid, email: '  Ann@Example.COM ' }).email).toBe('ann@example.com')
    })

    // Line breaks would otherwise travel into an email header
    it('refuses a line break in the name', () => {
        expect(ok(clientDetailsSchema, { ...valid, name: 'Ann\nBcc: someone@example.com' })).toBe(false)
    })

    it('refuses a missing name or a bad email', () => {
        expect(ok(clientDetailsSchema, { ...valid, name: '   ' })).toBe(false)
        expect(ok(clientDetailsSchema, { ...valid, email: 'not an address' })).toBe(false)
    })
})

describe('siteSchema', () => {
    it('accepts a hostd project id', () => {
        expect(ok(siteSchema, { projectId: 'acme-bakery', name: 'Acme Bakery' })).toBe(true)
    })

    // Copied verbatim from hostd/src/shared/formats.ts, so the portal cannot store an id hostd would reject
    it.each(['Acme-Bakery', '-acme', 'a', 'acme_bakery', 'x'.repeat(32)])('refuses the project id %j', projectId => {
        expect(ok(siteSchema, { projectId, name: 'Site' })).toBe(false)
    })

    it.each(['hostd', 'mail', 'horizons'])('refuses the reserved project id %j', projectId => {
        expect(ok(siteSchema, { projectId, name: 'Site' })).toBe(false)
    })
})
