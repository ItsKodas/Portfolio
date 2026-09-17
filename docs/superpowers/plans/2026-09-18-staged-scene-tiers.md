# Staged Scene Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop mobile browsers killing the home page tab by replacing the binary full/lite scene switch with four cumulative tiers, budgeted before first paint and climbed after the loading curtain lifts.

**Architecture:** An inline head script computes a compositor cost budget from the viewport, device pixel ratio and `navigator.deviceMemory`, and writes cumulative tokens onto `<html data-scene="...">` before the body is parsed. Scene stylesheets key their animations off those tokens. The server renders the tier 0 scene for everyone, so the pre-hydration window is cheap by construction. A client driver climbs the remaining tiers after the curtain lifts, with frame timing able to stop the climb or step back down.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript, CSS modules, `@react-spring/web`. Vitest is added by this plan as the project's first test runner.

**Spec:** `docs/superpowers/specs/2026-09-18-staged-scene-tiers-design.md`

## Global Constraints

- **No em dashes (U+2014 or `&mdash;`) anywhere**: page copy, UI text, README and other docs, commit messages, PR descriptions. Use a comma, colon, full stop or parentheses. Code comments are the one exception. This is from `CLAUDE.md` and applies to every file this plan touches.
- The inline head script in `app/perf/script.ts` is a template literal of **plain, old fashioned JavaScript**. No `const`, `let`, arrow functions, optional chaining or template literals inside the script body. It runs before anything else and must never throw uncaught.
- `ceilingFor` in `app/perf/tiers.ts` **must reference nothing outside its own parameters** apart from standard globals such as `Math`. It is inlined into the head script via `toString()`, and a free variable would break once minified.
- Tier tokens are always applied cumulatively and in `TIERS` order: `depth`, `sky`, `water`, `forest`.
- Indentation in this codebase is 4 spaces. Files use no semicolon terminators in `.ts`/`.tsx`. Match the surrounding style.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/perf/tiers.ts` (create) | The tier table, cost constants, budget constants, and the pure `ceilingFor` function. The single source of truth. |
| `app/perf/tiers.test.ts` (create) | Unit tests for `ceilingFor`. |
| `app/perf/script.ts` (modify) | The inline head script. Detects, budgets, writes `data-scene` and `data-scene-max`. |
| `app/perf/script.test.ts` (create) | Unit tests that evaluate the generated script against stubbed globals. |
| `app/perf/usePerf.ts` (modify) | The client store over `data-scene`. Exports `useScene`, `currentTier`, `sceneMax`, `setTier`, `setPerf`. |
| `app/perf/climb.ts` (create) | The client driver: climbs tiers after reveal, and watches frames to step back down. |
| `app/(landing)/parallax/index.tsx` (modify) | Reads `useScene('depth')`, starts the driver on reveal. |
| `app/(landing)/logo/index.tsx` (modify) | Reads `useScene('depth')` in place of `useLite()`. |
| `app/wallpaper/page.tsx` (modify) | Unchanged call, `setPerf` keeps its signature. Verified only. |
| 8 scene CSS modules (modify) | `html[data-perf="lite"]` rules become `html:not([data-scene~="<token>"])` rules. |
| `scripts/scene-cost.js` (create) | Browser console snippet for re-deriving the cost constants. |
| `package.json`, `vitest.config.ts` (modify/create) | Test runner wiring. |

---

### Task 1: The tier model and budget

**Files:**
- Create: `app/perf/tiers.ts`
- Create: `app/perf/tiers.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Tier { token: string, overdraw: number, layers: number }`; `TIERS: Tier[]`; `BASE: { overdraw: number, layers: number }`; `TILE_MIN: number`; `BUDGETS` and `type Budgets`; `ceilingFor(vw: number, vh: number, dpr: number, deviceMemory: number | undefined, coarsePointer: boolean, tiers: Tier[], base: { overdraw: number, layers: number }, tileMin: number, budgets: Budgets): number`.

- [ ] **Step 1: Add vitest**

```bash
npm install --save-dev vitest@^2
```

Then add to the `scripts` block of `package.json`, after `"lint"`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 2: Add the vitest config**

Create `vitest.config.ts`. The `@/` alias matches `tsconfig.json`'s `paths`, and the include pattern keeps vitest out of `node_modules` and `.next`.

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: { alias: { '@': resolve(__dirname, '.') } },
    test: {
        environment: 'node',
        include: ['app/**/*.test.ts'],
    },
})
```

- [ ] **Step 3: Write the failing tests**

Create `app/perf/tiers.test.ts`. Every expectation below is taken from the budget table in the spec.

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, every case erroring because `./tiers` cannot be resolved.

- [ ] **Step 5: Write the implementation**

Create `app/perf/tiers.ts`.

