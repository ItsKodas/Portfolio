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

export default function Water() {
    return (
        <svg className={styles.water} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
                <clipPath id="lakeClip"><path d={LAKE_OUTLINE} /></clipPath>
                {/* Everything except a strip along the right hill, so the shore rim and ripples don't outline the water
                    where it runs on behind the hill (it should look like it continues, not stop at a shoreline) */}
                <clipPath id="notRightHill"><path clipRule="evenodd" d={`M0 0 H3840 V4320 H0Z ${RIGHT_HILL_EDGE}`} /></clipPath>
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
                {/* Warm lantern light: bright core, soft halo, and a long flickering reflection on the water */}
                <radialGradient id="lanternGlow">
                    <stop offset="0" stopColor="#ffe3a3" stopOpacity="0.95" />
                    <stop offset="0.25" stopColor="#ffb85c" stopOpacity="0.45" />
                    <stop offset="1" stopColor="#ff9a3c" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="lanternReflection">
                    <stop offset="0" stopColor="#ffc774" stopOpacity="0.6" />
                    <stop offset="1" stopColor="#ffc774" stopOpacity="0" />
                </radialGradient>
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
            <g clipPath="url(#notRightHill)">
                <path d={LAKE_OUTLINE} clipPath="url(#lakeClip)" fill="none" stroke="url(#shoreRim)" strokeWidth="18" strokeLinejoin="round" opacity="0.5" />
            </g>

            {/* Shoreline ripples: rings of tapered strokes lapping in towards the shore and back out */}
            <g clipPath="url(#notRightHill)"><g clipPath="url(#lakeClip)">
                {RIPPLES.map((ring, i) => (
                    <path key={i} d={ring.d} className={styles.ripple} style={{ '--opacity': ring.opacity, animationDelay: `${ring.delay}s` } as React.CSSProperties} />
                ))}
            </g></g>

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

            {/* A small fishing boat out on the water: a fisher sitting with a rod out, and a lantern on a pole glowing
                warm against the blue. The boat bobs gently; the lantern and its reflection flicker */}
            <g transform="translate(1560 1795) scale(0.25)">
                <ellipse cx="0" cy="12" rx="62" ry="6" fill="#0b1a3a" opacity="0.35" />
                <ellipse className={styles.lanternFlicker} cx="36" cy="30" rx="10" ry="34" fill="url(#lanternReflection)" />
                <g className={styles.bob}>
                    {/* fishing line, rod, fisher */}
                    <path d="M76 -66 L84 4" stroke="#cfe6ff" strokeWidth="0.8" opacity="0.35" />
                    <path d="M-8 -24 L76 -66" stroke="#0c1730" strokeWidth="2.2" strokeLinecap="round" />
                    <path d="M-24 -6 L-24 -22 Q-22 -32 -14 -32 Q-6 -32 -6 -22 L-4 -6Z" fill="#0c1730" />
                    <circle cx="-15" cy="-38" r="6" fill="#0c1730" />
                    <path d="M-23 -40 Q-15 -50 -7 -40Z" fill="#0c1730" />
                    {/* lantern pole and lantern */}
                    <path d="M36 -6 L36 -40 L44 -40" stroke="#0c1730" strokeWidth="2" fill="none" />
                    <circle className={styles.lanternFlicker} cx="44" cy="-32" r="52" fill="url(#lanternGlow)" />
                    <rect x="40" y="-38" width="8" height="10" rx="1.5" fill="#ffd98a" />
                    <path d="M39 -38 L49 -38 L44 -42Z" fill="#0c1730" />
                    {/* hull */}
                    <path d="M-58 -8 L58 -12 Q52 6 32 10 L-40 10 Q-54 6 -58 -8Z" fill="#0a1531" />
                    <path d="M-58 -8 L58 -12" stroke="#2a4a7a" strokeWidth="1.5" opacity="0.6" />
                </g>
            </g>

            {/* Fog bank along the far shore, where the water meets the ridges (kept off the right-hand hillside) */}
            <g className={`${styles.fog} ${styles.fogSlow}`}>
                {/* Tall, soft layer so the ridges' bases dissolve into the mist instead of showing dark edges */}
                <ellipse cx="1850" cy="1650" rx="1000" ry="120" fill="url(#fog)" opacity="0.6" />
                <ellipse cx="1300" cy="1660" rx="650" ry="95" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="2350" cy="1655" rx="420" ry="95" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="1850" cy="1668" rx="850" ry="46" fill="url(#fog)" opacity="0.7" />
                <ellipse cx="1500" cy="1690" rx="700" ry="38" fill="url(#fog)" opacity="0.5" />
                <ellipse cx="2300" cy="1682" rx="400" ry="36" fill="url(#fog)" opacity="0.5" />
            </g>

            {/* Fog rolling out from the base of the island */}
            <g className={styles.fog}>
                <ellipse cx="1990" cy="1852" rx="560" ry="48" fill="url(#fog)" />
                <ellipse cx="1880" cy="1880" rx="920" ry="78" fill="url(#fog)" opacity="0.55" />
                <ellipse cx="2250" cy="1838" rx="380" ry="42" fill="url(#fog)" opacity="0.5" />
            </g>
            <g className={`${styles.fog} ${styles.fogSlow}`}>
                <ellipse cx="1600" cy="1905" rx="700" ry="60" fill="url(#fog)" opacity="0.4" />
                <ellipse cx="2150" cy="1790" rx="480" ry="40" fill="url(#fog)" opacity="0.3" />
            </g>
        </svg>
    )
}
