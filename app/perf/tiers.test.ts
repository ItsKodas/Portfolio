import { describe, expect, it } from 'vitest'
import { BASE, BUDGETS, TIERS, TILE_MIN, ceilingFor } from './tiers'

// A phone-sized viewport at a typical phone pixel ratio, which is where the crash happens
const PHONE = [375, 812, 3] as const
const DESKTOP = [1920, 1080, 2] as const

// Real display geometries, at the logical size and dpr 2 that macOS reports for each panel. 1920x1080 above is the
// only desktop size the rest of this file covers, and it sits comfortably inside the fixed pointer floor, which is
// how a fixed pointer ceiling survived here: the two largest of these used to fall to the depth tier alone in
// Safari, which reports no navigator.deviceMemory on macOS any more than it does on iOS, so the memory multiplier
// rescued Chrome and did nothing for Safari.
const DISPLAYS: [string, readonly [number, number, number]][] = [
    ['a MacBook Pro 16 at its default scaling', [1728, 970, 2]],
    ['a MacBook Pro 16 scaled for more space', [2056, 1180, 2]],
    ['an iMac 24', [2240, 1160, 2]],
    ['a Studio Display', [2560, 1340, 2]],
    ['a Pro Display XDR', [3008, 1590, 2]],
]

const ceiling = (
    [vw, vh, dpr]: readonly [number, number, number],
    deviceMemory: number | undefined,
    coarsePointer: boolean,
) => ceilingFor(vw, vh, dpr, deviceMemory, coarsePointer, TIERS, BASE, TILE_MIN, BUDGETS)