```ts
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
    { token: 'forest', overdraw: 0.2,  layers: 162 }, // tree sway, gusts, wind streaks, leaves, fireflies, campfire
]

// The still scene every device gets, which is not free either
export const BASE = { overdraw: 3.8, layers: 35 }

// A composited layer costs at least one backing tile however small it is: 256x256 device pixels at 4 bytes. This is
// why the forest is its own tier: it is 162 layers for almost no area, so counting area alone would call it free.
export const TILE_MIN = 256 * 256 * 4

export const BUDGETS = {
    touch: 160 * 1024 * 1024,    // a phone or tablet, where the renderer gets killed well before a desktop's would
    pointer: 1024 * 1024 * 1024, // a mouse or trackpad, which in practice means enough memory for the whole scene
    memDivisor: 4,               // navigator.deviceMemory is scaled against this, so 4GB is the neutral middle
    memMin: 0.5,
    memMax: 1.75,
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
    var viewportBytes = vw * vh * dpr * dpr * 4
    var factor = deviceMemory
        ? Math.min(budgets.memMax, Math.max(budgets.memMin, deviceMemory / budgets.memDivisor))
        : 1
    var budget = (coarsePointer ? budgets.touch : budgets.pointer) * factor

    var spent = base.overdraw * viewportBytes + base.layers * tileMin
    var reached = 0
    for (var i = 0; i < tiers.length; i++) {
        var next = spent + tiers[i].overdraw * viewportBytes + tiers[i].layers * tileMin
        if (next > budget) break
        spent = next
        reached++
    }
    return reached
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts app/perf/tiers.ts app/perf/tiers.test.ts
git commit -m "Work out what the hero scene costs a device, and what it can afford"
```

---

### Task 2: The head script writes scene tokens

**Files:**
- Modify: `app/perf/script.ts` (whole file)
- Create: `app/perf/script.test.ts`

**Interfaces:**
- Consumes: `TIERS`, `BASE`, `TILE_MIN`, `BUDGETS`, `ceilingFor` from `./tiers`.
- Produces: `PERF_SCRIPT: string`, unchanged in name and already imported by `app/layout.tsx:4`. After it runs, `<html>` carries `data-scene` (space separated tokens, possibly empty), `data-scene-max` (a number as a string), `data-perf` (the temporary bridge, removed in Task 4) and, when a mode was forced, `data-perf-forced`.

This task keeps writing `data-perf` so the eight scene stylesheets keep working untouched. Task 4 migrates them and removes the bridge. Doing it this way means the site is in a working state at every commit.

- [ ] **Step 1: Write the failing tests**

Create `app/perf/script.test.ts`. The helper runs the generated script with stubbed globals shadowing the real ones, which is what lets a Node test drive a browser script.

```ts
import { describe, expect, it } from 'vitest'
import { TIERS } from './tiers'
import { PERF_SCRIPT } from './script'

const ALL = TIERS.map(t => t.token).join(' ')

interface Env {
    search?: string
    stored?: string | null
    storageThrows?: boolean
    innerWidth?: number
    innerHeight?: number
    dpr?: number
    deviceMemory?: number
    coarse?: boolean
    renderer?: string | null // null means no WebGL context at all
    noMatchMedia?: boolean
}

function run(env: Env = {}): Record<string, string> {
    const attrs: Record<string, string> = {}
    const root = {
        setAttribute: (k: string, v: string) => { attrs[k] = v },
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        hasAttribute: (k: string) => k in attrs,
    }

    const gl = env.renderer === null ? null : {
        getExtension: (name: string) =>
            name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : null,
        getParameter: () => env.renderer ?? 'Apple GPU',
    }

    const store: Record<string, string> = {}
    if (env.stored != null) store.perf = env.stored
    const boom = () => { throw new Error('storage disabled') }

    const document = {
        documentElement: root,
        createElement: () => ({ getContext: () => gl }),
    }
    const window = {
        innerWidth: env.innerWidth ?? 375,
        innerHeight: env.innerHeight ?? 812,
        devicePixelRatio: env.dpr ?? 3,
        matchMedia: env.noMatchMedia
            ? undefined
            : (q: string) => ({ matches: q.indexOf('coarse') !== -1 ? !!env.coarse : false }),
    }
    const location = { search: env.search ?? '' }
    const localStorage = env.storageThrows ? { getItem: boom, setItem: boom, removeItem: boom } : {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v },
        removeItem: (k: string) => { delete store[k] },
    }
    const navigator = { deviceMemory: env.deviceMemory }

    new Function('window', 'document', 'location', 'localStorage', 'navigator', PERF_SCRIPT)(
        window, document, location, localStorage, navigator,
    )
    return attrs
}

describe('PERF_SCRIPT', () => {
    it('starts a phone on the still scene with room for one tier', () => {
        const attrs = run({ coarse: true })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe('1')
        expect(attrs['data-perf-forced']).toBeUndefined()
    })

    it('hands a desktop every tier up front so it never climbs', () => {
        const attrs = run({ innerWidth: 1920, innerHeight: 1080, dpr: 2, coarse: false })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-scene-max']).toBe(String(TIERS.length))
    })

    it('holds a software renderer on the still scene despite a fine pointer', () => {
        const attrs = run({ innerWidth: 1920, innerHeight: 1080, dpr: 2, renderer: 'SwiftShader' })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe('0')
    })

    it('holds a browser with no WebGL context at all on the still scene', () => {
        const attrs = run({ innerWidth: 1920, innerHeight: 1080, dpr: 2, renderer: null })
        expect(attrs['data-scene-max']).toBe('0')
    })

    it('honours a remembered full mode', () => {
        const attrs = run({ coarse: true, stored: 'full' })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-perf-forced']).toBe('')
    })

    it('honours a remembered lite mode', () => {
        const attrs = run({ innerWidth: 1920, innerHeight: 1080, coarse: false, stored: 'lite' })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-perf-forced']).toBe('')
    })

    it('forces an exact token set from ?scene=', () => {
        const attrs = run({ search: '?scene=depth+sky', coarse: true })
        expect(attrs['data-scene']).toBe('depth sky')
        expect(attrs['data-perf-forced']).toBe('')
    })

    it('still detects when localStorage throws', () => {
        const attrs = run({ coarse: true, storageThrows: true })
        expect(attrs['data-scene-max']).toBe('1')
    })

    it('falls back to the still scene when detection throws', () => {
        const attrs = run({ noMatchMedia: true })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe('0')
    })

    it('keeps the data-perf bridge in step with the tokens', () => {
        expect(run({ innerWidth: 1920, innerHeight: 1080, dpr: 2 })['data-perf']).toBe('full')
        expect(run({ coarse: true })['data-perf']).toBe('lite')
    })

    it('inlines the real ceilingFor rather than a second copy of the arithmetic', () => {
        expect(PERF_SCRIPT).toContain('budgets.memDivisor')
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- script`
Expected: FAIL, because the script still writes only `data-perf`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `app/perf/script.ts`.

