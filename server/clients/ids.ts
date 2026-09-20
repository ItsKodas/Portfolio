// Identifiers a person has to read, type or copy. Deliberately not cuid: a client id is typed by hand into
// hostd's projects.yaml, so it has to survive being read off a screen.

import 'server-only'

import { randomBytes } from 'node:crypto'

type Random = (bytes: number) => Buffer

// Crockford's base32: no I, L, O or U, so an id can't spell a word and can't be confused with 1 or 0
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// One byte per character, using its low five bits. Uniform without rejection sampling because 32 divides 256
// exactly, so every character is equally likely.
export function randomBase32(length: number, random: Random = randomBytes): string {
    const source = random(length)
    let out = ''
    for (let index = 0; index < length; index += 1) out += ALPHABET[source[index] & 31]
    return out
}

export const CLIENT_ID_PATTERN = /^cl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/

// 40 bits. Collisions are handled by the unique primary key and a retry in the repo, not by length alone.
export const newClientId = (random: Random = randomBytes) => `cl_${randomBase32(8, random)}`

// Two groups of five, about 50 bits, which is far past guessing and still readable off a printout. One draw of
// ten bytes rather than two of five, so a stand-in in the tests only has to supply one buffer.
export function newRecoveryCode(random: Random = randomBytes): string {
    const source = random(10)
    let characters = ''
    for (let index = 0; index < 10; index += 1) characters += ALPHABET[source[index] & 31]
    return `${characters.slice(0, 5)}-${characters.slice(5)}`
}

// What someone types is not what we stored: they may lower-case it, drop the hyphen, or hit O for zero and I or
// L for one. Crockford defines exactly those aliases, so fold them before comparing.
export const normaliseRecoveryCode = (input: string) => input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
