import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TIERS } from './tiers'
import { runScene } from './climb'

// A deterministic stand-in for a browser, so the climb driver's timing can be driven by hand instead of waited
// out. `climb.ts` and `usePerf.ts` only ever touch `document` and `window` from inside a function body, never at
// module scope, so assigning fakes to the globals before calling `runScene()` is all that's needed here; there's
// no DOM underneath any of this.
//
// climb.ts's own tuning constants, mirrored here (it doesn't export them: they're its private tuning, not part
// of its public surface, and the tests below drive them from the outside the same way a real clock would).
const STEP_MS = 450
const SETTLE_MS = 1000
const TOP_WAIT_MS = 30000
const CLIMB_FRAMES = 20
const WATCH_FRAMES = 60

const FAST = 16  // comfortably under climb.ts's 36ms slow-frame threshold
const SLOW = 60  // comfortably over it

const ALL = TIERS.map(t => t.token).join(' ')
const DEPTH = TIERS[0].token
const withTiers = (n: number) => TIERS.slice(0, n).map(t => t.token).join(' ')

function harness() {
    const attrs: Record<string, string> = {}
    let attributeWrites = 0
    const root = {
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        setAttribute: (k: string, v: string) => { attrs[k] = v; attributeWrites++ },
        hasAttribute: (k: string) => k in attrs,
    }
    const fakeDocument = { documentElement: root, hidden: false }

    // A real addEventListener/removeEventListener pair for 'scroll', so a leaked listener shows up as a
    // non-empty set rather than being invisible.
    const scrollListeners = new Set<() => void>()
    const fakeWindow = {
        scrollY: 0,
        setTimeout,   // whatever these currently resolve to: vitest's faked clock once useFakeTimers() has run
        clearTimeout,
        addEventListener: (type: string, cb: () => void) => { if (type === 'scroll') scrollListeners.add(cb) },
        removeEventListener: (type: string, cb: () => void) => { if (type === 'scroll') scrollListeners.delete(cb) },
    }

    // A manual animation-frame queue, standing in for requestAnimationFrame/cancelAnimationFrame. climb.ts only
    // ever has one frame in flight at a time, but this drains whatever is queued rather than assuming that.
    let clock = 0
    let nextFrameId = 0
    const pendingFrames = new Map<number, (now: number) => void>()

    globalThis.document = fakeDocument as unknown as Document
    globalThis.window = fakeWindow as unknown as Window & typeof globalThis
    globalThis.requestAnimationFrame = ((cb: (now: number) => void) => {
        const id = ++nextFrameId
        pendingFrames.set(id, cb)
        return id
    }) as unknown as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => {
        pendingFrames.delete(id)
    }) as unknown as typeof cancelAnimationFrame

    // Fires every pending frame once, at `clock += deltaMs`.
    const tick = (deltaMs: number) => {
        clock += deltaMs
        const callbacks = Array.from(pendingFrames.values())
        pendingFrames.clear()
        callbacks.forEach(cb => cb(clock))
    }

    return {
        scene: () => attrs['data-scene'] ?? '',
        setScene: (tokens: string) => { attrs['data-scene'] = tokens },
        setMax: (n: number) => { attrs['data-scene-max'] = String(n) },
        scrollTo: (y: number) => { fakeWindow.scrollY = y; Array.from(scrollListeners).forEach(l => l()) },
        setHidden: (v: boolean) => { fakeDocument.hidden = v },
        tick,
        // count+1 ticks: sampleFrames' first tick only ever establishes its baseline (it never pushes a delta on
        // the frame that sets `last`), so `count` further ticks are what fills its `deltas` array and resolves it.
        flush: (count: number, deltaMs: number) => { for (let i = 0; i <= count; i++) tick(deltaMs) },
        pendingFrameCount: () => pendingFrames.size,
        pendingScrollListenerCount: () => scrollListeners.size,
        attributeWriteCount: () => attributeWrites,
    }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
})

describe('a full climb', () => {
    it('applies all four tiers in order under fast frames, then settles into the watch', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)

        runScene()

        // depth goes in synchronously: scrollY is 0, so whenAtTop's gate is already satisfied
        expect(h.scene()).toBe(withTiers(1))

        for (let n = 2; n <= TIERS.length; n++) {
            h.flush(CLIMB_FRAMES, FAST)      // resolves the previous step's sample, arming the STEP_MS timer
            vi.advanceTimersByTime(STEP_MS)  // fires climb() again, which applies the next tier
            expect(h.scene()).toBe(withTiers(n))
        }

        // One more sample, for the tier the loop just applied (forest). This time climb() finds it's already at
        // the ceiling and moves to the watch instead of reaching for a fifth tier.
        h.flush(CLIMB_FRAMES, FAST)
        vi.advanceTimersByTime(STEP_MS)
        expect(h.scene()).toBe(ALL)
        expect(h.pendingFrameCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(1)   // the watch's SETTLE_MS timer, and nothing besides it

        // The watch's own check, with frames still fine, finds nothing to do and does not reschedule itself
        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, FAST)
        expect(h.scene()).toBe(ALL)
        expect(vi.getTimerCount()).toBe(0)
        expect(h.pendingFrameCount()).toBe(0)
    })
})