```ts
import { BASE, BUDGETS, TIERS, TILE_MIN, ceilingFor } from './tiers'

// Decides, before the page first paints, how much of the hero scene this browser is given, and marks it on the root
// as data-scene="<tokens>" (cumulative, in TIERS order) plus data-scene-max, the most it could afford. The
// stylesheets switch their animations on from the tokens, and the parallax reads them when it mounts. Runs as an
// inline script in the head, so it's plain, old-fashioned JavaScript.
//
// A device that can afford the whole scene is handed it outright and never climbs. Anything short of that starts on
// the still scene and climbs after the loading curtain lifts (see climb.ts), which is the point: the phone never has
// to composite more than it can hold, and the old fallback could not switch for another 7 to 12 seconds, by which
// time the tab was already dead.
//
// Lite is also forced when the browser is drawing without the graphics card (hardware acceleration turned off, or a
// blocked driver): WebGL then either refuses a context flagged failIfMajorPerformanceCaveat, or reports a software
// renderer. Such a machine reports a fine pointer, so without this check it would be handed the whole scene and,
// because it starts at its ceiling, would never be frame checked either.
//
// For testing, ?perf=lite or ?perf=full forces a mode and remembers it in this browser; ?perf=auto goes back to
// detecting; ?scene=depth+sky forces an exact set of tokens for this load only.

const ALL_TOKENS = TIERS.map(t => t.token).join(' ')

export const PERF_SCRIPT = `(function () {
    var root = document.documentElement, forced = null
    var all = ${JSON.stringify(ALL_TOKENS)}, count = ${TIERS.length}

    function apply(scene, max, isForced) {
        root.setAttribute('data-scene', scene)
        root.setAttribute('data-scene-max', String(max))
        // (bridge for the stylesheets until they've moved over to data-scene)
        root.setAttribute('data-perf', scene === all ? 'full' : 'lite')
        if (isForced) root.setAttribute('data-perf-forced', '')
    }

    try {
        var params = new URLSearchParams(location.search)
        var scene = params.get('scene')
        if (scene !== null) {
            apply(scene.trim(), count, true)
            return
        }
        var asked = params.get('perf')
        if (asked === 'lite' || asked === 'full') localStorage.setItem('perf', asked)
        else if (asked === 'auto') localStorage.removeItem('perf')
        forced = localStorage.getItem('perf')
    } catch (e) {}

    if (forced === 'lite' || forced === 'full') {
        apply(forced === 'full' ? all : '', forced === 'full' ? count : 0, true)
        return
    }

    var ceiling = 0
    try {
        // Drawing without the graphics card? Then nothing beyond the still scene is affordable, whatever the
        // memory says.
        var software = false
        var canvas = document.createElement('canvas')
        var gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true })
        if (!gl) software = true
        else {
            var info = gl.getExtension('WEBGL_debug_renderer_info')
            var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
            if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) software = true
            var lose = gl.getExtension('WEBGL_lose_context')
            if (lose) lose.loseContext()
        }

        if (!software) {
            var ceilingFor = ${ceilingFor.toString()}
            ceiling = ceilingFor(
                window.innerWidth,
                window.innerHeight,
                window.devicePixelRatio || 1,
                navigator.deviceMemory,
                window.matchMedia('(pointer: coarse)').matches,
                ${JSON.stringify(TIERS)},
                ${JSON.stringify(BASE)},
                ${TILE_MIN},
                ${JSON.stringify(BUDGETS)}
            )
        }
    } catch (e) {
        // The still scene is the safe answer, and the only one that definitely doesn't get the tab killed
        ceiling = 0
    }

    apply(ceiling === count ? all : '', ceiling, false)
})()`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 22 tests across both files.

- [ ] **Step 5: Verify the inlined function survives a production build**

This guards the one genuinely fragile thing in the design, which is that `ceilingFor.toString()` gets minified into the page intact.

Grepping the build output is not enough, because `tiers.ts` itself is in the server bundle and would match whether or not `toString()` worked. The check has to be against the **served HTML**:

```bash
npm run build
npm start &
sleep 5
curl -s http://localhost:3000/ | grep -o "memDivisor" | wc -l
```
Expected: 1 or more. That string can only reach the HTML through the inlined function body, so a non-zero count proves the arithmetic really was serialised into the page rather than tree-shaken or mangled.

Then confirm the inlined script actually runs, rather than merely being present:

```bash
curl -s http://localhost:3000/ | grep -o 'data-scene-max' | wc -l
```
Expected: 1 or more (the attribute name appears in the script source). Then load the built site in a browser and check `document.documentElement.dataset.sceneMax` is a number.

Remember to `kill %1` afterwards.

If `memDivisor` does not appear, stop and report it: the `toString()` approach has failed and the arithmetic has to be written out longhand in the template string instead, with a comment pointing at `tiers.ts` as the copy to keep it in step with.

- [ ] **Step 6: Commit**

```bash
git add app/perf/script.ts app/perf/script.test.ts
git commit -m "Give the head script a budget, and have it write scene tokens"
```

---

### Task 3: The client store over data-scene

**Files:**
- Modify: `app/perf/usePerf.ts` (whole file)
- Modify: `app/(landing)/logo/index.tsx:9` and `:53`
- Modify: `app/(landing)/parallax/index.tsx:10` and `:190`

**Interfaces:**
- Consumes: `TIERS` from `./tiers`; the `data-scene` and `data-scene-max` attributes from Task 2.
- Produces: `useScene(token: string): boolean`; `currentTier(): number`; `sceneMax(): number`; `setTier(n: number): void`; `setPerf(mode: 'full' | 'lite'): void`. `useLite` and `watchFrameRate` are removed. `watchFrameRate`'s replacement arrives in Task 5; until then `ParallaxView` simply does not run one.

- [ ] **Step 1: Replace the store**

Replace the whole of `app/perf/usePerf.ts`.

```ts
import { useSyncExternalStore } from 'react'

