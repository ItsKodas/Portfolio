import styles from './fireflies.module.css'

// Fireflies over the valley slopes, at the spots they were painted in the original artwork (found in lake.png).
// Each one wanders around its spot and glows on and off on its own timing. Drawn in the same 3840x4320 canvas as the
// parallax art and scaled like object-cover, so they line up with the valley.

const SPOTS: [number, number][] = [
    // left slope
    [433, 1416], [709, 1452], [183, 1497], [694, 1519], [580, 1582], [703, 1588], [830, 1652], [948, 1669],
    [926, 1719], [759, 1757], [1098, 1753], [1101, 1788], [1069, 1802],
    // right slope
    [2827, 1539], [2832, 1623], [2945, 1632], [2719, 1689], [2839, 1711], [2711, 1748], [2610, 1810], [2820, 1813],
    [2652, 1827], [2665, 1866],
]

// Stable pseudo-random 0..1 per firefly, so server and client agree
const r = (i: number, k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1

const FIREFLIES = SPOTS.map(([x, y], i) => ({
    x, y,
    size: +(2 + r(i, 1) * 1.3).toFixed(1),
    wander: `${(9 + r(i, 2) * 7).toFixed(1)}s`,
    glow: `${(2.5 + r(i, 3) * 3).toFixed(1)}s`,
    delay: `${(-r(i, 4) * 10).toFixed(1)}s`,
    path: i % 3, // which wander loop
}))

export default function Fireflies() {
    return (
        <svg className={styles.fireflies} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
                <radialGradient id="fireflyGlow">
                    <stop offset="0" stopColor="#3de8ff" stopOpacity="0.8" />
                    <stop offset="0.35" stopColor="#1fb8ff" stopOpacity="0.3" />
                    <stop offset="1" stopColor="#1fb8ff" stopOpacity="0" />
                </radialGradient>
            </defs>
            {FIREFLIES.map((f, i) => (
                <g key={i} className={`${styles.wander} ${styles[`path${f.path}`]}`} style={{ animationDuration: f.wander, animationDelay: f.delay }}>
                    <g className={styles.glow} style={{ animationDuration: f.glow, animationDelay: f.delay }}>
                        <circle cx={f.x} cy={f.y} r={+(f.size * 5).toFixed(1)} fill="url(#fireflyGlow)" />
                        <circle cx={f.x} cy={f.y} r={f.size} fill="#b8f6ff" />
                    </g>
                </g>
            ))}
        </svg>
    )
}
