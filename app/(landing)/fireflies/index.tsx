import { ArtCanvas, Piece, PieceSvg, type Box } from '../parallax/art'
import styles from './fireflies.module.css'

// Fireflies over the valley slopes, at the spots they were painted in the original artwork (found in lake.png).
// Each one wanders around its spot and glows on and off on its own timing. Placed in the parallax art's 3840x4320
// canvas, so they line up with the valley. Each firefly is its own small layer, moved with transform and opacity only.

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

// Every firefly sits in a 40x40 box around its spot (its glow reaches at most about 17 units out); the wander loops in
// the stylesheet are percentages of that box
const SIZE = 40

const FIREFLIES = SPOTS.map(([x, y], i) => ({
    x, y,
    box: { x: x - SIZE / 2, y: y - SIZE / 2, w: SIZE, h: SIZE } as Box,
    size: +(2 + r(i, 1) * 1.3).toFixed(1),
    wander: `${(9 + r(i, 2) * 7).toFixed(1)}s`,
    glow: `${(2.5 + r(i, 3) * 3).toFixed(1)}s`,
    delay: `${(-r(i, 4) * 10).toFixed(1)}s`,
    path: i % 3, // which wander loop
}))

export default function Fireflies() {
    return (
        <ArtCanvas>
            {FIREFLIES.map((f, i) => (
                <Piece key={i} box={f.box} className={`${styles.wander} ${styles[`path${f.path}`]}`} style={{ animationDuration: f.wander, animationDelay: f.delay }}>
                    <div className={`${styles.layer} ${styles.glow}`} style={{ animationDuration: f.glow, animationDelay: f.delay }}>
                        <PieceSvg box={f.box}>
                            <defs>
                                <radialGradient id={`fireflyGlow${i}`}>
                                    <stop offset="0" stopColor="#3de8ff" stopOpacity="0.8" />
                                    <stop offset="0.35" stopColor="#1fb8ff" stopOpacity="0.3" />
                                    <stop offset="1" stopColor="#1fb8ff" stopOpacity="0" />
                                </radialGradient>
                            </defs>
                            <circle cx={f.x} cy={f.y} r={+(f.size * 5).toFixed(1)} fill={`url(#fireflyGlow${i})`} />
                            <circle cx={f.x} cy={f.y} r={f.size} fill="#b8f6ff" />
                        </PieceSvg>
                    </div>
                </Piece>
            ))}
        </ArtCanvas>
    )
}
