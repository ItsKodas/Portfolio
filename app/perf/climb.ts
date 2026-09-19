import { TIERS } from './tiers'
import { currentTier, sceneMax, setTier } from './usePerf'

// Puts the rest of the scene in, once the curtain has lifted, on a browser that couldn't be handed all of it up
// front (see script.ts). One tier at a time, timing the frames after each, so a device that turns out to be slower
// than its budget suggested stops where it is instead of pushing on. Then it keeps watching, at rest and while the
// page is being scrolled, and steps back down if the browser can't keep up.

// A frame slower than this, at the median, means the browser can't keep up with what's on screen. It's above a 30Hz
// display's 33ms, so a slow screen alone doesn't count.
const SLOW_FRAME_MS = 36
const STEP_MS = 450         // between a tier going in and its frames being timed, so it is settled when sampled
const CLIMB_FRAMES = 20     // timed after each tier, enough to catch one that hurts without holding things up
const SETTLE_MS = 1000      // before the watch below, to leave the load and hydration out of it
const WATCH_FRAMES = 60
const SCROLL_FRAMES = 30    // frames drawn mid-scroll, gathered across gestures, before each verdict
const SWAP_WAIT_MS = 30000  // how long a change to the depth tier waits for a moment it can be made unseen

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

// canSwapScene says whether the scene can be swapped between its still and full versions without it visibly
// jumping (see ParallaxView, which owns the geometry). At the very top of the page every layer is at offset zero
// and the two look identical, which is the default.
export function runScene(canSwapScene: () => boolean = () => window.scrollY === 0) {
    if (document.documentElement.hasAttribute('data-perf-forced')) return () => {}

    let stopped = false
    let cancelSample = () => {}
    let timer = 0
    let giveUp = 0
    let onScroll: (() => void) | null = null
    let stopScrollWatch = () => {}

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
        stopScrollWatch()
    }

    // Adding or removing the depth tier swaps the still scene's three layers for the full ten (or back), which sit
    // at different parallax offsets, so it waits for a moment the swap can't be seen. If none comes, giveUp decides.
    const whenSwappable = (go: () => void, onGiveUp: () => void) => {
        if (canSwapScene()) return go()
        giveUp = window.setTimeout(() => { clearWait(); onGiveUp() }, SWAP_WAIT_MS)
        onScroll = () => {
            if (!canSwapScene()) return
            clearWait()
            go()
        }
        window.addEventListener('scroll', onScroll, { passive: true })
    }

    // Down one tier, then carry on with `then`. Losing depth waits for an unseen moment like gaining it does, but a
    // device that is already struggling shouldn't be left that way indefinitely, so it goes anyway if none comes.
    const stepDown = (then: () => void) => {
        const at = currentTier()
        if (at === 0) return
        const go = () => { setTier(at - 1); then() }
        if (at === 1) whenSwappable(go, go)
        else go()
    }

    const climb = () => {
        if (stopped) return
        const at = currentTier()
        if (at >= sceneMax() || at >= TIERS.length) return watch()

        // Every step waits the same STEP_MS between putting a tier in and timing it, the first one included. On a
        // phone that first step is the whole scene arriving at once, with the curtain still fading and the logo's
        // intro mid-flight, so sampling it from the same frame it lands on measures the remount rather than the
        // tier. The ratchet only goes one way, so that reads as a false demotion for the rest of the visit.
        const step = () => {
            if (stopped) return
            setTier(at + 1)
            timer = window.setTimeout(() => {
                if (stopped) return
                cancelSample = sampleFrames(CLIMB_FRAMES, median => {
                    if (stopped) return
                    // Slower than the budget promised: put the tier back and stop climbing, but keep watching
                    if (median > SLOW_FRAME_MS) { setTier(at); return watch() }
                    climb()
                })
            }, STEP_MS)
        }

        if (TIERS[at].token === 'depth') whenSwappable(step, watch)
        else step()
    }

    // Once nothing more is going in, keep an eye on the frames and step back down if the browser can't keep up. A
    // device that was handed the whole scene up front never climbs, so this is the first check it gets. Frames at
    // rest say little about scrolling, though, so passing it hands over to the scroll watch rather than ending there.
    const watch = () => {
        if (stopped) return
        timer = window.setTimeout(() => {
            cancelSample = sampleFrames(WATCH_FRAMES, median => {
                if (stopped) return
                if (median <= SLOW_FRAME_MS) return watchScroll()
                stepDown(watch)
            })
        }, SETTLE_MS)
    }

    // Times only the frames drawn while the page is being scrolled, which is where a phone struggles: a frame counts
    // when a scroll event has landed since the one before it. Between gestures it draws nothing of its own, and it
    // starts each gesture from a fresh baseline so the idle gap is never measured. Every SCROLL_FRAMES frames it
    // judges, and steps down one tier if they were slow, then keeps watching at the new one.
    const watchScroll = () => {
        if (stopped || currentTier() === 0) return
        let frame = 0, last = 0, scrolled = false
        const deltas: number[] = []

        const tick = (now: number) => {
            frame = 0
            if (!scrolled || document.hidden) { last = 0; return }
            scrolled = false
            if (last) deltas.push(now - last)
            last = now
            if (deltas.length < SCROLL_FRAMES) { frame = requestAnimationFrame(tick); return }
            deltas.sort((a, b) => a - b)
            const median = deltas[deltas.length >> 1]
            deltas.length = 0
            last = 0
            if (median > SLOW_FRAME_MS) { stopScrollWatch(); stepDown(watchScroll) }
        }
        const onScrollFrame = () => {
            scrolled = true
            if (!frame) frame = requestAnimationFrame(tick)
        }

        window.addEventListener('scroll', onScrollFrame, { passive: true })
        stopScrollWatch = () => {
            window.removeEventListener('scroll', onScrollFrame)
            if (frame) cancelAnimationFrame(frame)
            frame = 0
            stopScrollWatch = () => {}
        }
    }

    climb()
    return stop
}
