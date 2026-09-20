import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAP_MAX_WEEKS, CAP_WEEK_MS } from './crashGuard'
import { TIERS } from './tiers'
import { PERF_SCRIPT } from './script'

const ALL = TIERS.map(t => t.token).join(' ')

// The clock the loads below run on, so a cap's window can be driven by hand rather than waited out
const NOW = Date.parse('2026-09-20T12:00:00Z')

// What the script stores for a cap: the tier, the moment it was written, and the weeks it is good for
const cap = (tier: number, weeks: number, writtenAgo = 0) => `${tier} ${NOW - writtenAgo} ${weeks}`

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
})

afterEach(() => {
    vi.useRealTimers()
})

interface Env {
    search?: string
    stored?: string | null
    storage?: Record<string, string>   // localStorage: seeded, and mutated in place, so a test can read it back
    session?: Record<string, string>   // sessionStorage, the same way
    visibility?: 'visible' | 'hidden'
    prerendering?: boolean
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
        visibilityState: env.visibility ?? 'visible',
        prerendering: !!env.prerendering,
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
    const tab: Record<string, string> = env.session ?? {}
    const sessionStorage = env.storageThrows ? { getItem: boom, setItem: boom, removeItem: boom } : {
        getItem: (k: string) => (k in tab ? tab[k] : null),
        setItem: (k: string, v: string) => { tab[k] = v },
        removeItem: (k: string) => { delete tab[k] },
    }

