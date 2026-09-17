import { ArtCanvas, Piece, PieceSvg, originIn, acrossX, type Box } from '../parallax/art'
import Island from './island.svg'
import { LAKE_OUTLINE } from './lake'
import styles from './water.module.css'

// The lake over the valley: water continued down behind the trees, a light rim along the shore, ripples lapping at the
// shoreline, streaks gliding across the water, the island, a small fishing boat with a lantern, and fog drifting over
// the far shore. Placed in the parallax art's 3840x4320 canvas, so it lines up with the valley.
//
// The still water and the island are plain svg; everything that moves is its own layer, moved with transform and
// opacity only (the ripples and streaks are kept to the lake by a mask on their container), so the graphics card
// animates them without repainting.

interface Streak {
    x: number        // left end
    y: number
    length: number
    thickness: number
    opacity: number
    drift: number    // how far it glides back and forth
    duration: number // seconds per glide
    delay: number
}

// Placed where the brush streaks sit in the original painting
const STREAKS: Streak[] = [
    { x: 1480, y: 1690, length: 520, thickness: 7,  opacity: 0.45, drift: 70, duration: 11, delay: 0 },
    { x: 1250, y: 1725, length: 600, thickness: 9,  opacity: 0.5,  drift: 90, duration: 14, delay: -4 },
    { x: 1920, y: 1732, length: 530, thickness: 8,  opacity: 0.45, drift: 60, duration: 12, delay: -7 },
    { x: 2100, y: 1760, length: 400, thickness: 6,  opacity: 0.4,  drift: 80, duration: 10, delay: -2 },
    { x: 2150, y: 1788, length: 370, thickness: 7,  opacity: 0.45, drift: 55, duration: 13, delay: -9 },
    { x: 1500, y: 1815, length: 290, thickness: 6,  opacity: 0.4,  drift: 65, duration: 9,  delay: -5 },
    { x: 1550, y: 1860, length: 170, thickness: 5,  opacity: 0.35, drift: 45, duration: 8,  delay: -3 },
    { x: 2200, y: 1850, length: 200, thickness: 5,  opacity: 0.4,  drift: 50, duration: 9,  delay: -6 },
    { x: 1800, y: 1872, length: 410, thickness: 8,  opacity: 0.5,  drift: 85, duration: 15, delay: -1 },
    { x: 2250, y: 1890, length: 110, thickness: 4,  opacity: 0.35, drift: 35, duration: 7,  delay: -8 },
    { x: 1350, y: 1770, length: 240, thickness: 5,  opacity: 0.3,  drift: 60, duration: 12, delay: -10 },
    { x: 2380, y: 1712, length: 260, thickness: 5,  opacity: 0.3,  drift: 55, duration: 11, delay: -6 },
]

// Tapered brush stroke: pointed at both ends, widest a little left of centre
const strokePath = ({ x, y, length, thickness }: Streak) => {
    const mid = x + length * 0.42, end = x + length, half = thickness / 2
    return `M${x} ${y} Q${mid} ${y - half * 2} ${end} ${y} Q${mid} ${y + half * 2} ${x} ${y}Z`
}

// ── Shoreline ripples ─────────────────────────────────────────────────────────
// Tapered strokes like the water streaks, laid along the shore a little way out on the water

const LAKE_CENTRE = [1900, 1800]

// Crest of the valley's right hill (from build_valley.js), raised a bit, from the water arm on: the water running on
// behind the hill gets no shore rim or ripples
const RIGHT_HILL_EDGE = 'M2560 4320 L2560 1800 L2660 1730 L2700 1660 L2780 1638 L2830 1626 L2870 1592 L2920 1546 L2980 1482 L3040 1430 L3100 1372 L3200 1265 L3232 1225 L3300 1176 L3345 1164 L3395 1115 L3480 1100 L3520 1088 L3840 1002 L3840 4320Z'
const SHORE = [...LAKE_OUTLINE.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])])

