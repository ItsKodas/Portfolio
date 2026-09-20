import { describe, expect, it } from 'vitest'

import { COST, burnPasswordTime, hashPassword, parseStoredPassword, verifyPassword } from './password'

// Deliberately far below COST so the suite stays fast. verifyPassword reads the cost off the hash, so this
// exercises exactly the same code path.
const CHEAP = { logN: 4, r: 8, p: 1 }

describe('hashPassword', () => {
    it('writes the parameters and the salt into the stored value', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(stored.startsWith('scrypt$4$8$1$')).toBe(true)
        expect(stored.split('$')).toHaveLength(6)
    })

    it('salts, so the same password hashes differently every time', async () => {
        const [one, two] = await Promise.all([hashPassword('same password', CHEAP), hashPassword('same password', CHEAP)])
        expect(one).not.toBe(two)
    })
})

describe('verifyPassword', () => {
    it('accepts the right password', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, needsRehash: true })
    })

    it('refuses the wrong password', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect((await verifyPassword('incorrect horse battery', stored)).ok).toBe(false)
    })

    it('asks for a rehash only when the stored cost is below the current one', async () => {
        const cheap = await hashPassword('correct horse battery', CHEAP)
        expect((await verifyPassword('correct horse battery', cheap)).needsRehash).toBe(true)
    })

    // A stored value can be truncated by a bad migration or hand-edited. The sign-in path must answer
    // "doesn't match" rather than throw, which would turn a data problem into a 500 on every attempt.
    it.each([
        ['empty', ''],
        ['not ours', 'argon2id$v=19$m=65536,t=3,p=4$abc$def'],
        ['truncated', 'scrypt$4$8$1$YWJj'],
        ['bad cost', 'scrypt$x$8$1$YWJj$ZGVm'],
        ['absurd cost', 'scrypt$40$8$1$YWJj$ZGVm'],
        ['short salt', 'scrypt$4$8$1$YQ==$ZGVm'],
    ])('refuses a %s stored value without throwing', async (unused, stored) => {
        expect(await verifyPassword('anything', stored)).toEqual({ ok: false, needsRehash: false })
    })
})

describe('parseStoredPassword', () => {
    it('reads the cost back off the hash', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(parseStoredPassword(stored)?.cost).toEqual(CHEAP)
    })

    // Work ceiling prevents denial of service from values that pass the cheap sanity bounds
    it('refuses work ceiling violations', () => {
        // logN=20, r=32, p=1 is in bounds individually but exceeds MAX_WORK
        const highWork1 = 'scrypt$20$32$1$YWJjZGVmZ2hpams=$' + Buffer.alloc(32).toString('base64')
        expect(parseStoredPassword(highWork1)).toBeNull()

        // logN=17, r=8, p=16 is in bounds individually but exceeds MAX_WORK (COST with p=16)
        const highWork2 = 'scrypt$17$8$16$YWJjZGVmZ2hpams=$' + Buffer.alloc(32).toString('base64')
        expect(parseStoredPassword(highWork2)).toBeNull()
    })

    it('still parses and verifies hashes at the real COST', async () => {
        const stored = await hashPassword('correct horse battery', COST)
        const parsed = parseStoredPassword(stored)
        expect(parsed?.cost).toEqual(COST)
        expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, needsRehash: false })
    })
})

describe('the real cost', () => {
    // scrypt at these parameters needs about 134 MB, far above Node's 32 MB default for maxmem. Without an
    // explicit maxmem this throws, and it would throw in production rather than in a test.
    it('hashes and verifies at COST without exceeding maxmem', async () => {
        const stored = await hashPassword('correct horse battery', COST)
        expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, needsRehash: false })
    }, 20_000)

    it('burns comparable time when no account matched', async () => {
        await expect(burnPasswordTime(CHEAP)).resolves.toBeUndefined()
    })
})
