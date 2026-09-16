import Island from './island.svg'
import { LAKE_OUTLINE } from './lake'
import styles from './water.module.css'

// Drawn in the same 3840x4320 canvas as the parallax art, scaled like object-cover so it lines up with the valley

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

export default function Water() {
    return (
        <svg className={styles.water} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
                <clipPath id="lakeClip"><path d={LAKE_OUTLINE} /></clipPath>
                {/* Streaks may also run over the far water under the fog bank (the outline stops below it) */}
                <clipPath id="streakClip"><path d={LAKE_OUTLINE} /><path d="M1300 1640 L2700 1640 L2700 1702 L1300 1702Z" /></clipPath>
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
                <radialGradient id="fog">
                    <stop offset="0" stopColor="#cdeaff" stopOpacity="0.75" />
                    <stop offset="0.45" stopColor="#b3dcfb" stopOpacity="0.4" />
                    <stop offset="1" stopColor="#9fd0f5" stopOpacity="0" />
                </radialGradient>
            </defs>

            {/* The lake, continued down behind the forest so water shows between the tree tips */}
            <path d={LAKE_OUTLINE} fill="url(#waterFill)" mask="url(#behindTreesMask)" />

            {/* Constant light rim right at the water's edge (the outline stroke is clipped to the lake, so only its
                water side shows) */}
            <path d={LAKE_OUTLINE} clipPath="url(#lakeClip)" fill="none" stroke="url(#shoreRim)" strokeWidth="18" strokeLinejoin="round" opacity="0.5" />

            {/* Shoreline ripples: rings of tapered strokes lapping in towards the shore and back out */}
            <g clipPath="url(#lakeClip)">
                {RIPPLES.map((ring, i) => (
                    <path key={i} d={ring.d} className={styles.ripple} style={{ '--opacity': ring.opacity, animationDelay: `${ring.delay}s` } as React.CSSProperties} />
                ))}
            </g>

            {/* Streaks gliding across the water */}
            <g clipPath="url(#streakClip)">
                {STREAKS.map((streak, i) => (
                    <path
                        key={i}
                        className={styles.streak}
                        d={strokePath(streak)}
                        style={{
                            '--drift': `${streak.drift}px`,
                            '--opacity': streak.opacity,
                            animationDuration: `${streak.duration}s`,
                            animationDelay: `${streak.delay}s`,
                        } as React.CSSProperties}
                    />
                ))}
            </g>

            {/* Darker water band under the island (its shadow and reflection), with a light waterline below it, as in the
                original, so the island sits on the water instead of floating */}
            <linearGradient id="islandBase" gradientUnits="userSpaceOnUse" x1="0" y1="1830" x2="0" y2="1858">
                <stop offset="0" stopColor="#1c63bb" />
                <stop offset="1" stopColor="#2a7fcf" />
            </linearGradient>
            <path d="M1772 1846 Q1776 1834 1800 1832 L2150 1830 Q2178 1834 2182 1846 Q2176 1856 2140 1858 L1810 1858 Q1780 1856 1772 1846Z" fill="url(#islandBase)" />
            <path d="M1790 1864 Q1990 1858 2190 1863 Q1990 1869 1790 1864Z" fill="#8fd4f5" opacity="0.55" />

            <image href={Island.src} x="0" y="0" width="3840" height="4320" />

            {/* Fog bank along the far shore, where the water meets the ridges */}
            <g className={`${styles.fog} ${styles.fogSlow}`}>
                {/* Tall, soft layer so the ridges' bases dissolve into the mist instead of showing dark edges */}
                <ellipse cx="1950" cy="1650" rx="1400" ry="120" fill="url(#fog)" opacity="0.6" />
                <ellipse cx="1300" cy="1660" rx="650" ry="95" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="2650" cy="1655" rx="650" ry="95" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="1950" cy="1668" rx="1050" ry="46" fill="url(#fog)" opacity="0.7" />
                <ellipse cx="1500" cy="1690" rx="700" ry="38" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="2450" cy="1682" rx="650" ry="36" fill="url(#fog)" opacity="0.5" />
            </g>

            {/* Fog rolling out from the base of the island */}
            <g className={styles.fog}>
                <ellipse cx="1990" cy="1852" rx="560" ry="48" fill="url(#fog)" />
                <ellipse cx="1880" cy="1880" rx="920" ry="78" fill="url(#fog)" opacity="0.55" />
                <ellipse cx="2380" cy="1838" rx="520" ry="42" fill="url(#fog)" opacity="0.5" />
            </g>
            <g className={`${styles.fog} ${styles.fogSlow}`}>
                <ellipse cx="1600" cy="1905" rx="700" ry="60" fill="url(#fog)" opacity="0.4" />
                <ellipse cx="2250" cy="1790" rx="620" ry="40" fill="url(#fog)" opacity="0.3" />
            </g>
        </svg>
    )
}
