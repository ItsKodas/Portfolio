import { TIERS } from './tiers'
import { currentTier, sceneMax, setTier } from './usePerf'

// Puts the rest of the scene in, once the curtain has lifted, on a browser that couldn't be handed all of it up
// front (see script.ts). One tier at a time, timing the frames after each, so a device that turns out to be slower
// than its budget suggested stops where it is instead of pushing on.

// A frame slower than this, at the median, means the browser can't keep up with what's on screen. It's above a 30Hz
// display's 33ms, so a slow screen alone doesn't count.
const SLOW_FRAME_MS = 36
const STEP_MS = 450         // between a tier going in and its frames being timed, so it is settled when sampled
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