// Cumulative distance along the shoreline, for placing strokes at even spacing
const SHORE_DIST = SHORE.reduce<number[]>((acc, p, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + Math.hypot(p[0] - SHORE[i - 1][0], p[1] - SHORE[i - 1][1]))
    return acc
}, [])
const SHORE_LENGTH = SHORE_DIST[SHORE_DIST.length - 1]

const pointAt = (d: number) => {
    d = ((d % SHORE_LENGTH) + SHORE_LENGTH) % SHORE_LENGTH
    let i = 1
    while (i < SHORE_DIST.length - 1 && SHORE_DIST[i] < d) i++
    const t = (d - SHORE_DIST[i - 1]) / Math.max(1e-6, SHORE_DIST[i] - SHORE_DIST[i - 1])
    return [SHORE[i - 1][0] + (SHORE[i][0] - SHORE[i - 1][0]) * t, SHORE[i - 1][1] + (SHORE[i][1] - SHORE[i - 1][1]) * t]
}

// Push a shore point out onto the water, towards the middle of the lake (flattened, the lake is wide and shallow)
const inward = ([x, y]: number[], by: number) => {
    const dx = LAKE_CENTRE[0] - x, dy = (LAKE_CENTRE[1] - y) * 3
    const len = Math.hypot(dx, dy) || 1
    return [x + (dx / len) * by, y + (dy / len) * by * 0.35]
}

function rippleRing(offset: number, spacing: number, phase: number, seed: number) {
    const strokes: string[] = []
    let n = 0
    for (let d = phase; d < SHORE_LENGTH + phase; d += spacing) {
        const r = Math.abs(Math.sin(seed * 12.9898 + n++ * 78.233)) // stable pseudo-random 0..1
        const length = 50 + r * 110, thickness = 4 + r * 4
        const a = inward(pointAt(d - length / 2), offset), b = inward(pointAt(d + length / 2), offset), c = inward(pointAt(d), offset)
        // Skip the far shore under the fog bank, and anything above the waterline
        if (c[1] < 1720) continue
        const nx = -(b[1] - a[1]), ny = b[0] - a[0], nl = Math.hypot(nx, ny) || 1
        const ox = (nx / nl) * thickness, oy = (ny / nl) * thickness
        strokes.push(`M${a[0].toFixed(0)} ${a[1].toFixed(0)}Q${(c[0] + ox).toFixed(0)} ${(c[1] + oy).toFixed(0)} ${b[0].toFixed(0)} ${b[1].toFixed(0)}Q${(c[0] - ox).toFixed(0)} ${(c[1] - oy).toFixed(0)} ${a[0].toFixed(0)} ${a[1].toFixed(0)}Z`)
    }
    return strokes.join('')
}

const RIPPLES = [
    { d: rippleRing(28, 170, 0, 1),   opacity: 0.55, delay: 0 },
    { d: rippleRing(70, 230, 90, 2),  opacity: 0.4,  delay: -2.4 },
    { d: rippleRing(120, 300, 40, 3), opacity: 0.28, delay: -4.8 },
]

// ── Layers ────────────────────────────────────────────────────────────────────

// The water: the lake's outline, plus the strip under the fog bank that the streaks may also cross
const WATER_BOX: Box = { x: 1140, y: 1630, w: 1570, h: 390 }

// A mask for a piece covering WATER_BOX, as a css mask image (white shows, black hides)
const maskOf = (shapes: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${WATER_BOX.x} ${WATER_BOX.y} ${WATER_BOX.w} ${WATER_BOX.h}" preserveAspectRatio="none">${shapes}</svg>`
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    return { maskImage: url, WebkitMaskImage: url } as React.CSSProperties
}
// Ripples stay on the lake, and off the water running on behind the right hill; streaks may also cross the far water
// under the fog bank
const RIPPLE_MASK = maskOf(`<path d="${LAKE_OUTLINE}" fill="#fff"/><path d="${RIGHT_HILL_EDGE}" fill="#000"/>`)
const STREAK_MASK = maskOf(`<path d="${LAKE_OUTLINE}" fill="#fff"/><path d="M1300 1640 L2700 1640 L2700 1702 L1300 1702Z" fill="#fff"/>`)

