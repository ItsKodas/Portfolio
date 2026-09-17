import { describe, expect, it } from 'vitest'
import { BASE, BUDGETS, TIERS, TILE_MIN, ceilingFor } from './tiers'

// A phone-sized viewport at a typical phone pixel ratio, which is where the crash happens
const PHONE = [375, 812, 3] as const
const DESKTOP = [1920, 1080, 2] as const

const ceiling = (
    [vw, vh, dpr]: readonly [number, number, number],
    deviceMemory: number | undefined,
    coarsePointer: boolean,
) => ceilingFor(vw, vh, dpr, deviceMemory, coarsePointer, TIERS, BASE, TILE_MIN, BUDGETS)

describe('ceilingFor', () => {
    it('gives an iPhone the depth tier only', () => {
        expect(ceiling(PHONE, undefined, true)).toBe(1)
    })

    it('gives an 8GB Android up to the water tier', () => {
        expect(ceiling(PHONE, 8, true)).toBe(3)
    })

    it('gives a 4GB Android the depth tier only', () => {
        expect(ceiling(PHONE, 4, true)).toBe(1)
    })

    it('leaves a 2GB Android on the still scene', () => {
        expect(ceiling(PHONE, 2, true)).toBe(0)
    })

    it('gives desktop Safari every tier', () => {
        expect(ceiling(DESKTOP, undefined, false)).toBe(TIERS.length)
    })

    it('gives desktop Chrome every tier', () => {
        expect(ceiling(DESKTOP, 8, false)).toBe(TIERS.length)
    })

    it('clamps the memory factor at both ends', () => {
        // 16GB clamps to the same factor as 7GB, and 0.25GB to the same as 2GB
        expect(ceiling(PHONE, 16, true)).toBe(ceiling(PHONE, 7, true))
        expect(ceiling(PHONE, 0.25, true)).toBe(ceiling(PHONE, 2, true))
    })

    it('includes a tier whose cost lands exactly on the budget', () => {
        // Cost of the base scene plus the first tier, to the byte
        const viewportBytes = 375 * 812 * 3 * 3 * 4
        const exact = BASE.overdraw * viewportBytes + BASE.layers * TILE_MIN
            + TIERS[0].overdraw * viewportBytes + TIERS[0].layers * TILE_MIN
        const budgets = { ...BUDGETS, touch: exact }
        expect(ceilingFor(375, 812, 3, undefined, true, TIERS, BASE, TILE_MIN, budgets)).toBe(1)
    })

    it('returns 0 when even the base scene overruns the budget', () => {
        const budgets = { ...BUDGETS, touch: 1 }
        expect(ceilingFor(375, 812, 3, undefined, true, TIERS, BASE, TILE_MIN, budgets)).toBe(0)
    })

    it('returns 0 for an empty tier list', () => {
        expect(ceilingFor(375, 812, 3, undefined, false, [], BASE, TILE_MIN, BUDGETS)).toBe(0)
    })

    it('costs more at a higher pixel ratio', () => {
        expect(ceiling([375, 812, 4], undefined, true)).toBeLessThanOrEqual(ceiling(PHONE, undefined, true))
    })
})
