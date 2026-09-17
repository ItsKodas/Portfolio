'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

import styles from './curtain.module.css'
import { CURTAIN_NOTE } from './curtainNote'

// A plain cover in the night's navy over the scene while its images load, so the layers don't pop in one by one, then
// fading away to show the whole scene at once. It's sent with the page, so it's there from the first paint. Anything
// waiting for the scene to be seen (the logo's intro, the frame-rate check) follows useRevealed.

const MAX_WAIT_MS = 5000 // never leave anyone looking at a blank screen for longer than this
const FADE_MS = 800
const QUICK_FADE_MS = 200 // for reduced motion

let revealed = false
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

function reveal() {
    if (revealed) return
    revealed = true
    listeners.forEach(l => l())
}

// Whether the curtain has started lifting (it stays lifted for the rest of the visit)
export function useRevealed() {
    return useSyncExternalStore(subscribe, () => revealed, () => false)
}

// Resolves once an image has loaded and decoded (or failed; a broken image shouldn't hold the curtain)
const settled = (img: HTMLImageElement) => img.decode().catch(() => {})

// Every image the scene shows on arrival: the eager <img>s (lazy ones are further down the page and only load when
// scrolled to, so waiting on them would always hit the limit), the images inside the inline svgs, and the font
function sceneLoaded() {
    const imgs = Array.from(document.images).filter(img => img.loading !== 'lazy')
    const svgImages = Array.from(document.querySelectorAll('svg image')).map(el => {
        const img = new Image()
        img.src = (el as SVGImageElement).href.baseVal
        return img
    })
    return Promise.all([...imgs, ...svgImages].map(settled).concat(document.fonts.ready.then(() => {})))
}

export default function SceneCurtain() {
    const lifted = useRevealed()
    const [gone, setGone] = useState(lifted)

    useEffect(() => {
        if (revealed) return
        let cancelled = false
        const lift = () => { if (!cancelled) reveal() }

        const limit = window.setTimeout(lift, MAX_WAIT_MS)
        // (a frame's wait first, so a switch to the full hero straight after hydrating has put its own images in)
        const frame = requestAnimationFrame(() => { sceneLoaded().then(lift) })

        return () => {
            cancelled = true
            clearTimeout(limit)
            cancelAnimationFrame(frame)
        }
    }, [])

    useEffect(() => {
        if (!lifted || gone) return
        const quick = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        const timer = window.setTimeout(() => setGone(true), quick ? QUICK_FADE_MS : FADE_MS)
        return () => clearTimeout(timer)
    }, [lifted, gone])

    if (gone) return null

    return (
        <>
            {/* Without scripts nothing would ever lift it */}
            <noscript><style>{`.${styles.curtain} { display: none; }`}</style></noscript>
            <div className={`${styles.curtain} ${lifted ? styles.lifted : ''}`} role="status" aria-label="Loading">
                <Hills />
                <Note />
            </div>
        </>
    )
}

// Hills in a small window of the scene, from the far lilac range to the dark near slopes (each drawn past the bottom of
// the window, so bobbing up never shows its lower edge)
const HILLS = [
    { top: 'M0 30 Q10 26 18 18 Q24 12 30 16 Q40 22 48 14 Q56 8 64 18 Q68 24 72 26', fill: '#b597cc' },
    { top: 'M0 36 Q12 32 22 26 Q30 21 38 28 Q48 36 58 28 Q66 23 72 30', fill: '#4f6fb3' },
    { top: 'M0 42 Q14 36 28 38 Q42 41 52 35 Q62 30 72 37', fill: '#1c2753' },
]

// The loading spinner: layered paper hills, rising one after another from the back like the hero's layers
function Hills() {
    return (
        <svg className={styles.hills} viewBox="0 0 72 48" aria-hidden>
            <defs>
                <clipPath id="curtainWindow"><rect width="72" height="48" rx="14" /></clipPath>
            </defs>
            <g clipPath="url(#curtainWindow)">
                <rect width="72" height="48" fill="#111a38" />
                {HILLS.map(({ top, fill }, i) => (
                    <g key={i} className={styles.hill} style={{ animationDelay: `${i * 0.18}s` }}>
                        <path d={`${top} L72 60 L0 60Z`} fill={fill} />
                        {/* The paper's lit top edge */}
                        <path d={top} fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1" />
                    </g>
                ))}
            </g>
            <rect x="0.5" y="0.5" width="71" height="47" rx="13.5" fill="none" stroke="#8fd4f5" strokeOpacity="0.12" />
        </svg>
    )
}

// When the pen starts on the loading message, and how long between letters (the dots then pulse in turn once written)
const WRITE_START = 0.35
const LETTER_GAP = 0.055
const writtenBy = WRITE_START + CURTAIN_NOTE.glyphs.length * LETTER_GAP + 0.4

// The loading message, handwritten like the hero's note: each letter traced with a pen stroke and then filled
function Note() {
    let dot = 0
    return (
        <svg className={styles.note} viewBox={CURTAIN_NOTE.viewBox} aria-hidden>
            {CURTAIN_NOTE.glyphs.map((g, i) => {
                const start = WRITE_START + i * LETTER_GAP
                const delays = [start, start + 0.28]
                if (g.char === '.') delays.push(writtenBy + dot++ * 0.25)
                return (
                    <path key={i} className={g.char === '.' ? `${styles.glyph} ${styles.dot}` : styles.glyph} d={g.d} pathLength={1}
                        style={{ animationDelay: delays.map(d => `${d.toFixed(3)}s`).join(', ') }} />
                )
            })}
        </svg>
    )
}