import { TIERS } from './tiers'

// How much of the hero scene is showing, as the cumulative tokens the head script put on the root (see script.ts),
// for components to follow. The server always renders the still scene, and the browser climbs from there once it
// knows what it can hold (see climb.ts).

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

const tokens = () => (document.documentElement.getAttribute('data-scene') || '').split(/\s+/).filter(Boolean)

// Whether a part of the scene is in yet, for example useScene('depth')
export function useScene(token: string) {
    return useSyncExternalStore(subscribe, () => tokens().indexOf(token) !== -1, () => false)
}

// How many tiers are in, and the most this browser was judged able to hold
export const currentTier = () => tokens().length
export const sceneMax = () => Number(document.documentElement.getAttribute('data-scene-max') || 0)

// Puts the first n tiers in, in TIERS order
export function setTier(n: number) {
    const root = document.documentElement
    const next = TIERS.slice(0, n).map(t => t.token).join(' ')
    if (root.getAttribute('data-scene') === next) return
    root.setAttribute('data-scene', next)
    listeners.forEach(l => l())
}

// Sets the scene outright, as the desktop wallpaper's settings do (and marks it forced, so the climb and the frame
// watch leave it alone)
export function setPerf(mode: 'full' | 'lite') {
    document.documentElement.setAttribute('data-perf-forced', '')
    setTier(mode === 'full' ? TIERS.length : 0)
}
```

- [ ] **Step 2: Update the logo**

In `app/(landing)/logo/index.tsx`, change the import on line 9:

```ts
import { useScene } from '@/app/perf/usePerf'
```

and line 53:

```ts
    const lite = !useScene('depth')
```

- [ ] **Step 3: Update the parallax view**

In `app/(landing)/parallax/index.tsx`, change the import on line 10:

```ts
import { useScene } from '@/app/perf/usePerf'
```

line 190:

```ts
    const lite = !useScene('depth')
```

and delete the frame watch on line 198 along with its comment, leaving `revealed` in place because the curtain and the logo still use it:

```ts
    const revealed = useRevealed()
