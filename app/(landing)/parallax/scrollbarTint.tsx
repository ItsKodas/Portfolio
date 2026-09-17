'use client'

import { useEffect } from 'react'

// Tints the scrollbar to suit whatever part of the page is on screen: dusky periwinkle over the sky, valley blue as the
// mountains pass, then the forest's deep navy through the content and the campfire scene at the end. The colour is
// blended between stops by how far down the page you are, and kept muted so the bar never stands out.

const STOPS: [number, [number, number, number]][] = [
    [0, [92, 104, 160]],    // sky
    [0.22, [62, 88, 146]],  // valley and lake
    [0.42, [42, 56, 98]],   // forest floor
    [0.8, [40, 50, 92]],    // content
    [1, [52, 60, 104]],     // campfire scene
]

function colourAt(p: number) {
    const i = Math.max(1, STOPS.findIndex(([at]) => at >= p))
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i] ?? STOPS[STOPS.length - 1]
    const t = b === a ? 0 : Math.min(Math.max((p - a) / (b - a), 0), 1)
    const [r, g, bl] = ca.map((v, k) => Math.round(v + (cb[k] - v) * t))
    return `rgb(${r}, ${g}, ${bl})`
}

export default function ScrollbarTint() {
    useEffect(() => {
        const root = document.documentElement
        let frame = 0
        const update = () => {
            frame = 0
            const max = root.scrollHeight - window.innerHeight
            root.style.setProperty('--scrollbar-thumb', colourAt(max > 0 ? window.scrollY / max : 0))
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
        update()
        window.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('resize', onScroll)
        return () => {
            window.removeEventListener('scroll', onScroll)
            window.removeEventListener('resize', onScroll)
            if (frame) cancelAnimationFrame(frame)
            root.style.removeProperty('--scrollbar-thumb')
        }
    }, [])

    return null
}
