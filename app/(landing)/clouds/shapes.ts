// Procedural clouds painted the same way as the original artwork: overlapping domes in close tones,
// with one soft vertical gradient over the whole cloud (light at the bottom, darker towards the top,
// like the mountains). Plain vector shapes, no filters, so edges stay smooth and crisp at any size.
// Returned as SVG data URIs so the browser rasterises each one once and then only moves it.

export interface CloudPalette {
    back: string[]   // billows furthest back, the most saturated
    middle: string[]
    front: string[]  // nearest billows, lighter and greyer
    warmth: string   // low glow near the base
    tail: string     // the thin end of the cloud drifts towards this tone
    sky: string      // the sky behind the clouds, which every tone is pulled towards
}

// Sampled from the original clouds.png
export const WARM: CloudPalette = {
    back: ['#c885a7', '#cd8bab'],
    middle: ['#db8faf', '#d78fae', '#d38bb0'],
    front: ['#bc99ae', '#d58db0', '#c98fb2', '#c793b4'],
    warmth: '#e874b1',
    tail: '#a695b9',
    sky: '#9479ae',
}

export const COOL: CloudPalette = {
    back: ['#1e95aa', '#4babc5'],
    middle: ['#58afcb', '#58c4d7', '#4782a8'],
    front: ['#5fa6be', '#5ca5c4', '#599aba', '#5f96b5'],
    warmth: '#5887b2',
    tail: '#5483a2',
    sky: '#5a86b6',
}

export const CLOUD_WIDTH  = 1600
export const CLOUD_HEIGHT = 1000

// Where the billows sit. Below this the cloud is a solid body that reaches down behind the mountains
export const BASE_Y = 640

const LIGHTEN = 0.18 // base of the cloud
const DARKEN  = 0.22 // top of the cloud
const BLEND   = 0.35 // how far each billow's tone is pulled towards the cloud's main colour

// Depth: back billows darker, front billows lighter, and each billow casts a soft band of shadow
// onto the one behind it
const ROW_SHADE = [-0.07, 0, 0.05]
const CAST_SHADOW = 0.14

// Blending into the scene like the original art: tones pulled towards the sky, slightly see-through,
// and fading out towards the base so the clouds dissolve into the haze above the mountains
const SKY_BLEND = 0.25
const OPACITY   = 0.95
const FADE_FROM = 0.5  // fraction of the way down from the cloud tops where the fade begins

// Small seeded PRNG so a seed always gives the same cloud (server and client must match)
function random(seed: number) {
    let t = seed * 9973 + 0x6d2b79f5
    return () => {
        t = (t + 0x6d2b79f5) | 0
        let r = Math.imul(t ^ (t >>> 15), 1 | t)
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296
    }
}

// Mix a hex colour towards white (amount > 0) or black (amount < 0)
function shade(hex: string, amount: number) {
    const target = amount > 0 ? 255 : 0
    const mix = Math.abs(amount)
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    return '#' + channels.map(c => Math.round(c + (target - c) * mix).toString(16).padStart(2, '0')).join('')
}

// Mix two hex colours; amount 0 = a, 1 = b
function mix(a: string, b: string, amount: number) {
    const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    const [ca, cb] = [channels(a), channels(b)]
    return '#' + ca.map((c, i) => Math.round(c + (cb[i] - c) * amount).toString(16).padStart(2, '0')).join('')
}

type Point = [number, number]