```

- [ ] **Step 4: Verify it type checks and builds**

Run: `npx tsc --noEmit`
Expected: no errors. In particular no remaining reference to `useLite` or `watchFrameRate`.

Run: `npm test`
Expected: PASS, still 22 tests.

- [ ] **Step 5: Verify the server now renders the still scene**

Run `npm run dev`, then in another shell:

```bash
curl -s http://localhost:3000/ | grep -o "parallax_layer__[A-Za-z0-9_-]*" | wc -l
```
Expected: 3 or 4, the still scene's layers, not 10 or more. Use `grep -o ... | wc -l` rather than `grep -c`, since the HTML is effectively one long line and `grep -c` counts lines, not occurrences.

The point of this check is that the HTML the browser composites before hydration is now the cheap scene for every visitor, which is what closes the crash window.

- [ ] **Step 6: Commit**

```bash
git add app/perf/usePerf.ts "app/(landing)/logo/index.tsx" "app/(landing)/parallax/index.tsx"
git commit -m "Follow the scene tokens, and render the still scene on the server"
```

---

### Task 4: Move the stylesheets onto scene tokens

**Files:**
- Modify: `app/(landing)/stars/stars.module.css:53-54`
- Modify: `app/(landing)/clouds/clouds.module.css:64`
- Modify: `app/(landing)/water/water.module.css:94`
- Modify: `app/(landing)/watchtower/watchtower.module.css:36`
- Modify: `app/(landing)/trees/trees.module.css:90-91`
- Modify: `app/(landing)/fireflies/fireflies.module.css:58`
- Modify: `app/(landing)/night/night.module.css:89-90`
- Modify: `app/(landing)/scroll/scroll.module.css:106-108`
- Modify: `app/perf/script.ts` (remove the bridge)
- Modify: `app/perf/script.test.ts` (drop the bridge test)

**Interfaces:**
- Consumes: the `data-scene` attribute from Task 2.
- Produces: nothing new. After this task `data-perf` is no longer written or read anywhere.

Each rule turns from "off when lite" into "off until this token is in". Note the sense flips: `[data-perf="lite"]` becomes `:not([data-scene~="<token>"])`.

- [ ] **Step 1: Migrate the sky stylesheets**

In `app/(landing)/stars/stars.module.css`, replace lines 52 to 54:

```css
/* Until the sky tier is in (see app/perf) */
:global(html:not([data-scene~="sky"])) .twinkle, :global(html:not([data-scene~="sky"])) .drift { animation: none; }
:global(html:not([data-scene~="sky"])) .shoot { display: none; }
```

In `app/(landing)/clouds/clouds.module.css`, replace lines 63 to 64:

```css
/* Until the sky tier is in (see app/perf) */
:global(html:not([data-scene~="sky"])) .cloud, :global(html:not([data-scene~="sky"])) .cool { animation-play-state: paused; will-change: auto; }
```

- [ ] **Step 2: Migrate the water stylesheets**

In `app/(landing)/water/water.module.css`, replace lines 93 to 94:

```css
/* Until the water tier is in (see app/perf) */
:global(html:not([data-scene~="water"])) .streak, :global(html:not([data-scene~="water"])) .fog, :global(html:not([data-scene~="water"])) .ripple, :global(html:not([data-scene~="water"])) .bob, :global(html:not([data-scene~="water"])) .flicker { animation: none; }
```

In `app/(landing)/watchtower/watchtower.module.css`, replace lines 35 to 36:

```css
/* Until the water tier is in (see app/perf) */
:global(html:not([data-scene~="water"])) .glow, :global(html:not([data-scene~="water"])) .window { animation: none; }
```

- [ ] **Step 3: Migrate the forest stylesheets**

In `app/(landing)/trees/trees.module.css`, replace lines 89 to 91:

```css
/* Until the forest tier is in (see app/perf) */
:global(html:not([data-scene~="forest"])) .sway, :global(html:not([data-scene~="forest"])) .gust, :global(html:not([data-scene~="forest"])) .streak, :global(html:not([data-scene~="forest"])) .leafTravel, :global(html:not([data-scene~="forest"])) .leafFlutter, :global(html:not([data-scene~="forest"])) .leafSpin { animation: none; }
:global(html:not([data-scene~="forest"])) .streak, :global(html:not([data-scene~="forest"])) .leafTravel { opacity: 0; }
```

In `app/(landing)/fireflies/fireflies.module.css`, replace lines 57 to 58:

```css
/* Until the forest tier is in (see app/perf) */
:global(html:not([data-scene~="forest"])) .wander, :global(html:not([data-scene~="forest"])) .glow { animation: none; }
```

In `app/(landing)/night/night.module.css`, replace lines 88 to 90:

```css
/* Until the forest tier is in (see app/perf) */
:global(html:not([data-scene~="forest"])) .twinkle, :global(html:not([data-scene~="forest"])) .glow, :global(html:not([data-scene~="forest"])) .flame, :global(html:not([data-scene~="forest"])) .spark { animation: none; }
:global(html:not([data-scene~="forest"])) .spark { opacity: 0; }
```

- [ ] **Step 4: Migrate the scroll note**

In `app/(landing)/scroll/scroll.module.css`, replace lines 105 to 108:

```css
/* Until the depth tier is in (see app/perf) */
:global(html:not([data-scene~="depth"])) .arrow { animation: none; }
:global(html:not([data-scene~="depth"])) .shaft, :global(html:not([data-scene~="depth"])) .head { animation: none; stroke-dashoffset: 0; }
:global(html:not([data-scene~="depth"])) .glyph { animation: none; stroke-dashoffset: 0; fill-opacity: 1; }
```

- [ ] **Step 5: Confirm no stylesheet still reads data-perf**

Run: `grep -rn 'data-perf' "app/(landing)/"`
Expected: no output.

- [ ] **Step 6: Remove the bridge from the head script**

In `app/perf/script.ts`, delete these two lines from the `apply` function:

```js
        // (bridge for the stylesheets until they've moved over to data-scene)
        root.setAttribute('data-perf', scene === all ? 'full' : 'lite')
