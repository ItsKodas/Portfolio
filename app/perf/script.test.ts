import { describe, expect, it } from 'vitest'
import { TIERS } from './tiers'
import { PERF_SCRIPT } from './script'

const ALL = TIERS.map(t => t.token).join(' ')

interface Env {
    search?: string
    stored?: string | null
    storage?: Record<string, string>   // seeded, and mutated in place, so a test can read back what was remembered
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

    const store: Record<string, string> = env.storage ?? {}
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
    it('starts a phone on the still scene, climbing to everything but the water', () => {
        const attrs = run({ coarse: true })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
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

    it('forces an exact token set from ?scene=, with a ceiling that matches it', () => {
        const attrs = run({ search: '?scene=depth+sky', coarse: true })
        expect(attrs['data-scene']).toBe('depth sky')
        expect(attrs['data-scene-max']).toBe('2')   // what was forced, not the whole scale
        expect(attrs['data-perf-forced']).toBe('')
    })

    it('gives ?scene= with no tokens a ceiling of zero', () => {
        const attrs = run({ search: '?scene=', coarse: true })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe('0')
    })

    it('still detects when localStorage throws', () => {
        const attrs = run({ coarse: true, storageThrows: true })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
    })

    it('honours ?perf= on the load where storage throws, not just on the next one', () => {
        // The override and the attempt to remember it used to share one try, so a browser blocking storage lost
        // both: setItem threw, the catch swallowed it, and the load carried on detecting as if nothing was asked.
        const attrs = run({ search: '?perf=full', coarse: true, storageThrows: true })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-scene-max']).toBe(String(TIERS.length))
        expect(attrs['data-perf-forced']).toBe('')
    })

    it('honours ?perf=auto over a remembered mode even when storage throws', () => {
        // Nothing can be forgotten here, so the most this load can do is ignore what it cannot read: it must
        // detect rather than fall back to a stored mode it has no way of clearing.
        // (a desktop and a remembered lite, which detection there would never give, so the two can't be confused)
        const attrs = run({ search: '?perf=auto', innerWidth: 1920, innerHeight: 1080, dpr: 2, stored: 'lite', storageThrows: true })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-scene-max']).toBe(String(TIERS.length))
        expect(attrs['data-perf-forced']).toBeUndefined()
    })

    it('falls back to the still scene when detection throws', () => {
        const attrs = run({ noMatchMedia: true })
        expect(attrs['data-scene']).toBe('')
        expect(attrs['data-scene-max']).toBe('0')
    })

    it('inlines the real ceilingFor rather than a second copy of the arithmetic', () => {
        expect(PERF_SCRIPT).toContain('budgets.memDivisor')
    })
})

// A phone that can't hold what it was handed dies on screen, and the browser reloads it. The page marks the tiers it is
// showing as live, and clears the mark whenever it is hidden or left normally (see crashGuard.ts), so a load that finds
// the mark still there knows the last visit died on screen
describe('PERF_SCRIPT after a crash', () => {
    it('marks the tiers it hands out as live', () => {
        const storage: Record<string, string> = {}
        run({ innerWidth: 1920, innerHeight: 1080, dpr: 2, storage })
        expect(storage['scene-live']).toBe(String(TIERS.length))
    })

    it('marks the still scene as live when it starts a device there to climb', () => {
        const storage: Record<string, string> = { 'scene-cap': '1' }
        run({ coarse: true, storage })
        expect(storage['scene-live']).toBe('0')
    })

    it('holds a load after a crash to the depth tier, and remembers that', () => {
        // straight to depth rather than one tier down: the stars are the big memory cost, and stepping down one at a
        // time would keep them through two more crashes
        const storage: Record<string, string> = { 'scene-live': String(TIERS.length - 1) }   // what a phone shows
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe('1')
        expect(attrs['data-scene']).toBe('')   // climbs to depth from the still scene like any capped device
        expect(storage['scene-cap']).toBe('1')
    })

    it('drops to the still scene after a crash at the depth tier', () => {
        const storage: Record<string, string> = { 'scene-live': '1' }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe('0')
        expect(storage['scene-cap']).toBe('0')
    })

    it('keeps to a remembered cap on later loads', () => {
        const storage: Record<string, string> = { 'scene-cap': '1' }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe('1')
    })

    it('never raises a cap it already has', () => {
        const storage: Record<string, string> = { 'scene-cap': '0', 'scene-live': String(TIERS.length) }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe('0')
        expect(storage['scene-cap']).toBe('0')
    })

    it('forgets an old cap on ?perf=auto', () => {
        const storage: Record<string, string> = { 'scene-cap': '0' }
        const attrs = run({ search: '?perf=auto', coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
    })

    it('still honours a crash that has only just happened on ?perf=auto', () => {
        // The browser reloads a crashed page at the same address. If ?perf=auto threw the fresh mark away along with
        // the old cap, every reload would hand the scene out again and crash again: a crash loop forced by a URL.
        const storage: Record<string, string> = { 'scene-cap': '0', 'scene-live': String(TIERS.length - 1) }
        const attrs = run({ search: '?perf=auto', coarse: true, storage })
        expect(attrs['data-scene-max']).toBe('1')
        expect(storage['scene-cap']).toBe('1')
    })

    it('neither marks nor obeys it when a mode is forced', () => {
        const storage: Record<string, string> = { 'scene-cap': '0' }
        const attrs = run({ search: '?perf=full', coarse: true, storage })
        expect(attrs['data-scene']).toBe(ALL)
        expect(storage['scene-live']).toBeUndefined()
    })
})