const RIPPLE_ORIGIN = originIn(WATER_BOX, LAKE_CENTRE[0], LAKE_CENTRE[1])

// A box's place within another box (for pieces nested inside a piece)
const within = (outer: Box, box: Box): React.CSSProperties => ({
    position: 'absolute',
    left: `${((box.x - outer.x) / outer.w * 100).toFixed(4)}%`, top: `${((box.y - outer.y) / outer.h * 100).toFixed(4)}%`,
    width: `${(box.w / outer.w * 100).toFixed(4)}%`, height: `${(box.h / outer.h * 100).toFixed(4)}%`,
})

const STREAK_PIECES = STREAKS.map(s => {
    const box: Box = { x: s.x, y: s.y - s.thickness, w: s.length, h: s.thickness * 2 }
    return {
        s, box,
        style: { '--drift': acrossX(box, s.drift), '--opacity': s.opacity, animationDuration: `${s.duration}s`, animationDelay: `${s.delay}s` } as React.CSSProperties,
    }
})

// Fog: three banks of soft ellipses, each drifting slowly over the water as a whole
const FOG_GRADIENT = (id: string) => (
    <radialGradient id={id}>
        <stop offset="0" stopColor="#cdeaff" stopOpacity="0.75" />
        <stop offset="0.45" stopColor="#b3dcfb" stopOpacity="0.4" />
        <stop offset="1" stopColor="#9fd0f5" stopOpacity="0" />
    </radialGradient>
)
const FOG_BANKS: { slow: boolean, ellipses: [number, number, number, number, number][] }[] = [
    // Along the far shore, where the water meets the ridges: a tall, soft layer so the ridges' bases dissolve into it
    {
        slow: true, ellipses: [
            [1850, 1650, 1000, 120, 0.6], [1300, 1660, 650, 95, 0.5], [2350, 1655, 420, 95, 0.5],
            [1850, 1668, 850, 46, 0.7], [1500, 1690, 700, 38, 0.5], [2300, 1682, 400, 36, 0.5],
        ],
    },
    // Rolling out from the base of the island
    { slow: false, ellipses: [[1990, 1852, 560, 48, 1], [1880, 1880, 920, 78, 0.55], [2250, 1838, 380, 42, 0.5]] },
    { slow: true, ellipses: [[1600, 1905, 700, 60, 0.4], [2150, 1790, 480, 40, 0.3]] },
]

const FOG_PIECES = FOG_BANKS.map(bank => {
    const pad = 20
    const x1 = Math.min(...bank.ellipses.map(([cx, , rx]) => cx - rx)) - pad, x2 = Math.max(...bank.ellipses.map(([cx, , rx]) => cx + rx)) + pad
    const y1 = Math.min(...bank.ellipses.map(([, cy, , ry]) => cy - ry)) - pad, y2 = Math.max(...bank.ellipses.map(([, cy, , ry]) => cy + ry)) + pad
    const box: Box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    return { ...bank, box, style: { '--fog': acrossX(box, 60) } as React.CSSProperties }
})

// The fishing boat, drawn at a quarter size around (1560, 1795)
const BOAT = { x: 1560, y: 1795, scale: 0.25 }
const BOAT_BOX: Box = { x: BOAT.x - 18, y: BOAT.y - 32, w: 42, h: 44 }
const boat = (children: React.ReactNode) => <g transform={`translate(${BOAT.x} ${BOAT.y}) scale(${BOAT.scale})`}>{children}</g>

