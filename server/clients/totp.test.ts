import { describe, expect, it } from 'vitest'

import { base32Decode, base32Encode, formatSecretForTyping, hotp, newTotpSecret, otpauthUri, stepFor, verifyTotp } from './totp'

// RFC 4226 and RFC 6238 both use this 20 byte ASCII secret
const SECRET = Buffer.from('12345678901234567890', 'ascii')

describe('base32, against the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
        ['', ''],
        ['f', 'MY======'],
        ['fo', 'MZXQ===='],
        ['foo', 'MZXW6==='],
        ['foob', 'MZXW6YQ='],
        ['fooba', 'MZXW6YTB'],
        ['foobar', 'MZXW6YTBOI======'],
    ]

    it.each(vectors)('encodes %j', (plain, encoded) => {
        expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded)
    })

    it.each(vectors)('decodes back to %j', (plain, encoded) => {
        expect(base32Decode(encoded).toString('ascii')).toBe(plain)
    })

    it('decodes what a person types: lower case, spaces, no padding', () => {
        expect(base32Decode('mzxw 6ytb').toString('ascii')).toBe('fooba')
    })

    it('refuses a character that is not base32', () => {
        expect(() => base32Decode('MZXW6YT1')).toThrow()
    })
})

describe('hotp, against the RFC 4226 appendix D vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']

    it.each(expected.map((code, counter): [number, string] => [counter, code]))('counter %i is %s', (counter, code) => {
        expect(hotp(SECRET, BigInt(counter))).toBe(code)
    })
})

describe('totp, against the RFC 6238 SHA-1 vectors', () => {
    // The RFC prints eight digit codes; the step is the unix time divided by 30
    const vectors: [number, string][] = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ]

    it.each(vectors)('time %i gives %s', (seconds, code) => {
        expect(hotp(SECRET, BigInt(Math.floor(seconds / 30)), 8)).toBe(code)
    })

    it('derives the same step from a Date', () => {
        expect(stepFor(new Date(59_000))).toBe(1n)
    })
})

describe('verifyTotp', () => {
    const at = (seconds: number) => new Date(seconds * 1000)
    const codeFor = (seconds: number) => hotp(SECRET, BigInt(Math.floor(seconds / 30)))

    it('accepts the current code and reports which step matched', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109), at(1111111109))).toBe(37037036n)
    })

    it('accepts one step late, for a phone whose clock is behind', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 - 30), at(1111111109))).toBe(37037035n)
    })

    it('accepts one step early', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 + 30), at(1111111109))).toBe(37037037n)
    })

    it('refuses two steps out, so the window really is about 90 seconds', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 + 60), at(1111111109))).toBeNull()
    })

    it('ignores spaces, because authenticator apps show codes in two groups', () => {
        const spaced = codeFor(1111111109).replace(/^(\d{3})/, '$1 ')
        expect(verifyTotp(SECRET, spaced, at(1111111109))).toBe(37037036n)
    })

    it.each(['', '12345', '1234567', 'abcdef', '12 34 5'])('refuses %j, which is not a six digit code', code => {
        expect(verifyTotp(SECRET, code, at(1111111109))).toBeNull()
    })
})

describe('newTotpSecret', () => {
    it('is 20 bytes, as the RFC recommends', () => {
        expect(newTotpSecret()).toHaveLength(20)
    })

    it('does not repeat itself', () => {
        const secrets = new Set(Array.from({ length: 200 }, () => newTotpSecret().toString('hex')))
        expect(secrets.size).toBe(200)
    })
})

describe('otpauthUri', () => {
    const uri = otpauthUri({ secret: SECRET, email: 'client@example.com' })

    it('is the standard URI an authenticator app expects', () => {
        expect(uri.startsWith('otpauth://totp/Horizons%3Aclient%40example.com?')).toBe(true)
        expect(uri).toContain('issuer=Horizons')
        expect(uri).toContain('algorithm=SHA1')
        expect(uri).toContain('digits=6')
        expect(uri).toContain('period=30')
    })

    it('carries the secret unpadded, which is what apps accept', () => {
        expect(uri).toContain(`secret=${base32Encode(SECRET).replace(/=+$/, '')}`)
        expect(uri).not.toContain('%3D')
    })
})

describe('formatSecretForTyping', () => {
    it('groups in fours for a phone that will not scan', () => {
        expect(formatSecretForTyping(SECRET)).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
    })
})
