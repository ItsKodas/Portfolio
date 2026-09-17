'use client'

import { useEffect } from 'react'

// Tints the scrollbar to suit whatever part of the page is on screen: dusky periwinkle over the sky, valley blue as the
// mountains pass, then the forest's deep navy through the content and the campfire scene at the end. The colour is
// blended between stops by how far down the page you are, and kept muted so the bar never stands out.
//
// The colour is written into a small stylesheet of its own that only styles the scrollbar. (Setting it as a custom
// property on the page root instead makes the browser restyle every element, and restart the sampling of every running
// animation, on each scroll frame, which made scrolling stutter.)

const STOPS: [number, [number, number, number]][] = [
    [0, [92, 104, 160]],    // sky
    [0.22, [62, 88, 146]],  // valley and lake
    [0.42, [42, 56, 98]],   // forest floor
    [0.8, [40, 50, 92]],    // content
    [1, [52, 60, 104]],     // campfire scene
]

function colourAt(p: number, lighten = 0) {
    const i = Math.max(1, STOPS.findIndex(([at]) => at >= p))
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i] ?? STOPS[STOPS.length - 1]
    const t = b === a ? 0 : Math.min(Math.max((p - a) / (b - a), 0), 1)
    const [r, g, bl] = ca.map((v, k) => Math.round(v + (cb[k] - v) * t + (255 - v) * lighten))
    return `rgb(${r}, ${g}, ${bl})`
}

export default function ScrollbarTint() {
    useEffect(() => {
        const root = document.documentElement
        // Firefox only understands scrollbar-color (and scrollbar-color lives on the root, so there it is only set when
        // the colour actually changes)
        const firefox = CSS.supports('-moz-appearance', 'none')
        const sheet = new CSSStyleSheet()
        sheet.insertRule('::-webkit-scrollbar-thumb {}', 0)
        sheet.insertRule('::-webkit-scrollbar-thumb:hover {}', 1)
        if (firefox) sheet.insertRule('html {}', 2)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        const [thumb, hover, html] = [...sheet.cssRules] as CSSStyleRule[]

        let frame = 0, last = ''
        const update = () => {
            frame = 0
            const max = root.scrollHeight - window.innerHeight
            const p = max > 0 ? window.scrollY / max : 0
            const colour = colourAt(p)
            if (colour === last) return
            last = colour
            thumb.style.backgroundColor = colour
            hover.style.backgroundColor = colourAt(p, 0.18)
            if (html) html.style.setProperty('scrollbar-color', `${colour} #0b101f`)
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
        update()
        window.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('resize', onScroll)
        return () => {
            window.removeEventListener('scroll', onScroll)
            window.removeEventListener('resize', onScroll)
            if (frame) cancelAnimationFrame(frame)
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet)
        }
    }, [])

    return null
}