export default function Water() {
    return (
        <ArtCanvas>
            {/* The still water */}
            <svg className={styles.full} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice">
                <defs>
                    <clipPath id="lakeClip"><path d={LAKE_OUTLINE} /></clipPath>
                    {/* Everything except a strip along the right hill, so the shore rim doesn't outline the water where it
                        runs on behind the hill (it should look like it continues, not stop at a shoreline) */}
                    <clipPath id="notRightHill"><path clipRule="evenodd" d={`M0 0 H3840 V4320 H0Z ${RIGHT_HILL_EDGE}`} /></clipPath>
                    {/* The water fill is only needed behind the trees; above that the valley layer already shows the lake */}
                    <linearGradient id="behindTrees" gradientUnits="userSpaceOnUse" x1="0" y1="1870" x2="0" y2="1905">
                        <stop offset="0" stopColor="#fff" stopOpacity="0" />
                        <stop offset="1" stopColor="#fff" stopOpacity="1" />
                    </linearGradient>
                    <mask id="behindTreesMask"><rect x="0" y="1600" width="3840" height="500" fill="url(#behindTrees)" /></mask>
                    {/* Water colour sampled from the valley layer, used to continue the lake down behind the trees */}
                    <linearGradient id="waterFill" gradientUnits="userSpaceOnUse" x1="0" y1="1680" x2="0" y2="1900">
                        <stop offset="0" stopColor="#3e93d4" />
                        <stop offset="0.45" stopColor="#3f9bdb" />
                        <stop offset="1" stopColor="#338dd1" />
                    </linearGradient>
                    {/* Shore rim fades out towards the far shore, where the fog bank takes over */}
                    <linearGradient id="shoreRim" gradientUnits="userSpaceOnUse" x1="0" y1="1705" x2="0" y2="1790">
                        <stop offset="0" stopColor="#a9e0fc" stopOpacity="0" />
                        <stop offset="1" stopColor="#a9e0fc" stopOpacity="1" />
                    </linearGradient>
                </defs>
                {/* The lake, continued down behind the forest so water shows between the tree tips */}
                <path d={LAKE_OUTLINE} fill="url(#waterFill)" mask="url(#behindTreesMask)" />
                {/* Constant light rim right at the water's edge (the outline stroke is clipped to the lake, so only its
                    water side shows) */}
                <g clipPath="url(#notRightHill)">
                    <path d={LAKE_OUTLINE} clipPath="url(#lakeClip)" fill="none" stroke="url(#shoreRim)" strokeWidth="18" strokeLinejoin="round" opacity="0.5" />
                </g>
            </svg>

            {/* Shoreline ripples: rings of tapered strokes lapping in towards the shore and back out */}
            <Piece box={WATER_BOX} className={styles.masked} style={RIPPLE_MASK}>
                {RIPPLES.map((ring, i) => (
                    <div key={i} className={`${styles.layer} ${styles.ripple}`}
                        style={{ '--opacity': ring.opacity, transformOrigin: RIPPLE_ORIGIN, animationDelay: `${ring.delay}s` } as React.CSSProperties}>
                        <PieceSvg box={WATER_BOX}><path d={ring.d} fill="#9ad9fb" /></PieceSvg>
                    </div>
                ))}
            </Piece>

            {/* Streaks gliding across the water */}
            <Piece box={WATER_BOX} className={styles.masked} style={STREAK_MASK}>
                {STREAK_PIECES.map(({ s, box, style }, i) => (
                    <div key={i} className={styles.streak} style={{ ...style, ...within(WATER_BOX, box) }}>
                        <PieceSvg box={box}><path d={strokePath(s)} fill="#9ad9fb" /></PieceSvg>
                    </div>
                ))}
            </Piece>

            {/* Darker water band under the island (its shadow and reflection), with a light waterline below it, so the
                island sits on the water instead of floating; then the island itself */}
            <svg className={styles.full} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice">
                <defs>
                    <linearGradient id="islandBase" gradientUnits="userSpaceOnUse" x1="0" y1="1830" x2="0" y2="1858">
                        <stop offset="0" stopColor="#1c63bb" />
                        <stop offset="1" stopColor="#2a7fcf" />
                    </linearGradient>
                </defs>
                <path d="M1772 1846 Q1776 1834 1800 1832 L2150 1830 Q2178 1834 2182 1846 Q2176 1856 2140 1858 L1810 1858 Q1780 1856 1772 1846Z" fill="url(#islandBase)" />
                <path d="M1790 1864 Q1990 1858 2190 1863 Q1990 1869 1790 1864Z" fill="#8fd4f5" opacity="0.55" />
                <image href={Island.src} x="0" y="0" width="3840" height="4320" />
                {boat(<ellipse cx="0" cy="12" rx="62" ry="6" fill="#0b1a3a" opacity="0.35" />)}
            </svg>

            {/* A small fishing boat out on the water: a fisher sitting with a rod out, and a lantern on a pole glowing
                warm against the blue. The boat bobs gently; the lantern and its reflection flicker */}
            <Piece box={BOAT_BOX}>
                <div className={`${styles.layer} ${styles.flicker}`}>
                    <PieceSvg box={BOAT_BOX}>
                        <defs>
                            <radialGradient id="lanternReflection">
                                <stop offset="0" stopColor="#ffc774" stopOpacity="0.6" />
                                <stop offset="1" stopColor="#ffc774" stopOpacity="0" />
                            </radialGradient>
                        </defs>
                        {boat(<ellipse cx="36" cy="30" rx="10" ry="34" fill="url(#lanternReflection)" />)}
                    </PieceSvg>
                </div>
                <div className={`${styles.layer} ${styles.bob}`}>
                    <div className={`${styles.layer} ${styles.flicker}`}>
                        <PieceSvg box={BOAT_BOX}>
                            <defs>
                                <radialGradient id="lanternGlow">
                                    <stop offset="0" stopColor="#ffe3a3" stopOpacity="0.95" />
                                    <stop offset="0.25" stopColor="#ffb85c" stopOpacity="0.45" />
                                    <stop offset="1" stopColor="#ff9a3c" stopOpacity="0" />
                                </radialGradient>
                            </defs>
                            {boat(<circle cx="44" cy="-32" r="52" fill="url(#lanternGlow)" />)}
                        </PieceSvg>
                    </div>
                    <PieceSvg box={BOAT_BOX}>
                        {boat(<>
                            {/* fishing line, rod, fisher */}
                            <path d="M76 -66 L84 4" stroke="#cfe6ff" strokeWidth="0.8" opacity="0.35" />
                            <path d="M-8 -24 L76 -66" stroke="#0c1730" strokeWidth="2.2" strokeLinecap="round" />
                            <path d="M-24 -6 L-24 -22 Q-22 -32 -14 -32 Q-6 -32 -6 -22 L-4 -6Z" fill="#0c1730" />
                            <circle cx="-15" cy="-38" r="6" fill="#0c1730" />
                            <path d="M-23 -40 Q-15 -50 -7 -40Z" fill="#0c1730" />
                            {/* lantern pole and lantern */}
                            <path d="M36 -6 L36 -40 L44 -40" stroke="#0c1730" strokeWidth="2" fill="none" />
                            <rect x="40" y="-38" width="8" height="10" rx="1.5" fill="#ffd98a" />
                            <path d="M39 -38 L49 -38 L44 -42Z" fill="#0c1730" />
                            {/* hull */}
                            <path d="M-58 -8 L58 -12 Q52 6 32 10 L-40 10 Q-54 6 -58 -8Z" fill="#0a1531" />
                            <path d="M-58 -8 L58 -12" stroke="#2a4a7a" strokeWidth="1.5" opacity="0.6" />
                        </>)}
                    </PieceSvg>
                </div>
            </Piece>

            {/* Fog banks drifting slowly over the water, softened further by a light blur */}
            {FOG_PIECES.map((bank, i) => (
                <Piece key={i} box={bank.box} className={`${styles.fog} ${bank.slow ? styles.fogSlow : ''}`} style={bank.style}>
                    <PieceSvg box={bank.box}>
                        <defs>{FOG_GRADIENT(`fog${i}`)}</defs>
                        {bank.ellipses.map(([cx, cy, rx, ry, opacity], k) => (
                            <ellipse key={k} cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#fog${i})`} opacity={opacity} />
                        ))}
                    </PieceSvg>
                </Piece>
            ))}
        </ArtCanvas>
    )
}