```

Then delete the whole `it('keeps the data-perf bridge in step with the tokens', ...)` case from `app/perf/script.test.ts`.

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS, 21 tests.

- [ ] **Step 8: Verify the tiers in the browser**

Run `npm run dev`, then load each of these and confirm by eye:

| URL | expected |
| --- | --- |
| `/?scene=` | still scene, nothing moving, three parallax depths |
| `/?scene=depth` | ten depths and the scroll note animating, sky and water and forest still |
| `/?scene=depth+sky` | stars twinkling and drifting, clouds moving, water and trees still |
| `/?scene=depth+sky+water` | lake ripples, fog, boat bobbing, lantern flickering, trees still |
| `/?scene=depth+sky+water+forest` | the whole scene, matching `Master` |
| `/?perf=auto` | back to detection |

- [ ] **Step 9: Commit**

```bash
git add "app/(landing)" app/perf/script.ts app/perf/script.test.ts
git commit -m "Switch the scene's stylesheets over to the tier tokens"
```

---

### Task 5: The climb driver

**Files:**
- Create: `app/perf/climb.ts`
- Modify: `app/(landing)/parallax/index.tsx` (restore a driver on reveal)

**Interfaces:**
- Consumes: `TIERS` from `./tiers`; `currentTier`, `sceneMax`, `setTier` from `./usePerf`; `useRevealed` from `../(landing)/parallax/curtain`, which `ParallaxView` already imports.
- Produces: `runScene(): () => void`, returning a cleanup, called from an effect in `ParallaxView`.

- [ ] **Step 1: Write the driver**

Create `app/perf/climb.ts`.

```ts
import { TIERS } from './tiers'
import { currentTier, sceneMax, setTier } from './usePerf'

// Puts the rest of the scene in, once the curtain has lifted, on a browser that couldn't be handed all of it up
// front (see script.ts). One tier at a time, timing the frames after each, so a device that turns out to be slower
// than its budget suggested stops where it is instead of pushing on.

// A frame slower than this, at the median, means the browser can't keep up with what's on screen. It's above a 30Hz
// display's 33ms, so a slow screen alone doesn't count.
const SLOW_FRAME_MS = 36
const STEP_MS = 450         // between one tier settling and the next going in
const CLIMB_FRAMES = 20     // timed after each tier, enough to catch one that hurts without holding things up
const SETTLE_MS = 1000      // before the watch below, to leave the load and hydration out of it
const WATCH_FRAMES = 60
const TOP_WAIT_MS = 30000   // how long to wait for a scroll back to the top before giving up on the depth tier