// Catmull-Rom through the points, as a closed cubic Bézier path
function smoothPath(points: Point[]) {
    const n = points.length
    let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`
    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
        const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
        const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
        d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
    }
    return d + 'Z'
}

// A lopsided dome with an organic outline (a broad wobble plus fine scallops), whose bottom extends
// down behind the billows in front of it
function dome(rand: () => number, cx: number, base: number, width: number, height: number) {
    const lean = (rand() - 0.5) * 0.35
    const broad = { amount: 0.025 + rand() * 0.03, frequency: 3 + Math.floor(rand() * 2), phase: rand() * Math.PI * 2 }
    const fine = { amount: 0.008 + rand() * 0.01, frequency: 9 + Math.floor(rand() * 6), phase: rand() * Math.PI * 2 }
    const points: Point[] = []
    const steps = 36

    for (let i = 0; i <= steps; i++) {
        const theta = Math.PI * (1 - i / steps)
        const bump = 1
            + broad.amount * Math.sin(theta * broad.frequency + broad.phase)
            + fine.amount * Math.sin(theta * fine.frequency + fine.phase)
        const x = cx + (width / 2) * Math.cos(theta) * bump
        const y = base - height * Math.pow(Math.sin(theta), 0.7) * bump * (1 + lean * Math.cos(theta))
        points.push([x, y])
    }
    points.push([cx + width * 0.45, base + height * 0.5], [cx - width * 0.45, base + height * 0.5])
    return smoothPath(points)
}

interface Dome { path: string, color: string, row: number, cx: number, base: number, height: number }

function composition(seed: number, palette: CloudPalette) {
    const rand = random(seed)
    // Long banks that build up towards one end and trail off into a thinner tail
    const tailOnRight = rand() < 0.5
    const peak = tailOnRight ? 0.2 + rand() * 0.15 : 0.65 + rand() * 0.15
    const maxHeight = 250 + rand() * 90
    const envelope = (t: number) => {
        const towardsTail = tailOnRight ? t > peak : t < peak
        const distance = Math.abs(t - peak)
        return towardsTail ? Math.max(0.35, 1 - distance * 1.1) : Math.max(0.45, 1 - (distance / 0.25) ** 2 * 0.6)
    }
    const pick = (list: string[]) => list[Math.floor(rand() * list.length)]

    const domes: Dome[] = []

    // One continuous body underneath, reaching the bottom of the canvas so no sky shows below the cloud
    const tone = (color: string) => mix(color, palette.sky, SKY_BLEND)
    const bodyColor = tone(pick(palette.middle))
    const top: Point[] = []
    for (let i = 0; i <= 24; i++) {
        const t = 0.04 + (0.92 * i) / 24
        top.push([t * CLOUD_WIDTH, BASE_Y - maxHeight * envelope(t) * (0.42 + rand() * 0.08)])
    }
    domes.push({
        path: smoothPath([...top, [CLOUD_WIDTH * 0.95, BASE_Y + 120], [CLOUD_WIDTH * 0.9, CLOUD_HEIGHT], [CLOUD_WIDTH * 0.1, CLOUD_HEIGHT], [CLOUD_WIDTH * 0.05, BASE_Y + 120]]),
        color: bodyColor,
        row: -1, cx: 0, base: BASE_Y, height: 0,
    })

    const row = (depth: number, count: number, from: number, to: number, baseLift: number, heightScale: number, tones: string[], widthScale: number) => {
        for (let i = 0; i < count; i++) {
            const t = from + (to - from) * (count === 1 ? 0.5 : i / (count - 1)) + (rand() - 0.5) * 0.08
            const env = envelope(t)
            const height = maxHeight * env * heightScale * (0.65 + rand() * 0.6)
            const width = Math.max(height * (1.4 + rand() * 1.1), 120) * widthScale
            const cx = Math.min(Math.max(t * CLOUD_WIDTH, width / 2 + 30), CLOUD_WIDTH - width / 2 - 30)
            const base = BASE_Y - baseLift * maxHeight * env
            const color = shade(mix(tone(pick(tones)), bodyColor, BLEND), ROW_SHADE[depth])
            domes.push({ path: dome(rand, cx, base, width, height), color, row: depth, cx, base, height })
        }
    }

    // Back to front
    row(0, 2 + Math.floor(rand() * 3), peak - 0.1, peak + 0.1, 0.5, 0.75, palette.back, 0.9)
    row(1, 5 + Math.floor(rand() * 3), 0.1, 0.9, 0.25, 0.7, palette.middle, 1)
    row(2, 7 + Math.floor(rand() * 3), 0.05, 0.95, 0, 0.5, palette.front, 1)

    return {
        domes,
        haze: shade(bodyColor, LIGHTEN),
        warmthColor: tone(palette.warmth),
        tailColor: tone(palette.tail),
        shadow: shade(bodyColor, -DARKEN),
        top: BASE_Y - maxHeight * 1.05,
        warmth: { x: (tailOnRight ? 0.25 : 0.75) * CLOUD_WIDTH, y: BASE_Y - 20, rx: 380, ry: 150 },
        tailOnRight,
    }
}

export function cloudSvg(seed: number, palette: CloudPalette) {
    const c = composition(seed, palette)

    const paths = c.domes.map(d => {
        const fill = `<path d="${d.path}" fill="${d.color}"/>`
        if (d.row < 1) return fill
        // The same outline, nudged up and slightly larger, drawn just before the billow: only a thin
        // band shows above its edge, darkening the billow behind
        const lift = d.height * 0.07
        const shadow = `<g clip-path="url(#shape)"><path d="${d.path}" fill="${c.shadow}" opacity="${CAST_SHADOW}" transform="translate(${d.cx.toFixed(1)} ${(d.base - lift).toFixed(1)}) scale(1.04 1.06) translate(${(-d.cx).toFixed(1)} ${(-d.base).toFixed(1)})"/></g>`
        return shadow + fill
    }).join('')
    const silhouette = c.domes.map(d => `<path d="${d.path}"/>`).join('')

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CLOUD_WIDTH} ${CLOUD_HEIGHT}">
<defs>
<linearGradient id="light" x1="0" y1="${c.top.toFixed(0)}" x2="0" y2="${BASE_Y}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c.shadow}" stop-opacity="0.4"/><stop offset="0.5" stop-color="${c.shadow}" stop-opacity="0"/><stop offset="0.5" stop-color="${c.haze}" stop-opacity="0"/><stop offset="1" stop-color="${c.haze}" stop-opacity="0.7"/></linearGradient>
<clipPath id="shape">${silhouette}</clipPath>
<radialGradient id="warmth"><stop offset="0" stop-color="${c.warmthColor}" stop-opacity="0.45"/><stop offset="1" stop-color="${c.warmthColor}" stop-opacity="0"/></radialGradient>
<linearGradient id="tail" x1="${c.tailOnRight ? 0.45 : 0.55}" x2="${c.tailOnRight ? 1 : 0}" y1="0" y2="0"><stop offset="0" stop-color="${c.tailColor}" stop-opacity="0"/><stop offset="1" stop-color="${c.tailColor}" stop-opacity="0.6"/></linearGradient>
<linearGradient id="fade" x1="0" y1="${c.top.toFixed(0)}" x2="0" y2="${(BASE_Y + 40).toFixed(0)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="${FADE_FROM}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
<mask id="soften"><rect width="${CLOUD_WIDTH}" height="${CLOUD_HEIGHT}" fill="url(#fade)"/></mask>
</defs>
<g mask="url(#soften)" opacity="${OPACITY}">
${paths}
<g clip-path="url(#shape)">
<ellipse cx="${c.warmth.x.toFixed(0)}" cy="${c.warmth.y.toFixed(0)}" rx="${c.warmth.rx}" ry="${c.warmth.ry}" fill="url(#warmth)"/>
<rect width="${CLOUD_WIDTH}" height="${CLOUD_HEIGHT}" fill="url(#light)"/>
<rect width="${CLOUD_WIDTH}" height="${CLOUD_HEIGHT}" fill="url(#tail)"/>
</g>
</g>
</svg>`

    return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
