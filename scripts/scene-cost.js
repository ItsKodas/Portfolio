// What the hero scene costs the compositor, per part. Paste into the browser console on the home page, at the top
// of the page, with the viewport set to whatever device you're measuring for.
//
// It prints overdraw in viewports and a count of composited layers, which are the two numbers TIERS in
// app/perf/tiers.ts is built from. Overdraw is very nearly viewport independent, so a figure measured at one size
// holds at another; the layer count matters on its own because every layer costs at least one backing tile however
// small it is.
//
// Load with ?scene=depth+sky+water+forest to measure the whole scene, or with a shorter token list to measure what a
// given tier adds. The difference between two runs is a tier's cost.

;(() => {
    const vw = innerWidth, vh = innerHeight
    const parts = {}

    for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el)
        // Anything the browser has to give its own layer: a running transform/opacity animation, or an explicit hint
        if (style.animationName === 'none' && style.willChange === 'auto') continue

        const box = el.getBoundingClientRect()
        if (!box.width || !box.height) continue

        // Which css module named this element. art_ and parallax_ are shared wrappers, so fall through to the
        // scene module on the element itself, or failing that on the nearest labelled ancestor.
        const named = node => {
            const cls = (node.className.baseVal ?? node.className ?? '').toString()
            return [...cls.matchAll(/([a-z]+)_[A-Za-z]+__/g)].map(m => m[1])
        }
        const own = named(el)
        let key = own.find(m => m !== 'art' && m !== 'parallax') || own[0] || 'other'
        if (key === 'art') {
            for (let p = el.parentElement; p && key === 'art'; p = p.parentElement) {
                key = named(p).find(m => m !== 'art' && m !== 'parallax') || 'art'
            }
        }

        const w = Math.max(0, Math.min(box.right, vw) - Math.max(box.left, 0))
        const h = Math.max(0, Math.min(box.bottom, vh) - Math.max(box.top, 0))
        const part = parts[key] || (parts[key] = { layers: 0, px: 0 })
        part.layers++
        if (w > 0 && h > 0) part.px += w * h
    }

    const rows = Object.entries(parts)
        .map(([part, p]) => ({ part, layers: p.layers, overdraw: +(p.px / (vw * vh)).toFixed(2) }))
        .sort((a, b) => b.overdraw - a.overdraw)

    console.log(`${vw}x${vh} at dpr ${devicePixelRatio}, scene "${document.documentElement.dataset.scene}"`)
    console.table(rows)
    console.log('totals', {
        layers: rows.reduce((s, r) => s + r.layers, 0),
        overdraw: +rows.reduce((s, r) => s + r.overdraw, 0).toFixed(2),
    })
})()