describe('a slow frame mid-climb', () => {
    it('reverts to the tier that step started from, and hands off to the watch rather than stopping', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)

        runScene()
        expect(h.scene()).toBe(withTiers(1))   // depth, applied synchronously

        // The depth step's own frames measure fine, so it proceeds to sky
        h.flush(CLIMB_FRAMES, FAST)
        vi.advanceTimersByTime(STEP_MS)
        expect(h.scene()).toBe(withTiers(2))   // depth sky

        // But the sky step's own frames come back slow
        h.flush(CLIMB_FRAMES, SLOW)
        expect(h.scene()).toBe(withTiers(1))   // back to depth exactly, not all the way to the still scene
        expect(h.pendingFrameCount()).toBe(0)  // it doesn't retry immediately...
        expect(vi.getTimerCount()).toBe(1)     // ...it hands off to the watch instead of stopping outright

        // The watch's own subsequent check, finding frames fine again, leaves it there and settles
        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, FAST)
        expect(h.scene()).toBe(withTiers(1))
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('whenAtTop', () => {
    it('applies depth immediately when already at the top', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)
        h.scrollTo(0)

        runScene()
        expect(h.scene()).toBe(DEPTH)
        expect(h.pendingScrollListenerCount()).toBe(0)
    })

    it('withholds depth until a scroll returns to the top, then applies it', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)
        h.scrollTo(800)

        runScene()
        expect(h.scene()).toBe('')             // nothing applied yet
        expect(h.pendingScrollListenerCount()).toBe(1)
        expect(vi.getTimerCount()).toBe(1)     // the give-up timer

        h.scrollTo(400)                         // still not at the top: the listener is a no-op here
        expect(h.scene()).toBe('')

        h.scrollTo(0)                            // back at the top: now it applies
        expect(h.scene()).toBe(DEPTH)
        expect(h.pendingScrollListenerCount()).toBe(0)   // the listener cleans itself up
        expect(vi.getTimerCount()).toBe(0)               // ...and so does the give-up timer
    })

    it('gives up waiting for the top after TOP_WAIT_MS and hands off to the watch, rather than leaving nothing running', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)
        h.scrollTo(800)

        runScene()
        expect(vi.getTimerCount()).toBe(1)

        vi.advanceTimersByTime(TOP_WAIT_MS)
        expect(h.scene()).toBe('')                         // depth was never applied
        expect(h.pendingScrollListenerCount()).toBe(0)     // the wait for a scroll is abandoned
        expect(vi.getTimerCount()).toBe(1)                 // but the watch is now running in its place

        // and the watch it handed off to is genuinely functional: it settles cleanly rather than spinning
        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, FAST)
        expect(h.scene()).toBe('')
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('the watch', () => {
    it('steps down by exactly one tier and rearms itself when frames are slow', () => {
        const h = harness()
        h.setScene(ALL)   // handed everything up front: this device never climbs, only ever gets watched
        h.setMax(TIERS.length)

        runScene()
        expect(h.scene()).toBe(ALL)
        expect(vi.getTimerCount()).toBe(1)   // the only check a device like this ever gets

        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, SLOW)
        expect(h.scene()).toBe(withTiers(TIERS.length - 1))   // exactly one tier dropped
        expect(vi.getTimerCount()).toBe(1)                    // rearmed for another look
        expect(h.pendingFrameCount()).toBe(0)
    })

    it('stops checking once it reaches the still scene', () => {
        const h = harness()
        h.setScene('')
        h.setMax(0)   // a device that could afford nothing: watched from the very start, never climbs

        runScene()
        expect(vi.getTimerCount()).toBe(1)

        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, SLOW)
        expect(h.scene()).toBe('')            // nowhere further to go
        expect(vi.getTimerCount()).toBe(0)    // and it stops asking, rather than checking forever
        expect(h.pendingFrameCount()).toBe(0)
    })
})

