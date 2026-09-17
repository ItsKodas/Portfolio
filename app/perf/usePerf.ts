import { useSyncExternalStore } from 'react'

// The page's performance mode, as set on the root by the head script (see script.ts), for components to follow. The
// server always renders the full page; the browser switches to lite straight after hydrating when it needs to.

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

const isLite = () => document.documentElement.dataset.perf === 'lite'

export function useLite() {
    return useSyncExternalStore(subscribe, isLite, () => false)
}

function goLite() {
    if (isLite()) return
    document.documentElement.dataset.perf = 'lite'
    listeners.forEach(l => l())
}

// A frame slower than this, at the median, means the browser can't keep up with the full hero. It's above a 30Hz
// display's 33ms, so a slow screen alone doesn't count.
const SLOW_FRAME_MS = 36
const SAMPLE_FRAMES = 60
const SETTLE_MS = 1000 // leave the load and hydration out of it

// Times a second or so of frames once the page has settled, and switches to lite if they're too slow. Only for
// browsers the head script left on full by detection (not when a mode was forced). Returns a cleanup.
export function watchFrameRate() {
    const root = document.documentElement
    if (isLite() || root.hasAttribute('data-perf-forced')) return () => {}

    let frame = 0, timer = 0, last = 0
    const deltas: number[] = []

    const tick = (now: number) => {
        // A hidden tab doesn't draw; start over from the next frame it does
        if (document.hidden) { last = 0; frame = requestAnimationFrame(tick); return }
        if (last) deltas.push(now - last)
        last = now
        if (deltas.length < SAMPLE_FRAMES) { frame = requestAnimationFrame(tick); return }

        deltas.sort((a, b) => a - b)
        if (deltas[deltas.length >> 1] > SLOW_FRAME_MS) goLite()
    }

    const start = () => { timer = window.setTimeout(() => { frame = requestAnimationFrame(tick) }, SETTLE_MS) }
    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })

    return () => {
        window.removeEventListener('load', start)
        clearTimeout(timer)
        cancelAnimationFrame(frame)
    }
}