    new Function('window', 'document', 'location', 'localStorage', 'sessionStorage', 'navigator', PERF_SCRIPT)(
        window, document, location, localStorage, sessionStorage, navigator,
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

// A phone that can't hold what it was handed dies on screen, and the browser reloads it in the same tab. The page marks
// the tiers it is showing as live for that tab, and clears the mark whenever it is hidden or left normally (see
// crashGuard.ts), so a load that finds the mark still there knows the last visit in this tab died on screen
describe('PERF_SCRIPT after a crash', () => {
    const DESKTOP = { innerWidth: 1920, innerHeight: 1080, dpr: 2 }

    it('marks the tiers it hands out as live, for this tab', () => {
        const session: Record<string, string> = {}
        run({ ...DESKTOP, session })
        expect(session['scene-live']).toBe(String(TIERS.length))
    })

    it('marks the still scene as live when it starts a device there to climb', () => {
        const session: Record<string, string> = {}
        run({ coarse: true, session })
        expect(session['scene-live']).toBe('0')
    })

    it('holds a load after a crash to the depth tier, and remembers that for the device', () => {
        // straight to depth rather than one tier down: the stars are the big memory cost, and stepping down one at a
        // time would keep them through two more crashes
        const storage: Record<string, string> = {}
        const session: Record<string, string> = { 'scene-live': String(TIERS.length - 1) }   // what a phone shows
        const attrs = run({ coarse: true, storage, session })
        expect(attrs['data-scene-max']).toBe('1')
        expect(attrs['data-scene']).toBe('')   // climbs to depth from the still scene like any capped device
        expect(storage['scene-cap']).toBe(cap(1, 1))
    })

    it('drops to the still scene after a crash at the depth tier', () => {
        const storage: Record<string, string> = {}
        const attrs = run({ coarse: true, storage, session: { 'scene-live': '1' } })
        expect(attrs['data-scene-max']).toBe('0')
        expect(storage['scene-cap']).toBe(cap(0, 1))
    })

    it('keeps to a remembered cap on later loads', () => {
        const attrs = run({ coarse: true, storage: { 'scene-cap': cap(1, 1) } })
        expect(attrs['data-scene-max']).toBe('1')
    })

    it('never raises a cap it already has', () => {
        const storage: Record<string, string> = { 'scene-cap': cap(0, 1) }
        const attrs = run({ coarse: true, storage, session: { 'scene-live': String(TIERS.length) } })
        expect(attrs['data-scene-max']).toBe('0')
        expect(storage['scene-cap']).toBe(cap(0, 2))   // a crash under a live cap, so the cap lasts longer (below)
    })

    it('forgets an old cap on ?perf=auto', () => {
        const storage: Record<string, string> = { 'scene-cap': cap(0, 1) }
        const attrs = run({ search: '?perf=auto', coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
    })

    it('still honours a crash that has only just happened on ?perf=auto', () => {
        // The browser reloads a crashed page at the same address. If ?perf=auto threw the fresh mark away along with
        // the old cap, every reload would hand the scene out again and crash again: a crash loop forced by a URL.
        const storage: Record<string, string> = { 'scene-cap': cap(0, 1) }
        const attrs = run({ search: '?perf=auto', coarse: true, storage, session: { 'scene-live': String(TIERS.length - 1) } })
        expect(attrs['data-scene-max']).toBe('1')
        expect(storage['scene-cap']).toBe(cap(1, 1))
    })

    it('neither marks nor obeys it when a mode is forced', () => {
        const session: Record<string, string> = {}
        const attrs = run({ search: '?perf=full', coarse: true, storage: { 'scene-cap': cap(0, 1) }, session })
        expect(attrs['data-scene']).toBe(ALL)
        expect(session['scene-live']).toBeUndefined()
    })

    // A mark shared by every page of the site misread pages it never belonged to: a phone was held to the still scene
    // on every plain load with no crash at all. Hence the mark is per tab, and only a page actually on screen counts.
    it('ignores a mark left in shared storage by an earlier version, and clears it away', () => {
        const storage: Record<string, string> = { 'scene-live': '1' }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
        expect(storage['scene-live']).toBeUndefined()
    })

    it('neither reads nor writes the mark from a page loading out of sight', () => {
        // a page the browser preloads, or a tab opened in the background, is not a page that died on screen
        const storage: Record<string, string> = {}
        const session: Record<string, string> = { 'scene-live': String(TIERS.length - 1) }
        const attrs = run({ coarse: true, visibility: 'hidden', storage, session })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
        expect(session['scene-live']).toBe(String(TIERS.length - 1))   // left exactly as it was
    })

    it('nor from a page being prerendered', () => {
        const storage: Record<string, string> = {}
        const session: Record<string, string> = { 'scene-live': '1' }
        const attrs = run({ coarse: true, prerendering: true, storage, session })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
        expect(session['scene-live']).toBe('1')
    })

    it('still applies a remembered cap to a page loading out of sight', () => {
        const attrs = run({ coarse: true, visibility: 'hidden', storage: { 'scene-cap': cap(1, 1) } })
        expect(attrs['data-scene-max']).toBe('1')
    })
})

// The cap is for a phone being killed for memory, which is the crash this whole staged scene is about. A device with
// a fine pointer was never the one at risk: it gets a budget it is nowhere near, and killing its tab does not reload
// it into the same crash. Meanwhile the mark it is judged on is not proof of a crash at all. sessionStorage is copied
// into a duplicated tab, and brought back by a session restore after the browser or the machine is restarted, so a
// mark can be found with the page that wrote it still alive, or hours later. On a phone that costs one tier and stops
// a real crash loop, which is the trade the guard is for. On a PC it left a capable machine a tier down for good, on
// nothing, and no amount of reloading could talk it back out again.
describe('PERF_SCRIPT crash cap on a fine pointer', () => {
    const DESKTOP = { innerWidth: 1920, innerHeight: 1080, dpr: 2 }

    it('does not cap a device with a fine pointer that finds a mark', () => {
        const storage: Record<string, string> = {}
        const attrs = run({ ...DESKTOP, storage, session: { 'scene-live': String(TIERS.length) } })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-scene-max']).toBe(String(TIERS.length))
        expect(storage['scene-cap']).toBeUndefined()
    })

    it('ignores a cap an earlier false alarm already wrote, so a reload gets the scene back', () => {
        const attrs = run({ ...DESKTOP, storage: { 'scene-cap': cap(0, 1) } })
        expect(attrs['data-scene']).toBe(ALL)
        expect(attrs['data-scene-max']).toBe(String(TIERS.length))
    })

    it('keeps a remembered cap stored, for when the same device is held as a tablet', () => {
        // a convertible reports a coarse pointer in tablet mode, and that is the mode the cap was for
        const storage: Record<string, string> = { 'scene-cap': cap(0, 1) }
        run({ ...DESKTOP, storage })
        expect(storage['scene-cap']).toBe(cap(0, 1))   // window and all: a fine pointer does not start its clock either
        expect(run({ coarse: true, storage })['data-scene-max']).toBe('0')
    })
})

// A mark is not proof of a crash even on a phone, so a cap earned by one does not last forever. It is stored with the
// moment it was written and the weeks it is good for, and once those are up it is thrown away and the device detects
// afresh. Each further crash while a cap is live doubles the weeks, so a phone that genuinely cannot hold the scene
// ratchets towards being left alone, while a duplicated tab or a restored session costs it one week of one tier.
describe('PERF_SCRIPT cap expiry', () => {
    const CRASHED = { 'scene-live': String(TIERS.length - 1) }   // what a phone shows, found again on the next load

    it('stores a fresh cap with the week it is good for', () => {
        const storage: Record<string, string> = {}
        run({ coarse: true, storage, session: { ...CRASHED } })
        expect(storage['scene-cap']).toBe(cap(1, 1))
    })

    it('keeps to a stored cap while its week is still running', () => {
        const attrs = run({ coarse: true, storage: { 'scene-cap': cap(1, 1, CAP_WEEK_MS - 1000) } })
        expect(attrs['data-scene-max']).toBe('1')
    })

    it('forgets a cap once its week is up, and detects afresh', () => {
        const storage: Record<string, string> = { 'scene-cap': cap(0, 1, CAP_WEEK_MS + 1000) }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
    })

    it('honours the longer window a re-earned cap was given', () => {
        const attrs = run({ coarse: true, storage: { 'scene-cap': cap(1, 4, 3 * CAP_WEEK_MS) } })
        expect(attrs['data-scene-max']).toBe('1')
    })

    it('doubles the weeks when a crash is found under a cap that is still live', () => {
        // the device was already held to depth and died there, so the cap was not wrong and was not enough
        const storage: Record<string, string> = { 'scene-cap': cap(1, 2) }
        const attrs = run({ coarse: true, storage, session: { 'scene-live': '1' } })
        expect(attrs['data-scene-max']).toBe('0')
        expect(storage['scene-cap']).toBe(cap(0, 4))
    })

    it('starts the weeks over at one when the cap it crashed under had already run out', () => {
        const storage: Record<string, string> = { 'scene-cap': cap(1, 4, 5 * CAP_WEEK_MS) }
        run({ coarse: true, storage, session: { ...CRASHED } })
        expect(storage['scene-cap']).toBe(cap(1, 1))
    })

    it('stops doubling the weeks at a year', () => {
        const storage: Record<string, string> = { 'scene-cap': cap(0, CAP_MAX_WEEKS) }
        run({ coarse: true, storage, session: { 'scene-live': '0' } })
        expect(storage['scene-cap']).toBe(cap(0, CAP_MAX_WEEKS))
    })

    it('drops a bare cap left by an earlier version, which carried no window at all', () => {
        // every one of those was written when a single false mark pinned the device for good, so there is no telling
        // whether it was earned; a phone that really cannot hold the scene earns a new one on its next crash
        const storage: Record<string, string> = { 'scene-cap': '0' }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
    })

    it('drops a cap it cannot read, rather than obeying it forever', () => {
        const storage: Record<string, string> = { 'scene-cap': 'nonsense here' }
        const attrs = run({ coarse: true, storage })
        expect(attrs['data-scene-max']).toBe(String(TIERS.length - 1))
        expect(storage['scene-cap']).toBeUndefined()
    })
})

// The guard's own log, so a misfire on a phone that can't be attached to a profiler can be read off the page instead of
// guessed at. Only kept once ?debug=perf has turned it on, so normal visitors write nothing.
describe('PERF_SCRIPT guard log', () => {
    it('is turned on by ?debug=perf, which then records the load', () => {
        const storage: Record<string, string> = {}
        run({ search: '?debug=perf', coarse: true, storage, session: { 'scene-live': '1' } })
        expect(storage['scene-debug']).toBe('1')
        const log = JSON.parse(storage['scene-log']) as string[]
        expect(log).toHaveLength(1)
        expect(log[0]).toMatch(/load .*mark 1 .*cap - > 0/)
    })

    it('keeps recording later loads while it is on', () => {
        const storage: Record<string, string> = { 'scene-debug': '1' }
        run({ coarse: true, storage })
        run({ coarse: true, storage })
        expect(JSON.parse(storage['scene-log'])).toHaveLength(2)
    })

    it('is turned off by ?debug=off', () => {
        const storage: Record<string, string> = { 'scene-debug': '1', 'scene-log': '[]' }
        run({ search: '?debug=off', coarse: true, storage })
        expect(storage['scene-debug']).toBeUndefined()
        expect(storage['scene-log']).toBeUndefined()
    })

    it('records nothing when it was never turned on', () => {
        const storage: Record<string, string> = {}
        run({ coarse: true, storage })
        expect(storage['scene-log']).toBeUndefined()
    })
})
