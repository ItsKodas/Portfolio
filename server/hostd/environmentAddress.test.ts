import { describe, expect, it } from 'vitest'

import { HORIZONS_BASE, addressBases, addressProblem, isAddressLabel, prefilledPrefix } from './environmentAddress'

describe('isAddressLabel', () => {
    it('takes one lowercase DNS label', () => {
        for (const label of ['uat1', 'uat1-acme', 'a', '0', 'a'.repeat(63), 'a-b-c']) {
            expect(isAddressLabel(label), label).toBe(true)
        }
    })

    it('refuses a dot, a capital, an edge hyphen, a blank and a long one', () => {
        for (const label of ['', 'a.b', 'Uat1', '-uat', 'uat-', 'uat 1', 'uat_1', 'a'.repeat(64)]) {
            expect(isAddressLabel(label), label).toBe(false)
        }
    })
})

describe('addressBases', () => {
    it('offers horizons.gg alone when live has no primary domain', () => {
        expect(addressBases(null)).toEqual([HORIZONS_BASE])
    })

    it("offers live's primary domain beside horizons.gg", () => {
        expect(addressBases('acme.com')).toEqual([HORIZONS_BASE, 'acme.com'])
    })

    it('does not offer horizons.gg twice', () => {
        expect(addressBases('horizons.gg')).toEqual([HORIZONS_BASE])
    })
})

describe('prefilledPrefix', () => {
    it('is <env>-<site id> under horizons.gg, and <env> under the primary domain', () => {
        expect(prefilledPrefix('uat1', 'acme', HORIZONS_BASE)).toBe('uat1-acme')
        expect(prefilledPrefix('uat1', 'acme', 'acme.com')).toBe('uat1')
    })

    it('is blank until there is a name', () => {
        expect(prefilledPrefix('', 'acme', HORIZONS_BASE)).toBe('')
        expect(prefilledPrefix('', 'acme', 'acme.com')).toBe('')
    })
})

describe('addressProblem', () => {
    it('takes one label below horizons.gg or below live\'s primary domain', () => {
        expect(addressProblem('uat1-acme.horizons.gg', 'acme.com')).toBeNull()
        expect(addressProblem('uat1.acme.com', 'acme.com')).toBeNull()
        expect(addressProblem('uat1-acme.horizons.gg', null)).toBeNull()
    })

    it('refuses a missing address', () => {
        expect(addressProblem('', 'acme.com')).toBe('An environment needs an address.')
    })

    it('refuses a prefix that is not one label', () => {
        expect(addressProblem('-uat.horizons.gg', null)).toMatch(/lowercase letters, digits and hyphens/)
        expect(addressProblem('a.b.acme.com', 'acme.com')).toMatch(/must be under horizons\.gg or acme\.com/)
    })

    it('refuses any other base, naming the ones allowed', () => {
        expect(addressProblem('uat1.other.com', 'acme.com')).toBe('uat1.other.com must be under horizons.gg or acme.com.')
        expect(addressProblem('uat1.acme.com', null)).toBe('uat1.acme.com must be under horizons.gg.')
        // The apex of a base is not one label below it
        expect(addressProblem('horizons.gg', null)).toBe('horizons.gg must be under horizons.gg.')
    })
})
