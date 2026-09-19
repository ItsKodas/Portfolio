'use client'

import { useEffect, useState } from 'react'

// A test mode for finding out why scrolling lags on a phone that can't be attached to a profiler. Open the page with
// ?debug=perf and a small readout shows, once a second, how often the page got to draw and how often the browser told
// it the page had scrolled, plus switches that each take one suspect out of the picture. Renders nothing otherwise.
//
// The switches are tokens in data-debug on the root, which the rules at the end of app/globals.css act on, so turning
// one on never re-renders the scene.

const SWITCHES = [
    { token: 'still', label: 'Parallax off' },  // every layer scrolls natively, with no JavaScript moving it
    { token: 'nohero', label: 'Hero off' },     // the whole scene hidden
    { token: 'nomask', label: 'Masks off' },    // faded edges and the water's masks
    { token: 'nofilter', label: 'Filters off' }, // the fog's blur and the like
    { token: 'css', label: 'CSS parallax' },     // the same parallax, driven by the browser's scroll instead of script
]

// Whether this browser can drive animations from the scroll position, and which iOS it is (every iOS browser uses the
// system WebKit, and WebKit only runs scroll-driven animations off the main thread from 26.4)
const timelines = () => typeof CSS !== 'undefined' && CSS.supports('animation-timeline: scroll()')
const iosVersion = () => navigator.userAgent.match(/OS (\d+)_(\d+)/)?.slice(1).join('.') ?? '-'

interface Stats { frames: number, scrolls: number, worst: number, scene: string, timeline: boolean, ios: string }

export default function PerfDebug() {
    const [enabled, setEnabled] = useState(false)
    const [stats, setStats] = useState<Stats>()
    const [on, setOn] = useState<string[]>([])

    // Read after hydrating, so the server and the first client render agree on rendering nothing
    useEffect(() => { setEnabled(new URLSearchParams(location.search).get('debug') === 'perf') }, [])

    useEffect(() => {
        if (!enabled) return
        let frames = 0, scrolls = 0, worst = 0, last = 0, raf = 0
        const tick = (now: number) => {
            if (last) worst = Math.max(worst, now - last)
            last = now
            frames++
            raf = requestAnimationFrame(tick)
        }
        const onScroll = () => { scrolls++ }
        raf = requestAnimationFrame(tick)
        window.addEventListener('scroll', onScroll, { passive: true })
        const every = window.setInterval(() => {
            setStats({ frames, scrolls, worst: Math.round(worst), scene: document.documentElement.dataset.scene ?? '', timeline: timelines(), ios: iosVersion() })
            frames = 0
            scrolls = 0
            worst = 0
        }, 1000)
        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener('scroll', onScroll)
            clearInterval(every)
        }
    }, [enabled])

    useEffect(() => {
        if (enabled) document.documentElement.dataset.debug = on.join(' ')
    }, [enabled, on])

    // The CSS parallax maps the whole scroll range onto each layer's movement, so it needs that range in pixels
    useEffect(() => {
        if (!enabled) return
        const root = document.documentElement
        const measure = () => root.style.setProperty('--scroll-max', String(root.scrollHeight - window.innerHeight))
        const observer = new ResizeObserver(measure)
        measure()
        observer.observe(document.body)
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [enabled])

    if (!enabled) return null

    const toggle = (token: string) => setOn(now => now.includes(token) ? now.filter(t => t !== token) : [...now, token])

    return (
        <div className='fixed left-2 top-2 z-[200] w-44 rounded-lg bg-black/85 p-2 font-mono text-[11px] leading-snug text-white'>
            <div>frames/s&nbsp; {stats?.frames ?? '-'}</div>
            <div>scrolls/s {stats?.scrolls ?? '-'}</div>
            <div>worst ms&nbsp; {stats?.worst ?? '-'}</div>
            <div className='truncate'>tier&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; {stats ? stats.scene || '(still)' : '-'}</div>
            <div>timeline&nbsp; {stats ? (stats.timeline ? 'yes' : 'no') : '-'}</div>
            <div>iOS&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; {stats?.ios ?? '-'}</div>
            <div className='mt-2 flex flex-col gap-1'>
                {SWITCHES.map(({ token, label }) => (
                    <button key={token} onClick={() => toggle(token)}
                        className={`rounded px-2 py-1 text-left ${on.includes(token) ? 'bg-emerald-600' : 'bg-white/15'}`}>
                        {on.includes(token) ? 'ON ' : 'off'} {label}
                    </button>
                ))}
            </div>
        </div>
    )
}