describe('ceilingFor', () => {
    // Phones got the whole scene once the browser moved the layers: a phone that had crashed and then stalled at a
    // tier or two ran the full scene flawlessly with that, frosted glass off and nothing moved by script
    it('gives an iPhone the whole scene', () => {
        expect(ceiling(PHONE, undefined, true)).toBe(TIERS.length)
    })

    it('gives an 8GB Android the whole scene', () => {
        expect(ceiling(PHONE, 8, true)).toBe(TIERS.length)
    })

    it('gives a 4GB Android the whole scene', () => {
        expect(ceiling(PHONE, 4, true)).toBe(TIERS.length)
    })

    it('keeps a 2GB Android to the parallax', () => {
        expect(ceiling(PHONE, 2, true)).toBe(1)
    })

    it('gives desktop Safari every tier', () => {
        expect(ceiling(DESKTOP, undefined, false)).toBe(TIERS.length)
    })

    it('gives desktop Chrome every tier', () => {
        expect(ceiling(DESKTOP, 8, false)).toBe(TIERS.length)
    })

    for (const [name, size] of DISPLAYS) {
        it(`gives ${name} every tier, whether or not the browser reports memory`, () => {
            expect(ceiling(size, undefined, false)).toBe(TIERS.length)   // Safari, which reports none
            expect(ceiling(size, 8, false)).toBe(TIERS.length)           // Chrome, which does
        })
    }

    it('does not give a bigger pointer display less scene than a smaller one', () => {
        // The pointer counterpart of the touch guard below, in the same regime and for the same reason. Both
        // viewports are past the crossover where the area term overtakes the fixed floor (viewportBytes x
        // pointerViewports > pointer, so pointer === Math.max(...) never activates for either side), which is the
        // only place a fixed ceiling can invert the ordering, and the larger is exactly 4x the area of the smaller
        // at the same dpr. Neither reports deviceMemory, as macOS Safari does not.
        //
        // Both land on every tier today, so this cannot yet be strict: cumulative full-scene overdraw is 21.9,
        // under pointerViewports (26), so once the area term governs, cost and allowance both scale
        // linearly with area and every viewport in this regime clears all four tiers whatever its size. The
        // assertion documents that the ordering holds; this comment documents why it cannot yet be strict.
        const small = ceiling([2000, 1400, 2], undefined, false)
        const large = ceiling([4000, 2800, 2], undefined, false)
        expect(large).toBeGreaterThanOrEqual(small)
    })

    it('clamps the memory factor at both ends', () => {
        // 16GB clamps to the same factor as 6GB, and 0.25GB to the same as 2GB
        expect(ceiling(PHONE, 16, true)).toBe(ceiling(PHONE, 6, true))
        expect(ceiling(PHONE, 0.25, true)).toBe(ceiling(PHONE, 2, true))
    })

    it('includes a tier whose cost lands exactly on the budget', () => {
        // Cost of the base scene plus the first tier, to the byte. touchViewports is zeroed so the area-scaled
        // allowance can't outgrow the exact floor and take over the Math.max.
        const viewportBytes = 375 * 812 * 3 * 3 * 4
        const exact = BASE.overdraw * viewportBytes + BASE.layers * TILE_MIN
            + TIERS[0].overdraw * viewportBytes + TIERS[0].layers * TILE_MIN
        const budgets = { ...BUDGETS, touchFloor: exact, touchViewports: 0 }
        expect(ceilingFor(375, 812, 3, undefined, true, TIERS, BASE, TILE_MIN, budgets)).toBe(1)
    })

    it('returns 0 when even the base scene overruns the budget', () => {
        const budgets = { ...BUDGETS, touchFloor: 1, touchViewports: 0 }
        expect(ceilingFor(375, 812, 3, undefined, true, TIERS, BASE, TILE_MIN, budgets)).toBe(0)
    })

    it('returns 0 for an empty tier list', () => {
        expect(ceilingFor(375, 812, 3, undefined, false, [], BASE, TILE_MIN, BUDGETS)).toBe(0)
    })

    it('costs more at a higher pixel ratio', () => {
        expect(ceiling([375, 812, 4], undefined, true)).toBeLessThanOrEqual(ceiling(PHONE, undefined, true))
    })

    it('does not give a bigger touch screen less scene than a smaller one', () => {
        // No navigator.deviceMemory on either, as on iOS. iPad 10.9 (820x1180, dpr 2) against iPhone 15
        // (390x844, dpr 3): a fixed touch ceiling used to leave the iPad on the still scene while the smaller
        // iPhone reached the depth tier. Both viewports are comfortably past the floor, so the area-scaled
        // allowance governs on both sides here, which is the regime the fixed ceiling used to get backwards.
        //
        // (An iPhone SE, at 375x667 dpr 2, is not used for the small side of this comparison: its viewport is
        // small enough that the floor rather than the area term governs its allowance, and the per-layer tile
        // minimums dominate its tiny area cost, so it genuinely affords more of the scene than larger phones do.
        // That is a separate, accepted quirk of the floor, not the inversion this test guards against.)
        const ipad = ceiling([820, 1180, 2], undefined, true)
        const iphone15 = ceiling([390, 844, 3], undefined, true)
        expect(ipad).toBeGreaterThanOrEqual(iphone15)
    })

    it('does not give a bigger touch screen less scene than a smaller one, at synthetic sizes', () => {
        // The iPad-versus-iPhone-15 case above happens to land both devices on the same tier today, so on
        // its own it would quietly stop exercising the ordering the moment the constants are retuned. These
        // two viewports are synthetic and deliberately chosen, not real devices, specifically so the pairing
        // keeps testing the ordering when real device numbers move: both are well clear of the floor crossover
        // (viewportBytes x touchViewports > touchFloor, so touchFloor === Math.max(...) never activates for
        // either side), and the larger is exactly 4x the area of the smaller at the same dpr.
        //
        // With today's constants both land on every tier, and that is structural rather than coincidental.
        // Once the area term dominates, cost and allowance both scale linearly with area, so which tier is
        // reached converges to whichever cumulative overdraw ratio first exceeds touchViewports (30),
        // independent of viewport size, and the full scene's 21.9 never does. So no pair of viewports in this
        // regime can currently demonstrate a strict difference; this assertion documents that the ordering holds
        // (not fewer), while this comment documents why it cannot yet be strict.
        const small = ceiling([900, 700, 3], undefined, true)
        const large = ceiling([1800, 1400, 3], undefined, true)
        expect(large).toBeGreaterThanOrEqual(small)
    })
})
