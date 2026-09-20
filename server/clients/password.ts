// Password hashing. scrypt rather than argon2 because it ships with Node: argon2 is a native module, the image
// is node:24-alpine, and a security-critical path is the worst place to take on a build toolchain.

import 'server-only'

import { randomBytes, scrypt as scryptWithCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

type ScryptOptions = { N: number, r: number, p: number, maxmem: number }
const scrypt = promisify(scryptWithCallback) as (password: string, salt: Buffer, length: number, options: ScryptOptions) => Promise<Buffer>

export type Cost = { logN: number, r: number, p: number }

// OWASP's first scrypt option. Stored with every hash, so raising or lowering it later doesn't invalidate a
// single password: verify reads the cost off the value it is checking.
export const COST: Cost = { logN: 17, r: 8, p: 1 }

const KEY_LENGTH = 32
const SALT_LENGTH = 16

// The most work we will ever agree to do for one verification. A stored cost far above the current one
// is a corrupted or hand-edited row, not something hashPassword wrote, and running it would be a denial
// of service against ourselves. Absolute rather than relative to COST, so changing COST later can never
// invalidate a hash that is already stored.
const MAX_WORK = 4 * (2 ** 17) * 8

const workOf = (cost: Cost) => (2 ** cost.logN) * cost.r * cost.p

// scrypt allocates about 128 * N * r bytes, which at COST is roughly 134 MB. Node's default maxmem is 32 MB,
// so without raising it the call throws.
const maxmem = ({ logN, r }: Cost) => 256 * (2 ** logN) * r

// NFKC first, so a password typed with a different Unicode composition still matches the one that was stored
const derive = (password: string, salt: Buffer, cost: Cost) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: 2 ** cost.logN, r: cost.r, p: cost.p, maxmem: maxmem(cost) })

export async function hashPassword(password: string, cost: Cost = COST): Promise<string> {
    const salt = randomBytes(SALT_LENGTH)
    const hash = await derive(password, salt, cost)
    return `scrypt$${cost.logN}$${cost.r}$${cost.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export type ParsedPassword = { cost: Cost, salt: Buffer, hash: Buffer }

// Defensive on purpose. Anything unparseable answers "doesn't match" rather than throwing, because a data
// problem must not become a 500 on every sign-in attempt.
export function parseStoredPassword(stored: string): ParsedPassword | null {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null
    const [logN, r, p] = [parts[1], parts[2], parts[3]].map(Number)
    if (![logN, r, p].every(value => Number.isInteger(value) && value > 0)) return null
    // An absurd cost would be a denial of service against ourselves, so refuse it rather than run it
    if (logN > 20 || r > 32 || p > 16) return null
    if (workOf({ logN, r, p }) > MAX_WORK) return null
    const salt = Buffer.from(parts[4], 'base64')
    const hash = Buffer.from(parts[5], 'base64')
    if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) return null
    return { cost: { logN, r, p }, salt, hash }
}

export type VerifyResult = { ok: boolean, needsRehash: boolean }

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
    const parsed = parseStoredPassword(stored)
    if (!parsed) return { ok: false, needsRehash: false }
    const candidate = await derive(password, parsed.salt, parsed.cost)
    // Both buffers are KEY_LENGTH, so timingSafeEqual never throws on a length mismatch
    const ok = timingSafeEqual(candidate, parsed.hash)
    return { ok, needsRehash: ok && parsed.cost.logN < COST.logN }
}

// Burns the same work as a real verification when no account matched, so a missing email and a wrong password
// take the same time and the form can't be used to discover who the clients are.
export async function burnPasswordTime(cost: Cost = COST): Promise<void> {
    await derive('a password that matches nothing', Buffer.alloc(SALT_LENGTH), cost)
}