describe('stop', () => {
    it('cancels an in-flight frame sample and leaves nothing pending', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)

        const stop = runScene()
        expect(h.scene()).toBe(DEPTH)
        expect(h.pendingFrameCount()).toBe(1)
        const writesBeforeStop = h.attributeWriteCount()

        stop()
        expect(h.pendingFrameCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        expect(h.pendingScrollListenerCount()).toBe(0)

        // and nothing more happens, no matter how much is thrown at it afterwards
        h.flush(CLIMB_FRAMES, FAST)
        vi.advanceTimersByTime(100000)
        expect(h.attributeWriteCount()).toBe(writesBeforeStop)
        expect(h.scene()).toBe(DEPTH)
    })

    it('cancels a pending step timer and leaves nothing pending', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)

        const stop = runScene()
        h.flush(CLIMB_FRAMES, FAST)   // resolves the depth step, arming the STEP_MS timer
        expect(vi.getTimerCount()).toBe(1)
        const writesBeforeStop = h.attributeWriteCount()

        stop()
        expect(vi.getTimerCount()).toBe(0)
        expect(h.pendingFrameCount()).toBe(0)

        vi.advanceTimersByTime(100000)
        h.flush(CLIMB_FRAMES, FAST)
        expect(h.attributeWriteCount()).toBe(writesBeforeStop)
        expect(h.scene()).toBe(DEPTH)
    })

    it('cancels a wait for the top and leaves nothing pending', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)
        h.scrollTo(800)

        const stop = runScene()
        expect(h.pendingScrollListenerCount()).toBe(1)
        expect(vi.getTimerCount()).toBe(1)
        const writesBeforeStop = h.attributeWriteCount()

        stop()
        expect(h.pendingScrollListenerCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)

        h.scrollTo(0)
        vi.advanceTimersByTime(TOP_WAIT_MS)
        expect(h.attributeWriteCount()).toBe(writesBeforeStop)
        expect(h.scene()).toBe('')
    })

    it('cancels a pending watch timer and leaves nothing pending', () => {
        const h = harness()
        h.setScene(ALL)
        h.setMax(TIERS.length)

        const stop = runScene()
        expect(vi.getTimerCount()).toBe(1)
        const writesBeforeStop = h.attributeWriteCount()

        stop()
        expect(vi.getTimerCount()).toBe(0)

        vi.advanceTimersByTime(SETTLE_MS)
        h.flush(WATCH_FRAMES, SLOW)
        expect(h.attributeWriteCount()).toBe(writesBeforeStop)
        expect(h.scene()).toBe(ALL)
    })

    it('cancels an in-flight watch sample and leaves nothing pending', () => {
        const h = harness()
        h.setScene(ALL)
        h.setMax(TIERS.length)

        const stop = runScene()
        vi.advanceTimersByTime(SETTLE_MS)   // now inside the watch's own frame sample
        expect(h.pendingFrameCount()).toBe(1)
        const writesBeforeStop = h.attributeWriteCount()

        stop()
        expect(h.pendingFrameCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)

        h.flush(WATCH_FRAMES, SLOW)
        vi.advanceTimersByTime(100000)
        expect(h.attributeWriteCount()).toBe(writesBeforeStop)
        expect(h.scene()).toBe(ALL)
    })
})

describe('a hidden tab', () => {
    it('discards frames measured across the hidden gap, and starts over once visible again', () => {
        const h = harness()
        h.setScene('')
        h.setMax(TIERS.length)

        runScene()
        expect(h.scene()).toBe(DEPTH)   // depth applied synchronously; its own sample is now running

        h.tick(FAST)   // establishes sampleFrames' baseline (its first tick never pushes a delta)

        h.setHidden(true)
        h.tick(100000)   // a tick while hidden: whatever gap this represents must be discarded, not measured
        h.setHidden(false)

        // If the hidden gap had counted as a measured delta, the sample would need only CLIMB_FRAMES - 1 further
        // ticks from here (it would already hold one delta, from the hidden tick). Instead, going hidden reset
        // its baseline, so completing it now costs a fresh CLIMB_FRAMES + 1 ticks: one to re-establish `last`,
        // and CLIMB_FRAMES to refill `deltas`. Feeding exactly CLIMB_FRAMES of those and checking it has *not*
        // resolved yet is what proves the gap was actually thrown away, rather than merely not being the
        // slowest sample in the batch.
        for (let i = 0; i < CLIMB_FRAMES; i++) h.tick(FAST)
        expect(h.scene()).toBe(DEPTH)          // still not resolved
        expect(vi.getTimerCount()).toBe(0)     // no STEP_MS timer yet: the sample is still open

        h.tick(FAST)   // the one further tick the reset baseline costs
        expect(vi.getTimerCount()).toBe(1)     // now it has resolved, and resolved fast

        vi.advanceTimersByTime(STEP_MS)
        // Proceeded to sky rather than reverting: the median really was computed from only the good frames
        // gathered after the hidden gap, not dragged up by a 100-second delta.
        expect(h.scene()).toBe(withTiers(2))
    })
})
