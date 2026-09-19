// What each part of the hero scene costs the compositor, and how much of it a given device can afford. Shared by
// the inline head script (see script.ts, which inlines ceilingFor below) and the client driver (see climb.ts).

export interface Tier {
    token: string
    overdraw: number // viewports of composited area the tier adds
    layers: number   // composited layers the tier adds
}

// The tiers, in the order they go in. Cost is measured with scripts/scene-cost.js; see the design doc in
// docs/superpowers/specs for the full table and how these were derived. Overdraw in viewports turns out to be very
// nearly viewport independent (10.00 vs 9.88 for the parallax at 375x812 and 1024x768), which is what lets the head
// script work them out before layout has happened.
export const TIERS: Tier[] = [
    { token: 'depth',  overdraw: 7.0,  layers: 7 },   // the ten layer parallax, in place of the lite three
    { token: 'sky',    overdraw: 10.0, layers: 26 },  // star twinkle, drift, shooting stars, cloud drift
    { token: 'water',  overdraw: 0.9,  layers: 21 },  // ripples, streaks, fog, boat bob, lantern flicker
    { token: 'forest', overdraw: 0.2,  layers: 162 }, // tree sway, gusts, wind streaks, leaves, fireflies
]

// The still scene every device gets, which is not free either
export const BASE = { overdraw: 3.8, layers: 35 }

// A composited layer costs at least one backing tile however small it is: 256x256 device pixels at 4 bytes. This is
// why the forest is its own tier: it is 162 layers for almost no area, so counting area alone would call it free.
export const TILE_MIN = 256 * 256 * 4

export const BUDGETS = {
    // Both branches have the same shape, the larger of a floor and an allowance that grows with the screen, for the
    // same reason. The scene's cost grows with viewport area times dpr^2, while the one capability signal that could
    // scale a fixed budget to match is exactly the one Safari withholds: it reports no navigator.deviceMemory on iOS
    // or on macOS. So a fixed byte ceiling hands every screen the same budget while the cost climbs, and a bigger
    // screen means a more capable machine far more often than it means a weaker one. That gets the ordering
    // backwards at both ends: on the touch side a fixed ceiling left an iPad Pro on the still scene and gave an
    // iPhone SE the lot, and on the pointer side it left a 5K display in Safari with the parallax and nothing else
    // while a laptop half its size got the whole scene.
    touchFloor: 150 * 1024 * 1024, // the floor for a phone or tablet
    touchViewports: 30,            // the area-scaled allowance, in viewports of composited raster: the whole scene is 21.9
    pointer: 1024 * 1024 * 1024,   // the floor for a mouse or trackpad
    pointerViewports: 26,          // cumulative full-scene overdraw is 21.9, so this leaves real headroom
    memDivisor: 4,                 // navigator.deviceMemory is scaled against this, so 4GB is the neutral middle
    memMin: 0.5,
    memMax: 1.5,
}

export type Budgets = typeof BUDGETS

// How many tiers this device can afford, 0 (the still scene) through tiers.length.
//
// IMPORTANT: this function must reference nothing outside its own parameters, apart from standard globals like
// Math. script.ts inlines it with toString() so there is only ever one copy of this arithmetic, and a reference to
// anything at module scope would break the moment the build minifies it.
export function ceilingFor(
    vw: number,
    vh: number,
    dpr: number,
    deviceMemory: number | undefined,
    coarsePointer: boolean,
    tiers: Tier[],
    base: { overdraw: number, layers: number },
    tileMin: number,
    budgets: Budgets,
): number {
    const viewportBytes = vw * vh * dpr * dpr * 4
    const factor = deviceMemory
        ? Math.min(budgets.memMax, Math.max(budgets.memMin, deviceMemory / budgets.memDivisor))
        : 1
    const allowance = coarsePointer
        ? Math.max(budgets.touchFloor, viewportBytes * budgets.touchViewports)
        : Math.max(budgets.pointer, viewportBytes * budgets.pointerViewports)
    const budget = allowance * factor

    let spent = base.overdraw * viewportBytes + base.layers * tileMin
    let reached = 0
    for (let i = 0; i < tiers.length; i++) {
        const next = spent + tiers[i].overdraw * viewportBytes + tiers[i].layers * tileMin
        if (next > budget) break
        spent = next
        reached++
    }
    return reached
}
