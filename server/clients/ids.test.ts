import { describe, expect, it } from 'vitest'

import { ALPHABET, CLIENT_ID_PATTERN, newClientId, newRecoveryCode, normaliseRecoveryCode, randomBase32 } from './ids'

// A stand-in for randomBytes that returns the bytes we name, so the output is predictable
const bytes = (...values: number[]) => () => Buffer.from(values)

describe('ALPHABET', () => {
    it('is Crockford base32, so an id cannot spell a word or be misread', () => {
        expect(ALPHABET).toHaveLength(32)
        for (const letter of ['I', 'L', 'O', 'U']) expect(ALPHABET).not.toContain(letter)
        expect(new Set(ALPHABET).size).toBe(32)
    })
})

describe('randomBase32', () => {
    it('maps the low five bits of each byte to a character', () => {
        // 0 -> "0", 1 -> "1", 31 -> "Z", and 32 wraps back to "0" because only five bits are used
        expect(randomBase32(4, bytes(0, 1, 31, 32))).toBe('01Z0')
    })

    it('asks for exactly one byte per character', () => {
        let asked = 0
        randomBase32(7, size => { asked = size; return Buffer.alloc(size) })
        expect(asked).toBe(7)
    })

    it('produces only alphabet characters', () => {
        const out = randomBase32(64)
        expect(out).toHaveLength(64)
        for (const character of out) expect(ALPHABET).toContain(character)
    })
})

describe('newClientId', () => {
    it('is cl_ plus eight characters', () => {
        expect(newClientId(bytes(0, 1, 2, 3, 4, 5, 6, 7))).toBe('cl_01234567')
    })

    it('matches its own pattern, and hostd would accept it', () => {
        const id = newClientId()
        expect(CLIENT_ID_PATTERN.test(id)).toBe(true)
        // hostd/src/shared/formats.ts, copied verbatim
        expect(/^[A-Za-z0-9_-]{1,64}$/.test(id)).toBe(true)
    })

    it('does not repeat itself', () => {
        const ids = new Set(Array.from({ length: 500 }, () => newClientId()))
        expect(ids.size).toBe(500)
    })
})

describe('newRecoveryCode', () => {
    it('is two groups of five, hyphenated', () => {
        expect(newRecoveryCode(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9))).toBe('01234-56789')
    })
})

describe('normaliseRecoveryCode', () => {
    it('accepts what someone actually types', () => {
        expect(normaliseRecoveryCode('  abcde-fghjk ')).toBe('ABCDEFGHJK')
    })

    it('folds the Crockford lookalikes, so O reads as zero and I and L read as one', () => {
        expect(normaliseRecoveryCode('O0I1L')).toBe('00111')
    })

    it('drops anything that is not part of a code', () => {
        expect(normaliseRecoveryCode('ab-cd ef.gh')).toBe('ABCDEFGH')
    })
})