// Times `count` drawn frames and hands back their median. A hidden tab doesn't draw, so it starts over from the next
// frame it does.
function sampleFrames(count: number, done: (median: number) => void) {
    let frame = 0, last = 0
    const deltas: number[] = []

    const tick = (now: number) => {
        if (document.hidden) { last = 0; deltas.length = 0; frame = requestAnimationFrame(tick); return }
        if (last) deltas.push(now - last)
        last = now
        if (deltas.length < count) { frame = requestAnimationFrame(tick); return }
        deltas.sort((a, b) => a - b)
        done(deltas[deltas.length >> 1])
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
}

export function runScene() {
    if (document.documentElement.hasAttribute('data-perf-forced')) return () => {}

    let stopped = false
    let cancelSample = () => {}
    let timer = 0
    let giveUp = 0
    let onScroll: (() => void) | null = null

    const clearWait = () => {
        if (!onScroll) return
        window.removeEventListener('scroll', onScroll)
        onScroll = null
        clearTimeout(giveUp)
    }

    const stop = () => {
        stopped = true
        cancelSample()
        clearTimeout(timer)
        clearWait()
    }

    // The depth tier swaps the still scene's three layers for the full ten, which sit at different parallax offsets.
    // At the very top of the page every layer is at offset zero and the two look identical, so that's the only place
    // the swap can happen without the scene visibly jumping.
    const whenAtTop = (go: () => void) => {
        if (window.scrollY === 0) return go()
        giveUp = window.setTimeout(() => { clearWait(); watch() }, TOP_WAIT_MS)
        onScroll = () => {
            if (window.scrollY !== 0) return
            clearWait()
            go()
        }
        window.addEventListener('scroll', onScroll, { passive: true })
    }

    const climb = () => {
        if (stopped) return
        const at = currentTier()
        if (at >= sceneMax() || at >= TIERS.length) return watch()

        const step = () => {
            if (stopped) return
            setTier(at + 1)
            cancelSample = sampleFrames(CLIMB_FRAMES, median => {
                if (stopped) return
                // Slower than the budget promised: put the tier back and stop climbing, but keep watching
                if (median > SLOW_FRAME_MS) { setTier(at); return watch() }
                timer = window.setTimeout(climb, STEP_MS)
            })
        }

        if (TIERS[at].token === 'depth') whenAtTop(step)
        else step()
    }

    // Once nothing more is going in, keep an eye on the frames and step back down if the browser can't keep up. A
    // device that was handed the whole scene up front never climbs, so this is the only check it ever gets.
    const watch = () => {
        if (stopped) return
        timer = window.setTimeout(() => {
            cancelSample = sampleFrames(WATCH_FRAMES, median => {
                if (stopped || median <= SLOW_FRAME_MS) return
                const at = currentTier()
                if (at === 0) return
                setTier(at - 1)
                watch()
            })
        }, SETTLE_MS)
    }

    climb()
    return stop
}
```

- [ ] **Step 2: Start the driver on reveal**

In `app/(landing)/parallax/index.tsx`, add to the imports beside the `useScene` import from Task 3:

```ts
import { runScene } from '@/app/perf/climb'
```

and restore the effect that Task 3 removed, just below `const revealed = useRevealed()`:

```ts
    // Put the rest of the scene in once it's showing, so loading doesn't count against the frame timing
    useEffect(() => { if (revealed) return runScene() }, [revealed])
```

- [ ] **Step 3: Verify it type checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify the climb in the browser**

There is no browser test harness in this project, so this step is done by hand and its output recorded in the commit. Run `npm run dev` and open the site with devtools.

To watch a constrained device climb, force a low ceiling by hand in the console before the curtain lifts is not practical, so instead confirm the two ends and the mechanism:

1. Load `/?perf=auto` on desktop. In the console run:
   ```js
   document.documentElement.dataset.scene
   ```
   Expected: `"depth sky water forest"` immediately, and it never changes. A desktop is handed everything and does not climb.

2. Load `/?perf=auto`, and before the curtain lifts run:
   ```js
   document.documentElement.setAttribute('data-scene', '')
   document.documentElement.setAttribute('data-scene-max', '4')
   ```
   Then watch:
   ```js
   setInterval(() => console.log(performance.now().toFixed(0), document.documentElement.dataset.scene), 250)
   ```
   Expected: the tokens arrive one at a time, roughly 450 ms apart, ending at all four. The scene should not visibly jump when `depth` arrives, because the page is at the top.

3. Repeat 2 but scroll down first, before the tokens start. Expected: `depth` does not arrive while scrolled, and does arrive on scrolling back to the top.

- [ ] **Step 5: Commit**

```bash
git add app/perf/climb.ts "app/(landing)/parallax/index.tsx"
git commit -m "Put the rest of the scene in a tier at a time, and step back if the frames suffer"
```

---

### Task 6: Fade the leaves in

**Files:**
- Modify: `app/(landing)/trees/trees.module.css`

**Interfaces:**
- Consumes: the `forest` token from Task 4.
- Produces: nothing.

`.leafTravel`'s keyframes hold `opacity: 1` from 8% to 85% of the cycle, and every leaf carries a negative
`animation-delay`, so about three quarters of the twelve leaves would appear mid flight the instant the `forest`
token lands. The fade goes on the inner `.leafSpin` element rather than on `.leafTravel` itself, because a
`transition` and an `animation` cannot both drive opacity on one element, while opacity across nested elements
multiplies.

- [ ] **Step 1: Add the fade**

In `app/(landing)/trees/trees.module.css`, extend the existing `.leafSpin` rule:

```css
.leafSpin {
    animation: leafSpin linear infinite;
    /* Faded in when the forest tier arrives, since leafTravel is mid-flight by then and would otherwise pop
       (the fade is here rather than on leafTravel because a transition and an animation can't share a property) */
    transition: opacity 600ms ease;
}
```

and add, beside the other `data-scene` rules at the bottom of the file:

```css
:global(html:not([data-scene~="forest"])) .leafSpin { opacity: 0; }
```

- [ ] **Step 2: Verify the fade in the browser**

Run `npm run dev` and load `/?scene=depth+sky+water`. In the console run:

```js
document.documentElement.setAttribute('data-scene', 'depth sky water forest')
```

Expected: the leaves fade in over about 600 ms rather than appearing at once. Compare against removing the
`.leafSpin` opacity rule in devtools to see the pop it prevents.

- [ ] **Step 3: Commit**

```bash
git add "app/(landing)/trees/trees.module.css"
git commit -m "Fade the leaves in, so they don't appear mid-flight when the forest arrives"
```

---

### Task 7: The cost measuring snippet

**Files:**
- Create: `scripts/scene-cost.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. It exists so the constants in `app/perf/tiers.ts` can be re-derived when the scene changes.

- [ ] **Step 1: Write the snippet**

Create `scripts/scene-cost.js`.

```js
// What the hero scene costs the compositor, per part. Paste into the browser console on the home page, at the top
// of the page, with the viewport set to whatever device you're measuring for.
//
// It prints overdraw in viewports and a count of composited layers, which are the two numbers TIERS in
// app/perf/tiers.ts is built from. Overdraw is very nearly viewport independent, so a figure measured at one size
// holds at another; the layer count matters on its own because every layer costs at least one backing tile however
// small it is.
//
// Load with ?scene=depth+sky+water+forest to measure the whole scene, or with a shorter token list to measure what a
// given tier adds. The difference between two runs is a tier's cost.

;(() => {
    const vw = innerWidth, vh = innerHeight
    const parts = {}

    for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el)
        // Anything the browser has to give its own layer: a running transform/opacity animation, or an explicit hint
        if (style.animationName === 'none' && style.willChange === 'auto') continue

        const box = el.getBoundingClientRect()
        if (!box.width || !box.height) continue

        // Which css module named this element. art_ and parallax_ are shared wrappers, so fall through to the
        // scene module on the element itself, or failing that on the nearest labelled ancestor.
        const named = node => {
            const cls = (node.className.baseVal ?? node.className ?? '').toString()
            return [...cls.matchAll(/([a-z]+)_[A-Za-z]+__/g)].map(m => m[1])
        }
        const own = named(el)
        let key = own.find(m => m !== 'art' && m !== 'parallax') || own[0] || 'other'
        if (key === 'art') {
            for (let p = el.parentElement; p && key === 'art'; p = p.parentElement) {
                key = named(p).find(m => m !== 'art' && m !== 'parallax') || 'art'
            }
        }

        const w = Math.max(0, Math.min(box.right, vw) - Math.max(box.left, 0))
        const h = Math.max(0, Math.min(box.bottom, vh) - Math.max(box.top, 0))
        const part = parts[key] || (parts[key] = { layers: 0, px: 0 })
        part.layers++
        if (w > 0 && h > 0) part.px += w * h
    }

    const rows = Object.entries(parts)
        .map(([part, p]) => ({ part, layers: p.layers, overdraw: +(p.px / (vw * vh)).toFixed(2) }))
        .sort((a, b) => b.overdraw - a.overdraw)

    console.log(`${vw}x${vh} at dpr ${devicePixelRatio}, scene "${document.documentElement.dataset.scene}"`)
    console.table(rows)
    console.log('totals', {
        layers: rows.reduce((s, r) => s + r.layers, 0),
        overdraw: +rows.reduce((s, r) => s + r.overdraw, 0).toFixed(2),
    })
})()
```

- [ ] **Step 2: Note it in the README**

Add to `README.md`, in whatever section covers working on the site (create a short "Measuring the scene" section at the end if there is no obvious home):

```markdown
## Measuring the scene

The hero is served in tiers, and how far a browser climbs depends on cost constants in `app/perf/tiers.ts`. If you
add or remove moving parts, re-derive them: paste `scripts/scene-cost.js` into the browser console on the home page
and compare runs at different `?scene=` token sets. The difference between two runs is what that tier costs.
```

- [ ] **Step 3: Verify the snippet reproduces the design's numbers**

Run `npm run dev`, set the browser to a 375x812 viewport, load `/?scene=depth+sky+water+forest`, and paste the
snippet.

Expected, within a little: `parallax` about 10 viewports over 10 layers, `stars` about 8.4 over 16, `clouds` about
1.6 over 10, `water` about 0.9 over 21, `trees` 73 layers, `night` 43 layers, `fireflies` 46 layers. If these have
drifted far from the table in the design doc, the constants in `tiers.ts` need updating and the budget table in the
spec needs revisiting.

- [ ] **Step 4: Commit**

```bash
git add scripts/scene-cost.js README.md
git commit -m "Add a snippet for re-deriving what the scene costs"
```

---

### Task 8: Verification

**Files:** none changed. This task produces evidence, not code.

**Interfaces:**
- Consumes: everything above.
- Produces: a recorded result for each check below.

- [ ] **Step 1: Full check suite**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```
Expected: all four clean. Record the actual output; do not claim a pass without it.

- [ ] **Step 2: Desktop regression against Master**

Load the branch and `Master` side by side on desktop at the same window size. Confirm:
- `document.documentElement.dataset.scene` is `"depth sky water forest"` on the branch, set immediately.
- The scene is visually unchanged: same ten depths, same star, cloud, water and forest motion, same logo intro.
- `document.documentElement.dataset.scene` never changes during the visit, that is the driver does not climb.

- [ ] **Step 3: Wallpaper regression**

Load `/wallpaper` and toggle the "still" setting. Confirm the scene stops and starts as it did before, and that
`data-perf-forced` is present so the climb never runs there.

- [ ] **Step 4: Confirm the crash is fixed on a real phone**

This is the step the whole plan exists for, and it cannot be done from a development machine: the failure is an iOS
or Android renderer kill, which an emulated viewport does not reproduce.

Deploy the branch somewhere the phone can reach it, then on the phone:
1. Load the site. Expected: it loads and stays loaded, no reload and no "cannot open this page".
2. Run `?perf=full`. Expected: **it still crashes.** This is the control. If it does not crash, something else
   changed the outcome and the fix is not proven.
3. Back on `?perf=auto`, check which tier it settled at. In desktop Safari's remote inspector, or by adding a
   temporary on-page readout, report `data-scene` and `data-scene-max`.
4. Scroll the whole page. Expected: no crash, and no visible jump as the scene settles.

- [ ] **Step 5: Record the result**

If step 4 shows the phone settling somewhere unexpected, or still struggling, the budget constants in
`app/perf/tiers.ts` need tuning rather than the design changing. Report the observed `data-scene-max` and the device
so the numbers can be adjusted against real hardware.

---

## Self-Review

**Spec coverage:** every section of the design maps to a task. Tier scale and cost model to Task 1; the head script,
the software renderer check and the `?perf=` / `?scene=` overrides to Task 2; the store, the server snapshot
inversion and the `useLite` removal to Task 3; the stylesheet migration and the dropped `data-perf` bridge to Task 4;
the climb driver, the `scrollY === 0` rule for `depth` and the demotion watch to Task 5; the leaf fade to Task 6; the
cost snippet to Task 7; the testing and manual verification sections to Task 8. The spec's "Future work" on
regrouping the stars spatially is deliberately not planned.

**Type consistency:** `ceilingFor`'s nine parameters are identical in `tiers.ts`, its tests and the head script's
inlined call. `setTier`, `currentTier` and `sceneMax` are named the same in `usePerf.ts`, `climb.ts` and the tests.
`runScene` is the only export of `climb.ts` and the only thing `ParallaxView` imports from it. Token strings
(`depth`, `sky`, `water`, `forest`) appear in `TIERS`, the eight stylesheets and the browser checks, and match
throughout.
