import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { newRecoveryCode, normaliseRecoveryCode } from './ids'
import { SecretError, decryptSecret, encryptSecret, hashRecoveryCode, recoveryCodeMatches } from './secrets'

const key = randomBytes(32)
const otherKey = randomBytes(32)

describe('encryptSecret and decryptSecret', () => {
    it('round-trips', () => {
        const stored = encryptSecret('JBSWY3DPEHPK3PXP', key)
        expect(decryptSecret(stored, key)).toBe('JBSWY3DPEHPK3PXP')
    })

    it('never contains the plaintext', () => {
        expect(encryptSecret('JBSWY3DPEHPK3PXP', key)).not.toContain('JBSWY3DPEHPK3PXP')
    })

    it('uses a fresh nonce, so the same secret stores differently each time', () => {
        expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key))
    })

    it('carries a version, so the key can be rotated later', () => {
        expect(encryptSecret('same', key).startsWith('v1$')).toBe(true)
    })

    it('refuses a value encrypted under a different key', () => {
        const stored = encryptSecret('JBSWY3DPEHPK3PXP', otherKey)
        expect(() => decryptSecret(stored, key)).toThrow(SecretError)
    })

    // GCM authenticates as well as encrypts, so a changed byte is detected rather than decrypting to rubbish
    it('refuses a tampered value', () => {
        const parts = encryptSecret('JBSWY3DPEHPK3PXP', key).split('$')
        const body = Buffer.from(parts[3], 'base64')
        body[0] ^= 0xff
        parts[3] = body.toString('base64')
        expect(() => decryptSecret(parts.join('$'), key)).toThrow(SecretError)
    })

    it.each(['', 'nonsense', 'v2$a$b$c', 'v1$a$b'])('refuses the malformed value %j', stored => {
        expect(() => decryptSecret(stored, key)).toThrow(SecretError)
    })

    it('refuses a key that is not 32 bytes', () => {
        expect(() => encryptSecret('x', randomBytes(16))).toThrow(SecretError)
    })
})

describe('recovery code hashing', () => {
    it('matches the code it was made from', () => {
        const stored = hashRecoveryCode('ABCDE12345', key)
        expect(recoveryCodeMatches('ABCDE12345', stored, key)).toBe(true)
    })

    it('does not match another code', () => {
        expect(recoveryCodeMatches('ZZZZZ99999', hashRecoveryCode('ABCDE12345', key), key)).toBe(false)
    })

    // Keyed, so a leaked database dump on its own doesn't let anyone check guesses offline
    it('does not match under a different key', () => {
        expect(recoveryCodeMatches('ABCDE12345', hashRecoveryCode('ABCDE12345', otherKey), key)).toBe(false)
    })

    it('does not throw on a stored value of the wrong shape', () => {
        expect(recoveryCodeMatches('ABCDE12345', 'not hex', key)).toBe(false)
    })
})

// Everywhere else the storing and the checking are stubbed apart from each other, and the tests above use
// literals that are already normalised. A real generated code, hashed the way wiring.ts hashes it and checked
// the way the sign-in and reset flows check it, is the only thing that holds the two sides together.
describe('a generated recovery code, end to end', () => {
    // Exactly what confirmEnrolmentDeps and regenerateDeps store
    const store = (code: string) => hashRecoveryCode(normaliseRecoveryCode(code), key)
    // Exactly what codeStep and completeReset compare against it
    const check = (typed: string, stored: string) => recoveryCodeMatches(normaliseRecoveryCode(typed), stored, key)

    it('matches as printed, and as a person would actually type it', () => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
            const code = newRecoveryCode()
            const stored = store(code)
            expect(check(code, stored)).toBe(true)
            // Lower case and no hyphen: the form takes whatever is typed, and this is what people type
            expect(check(code.toLowerCase().replace('-', ''), stored)).toBe(true)
            expect(check(` ${code.toLowerCase()} `, stored)).toBe(true)
        }
    })

    it('does not match a different generated code', () => {
        const stored = store(newRecoveryCode())
        for (let attempt = 0; attempt < 100; attempt += 1) {
            expect(check(newRecoveryCode(), stored)).toBe(false)
        }
    })
})
