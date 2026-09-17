import { ArtCanvas, Piece, PieceSvg, originIn, acrossX, acrossY, type Box } from '../parallax/art'
import { GROUND_Y, STILL, TREE_PIECES } from './pieces'
import styles from './trees.module.css'

// Foreground trees with wind: each tree sways gently from its base and bends harder in periodic gusts, faint wind
// streaks sweep across during a gust, and small silhouette leaves blow off the trees. The ground stays still.
//
// The silhouette is cut into pieces ahead of time (see pieces.ts, made from shape.ts): the still ground, and one shape
// per tree, continued past the canvas edges with mirror images. Each tree is its own small layer, bent with a CSS
// skew, so the graphics card can move it without repainting anything.

// Stable pseudo-random numbers, so server and client render the same
const r = (i: number, k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1

// Each tree's shading, from the silhouette's radial gradient (drawn in canvas units, so every piece lines up)
function Shade({ id }: { id: string }) {
    return (
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx="1918" cy="2070" r="2985">
            <stop offset="0" stopColor="#0a1634" />
            <stop offset="0.5" stopColor="#0e1726" />
            <stop offset="1" stopColor="#0b101f" />
        </radialGradient>
    )
}

// Per-tree motion: every tree sways on the same slow rhythm but with its own strength and a slight lag, and gusts
// reach each tree a moment later the further right it stands
const TREES = TREE_PIECES.map((t, i) => {
    const origin = originIn(t.box, t.baseX, GROUND_Y)
    return {
        ...t,
        sway: { transformOrigin: origin, '--amp': (0.75 + r(i, 7) * 0.5).toFixed(2), animationDelay: `${(-(t.baseX + 700) / 5300 * 1.6 - r(i, 8) * 0.35).toFixed(2)}s` } as React.CSSProperties,
        gust: { transformOrigin: origin, '--amp': (0.85 + r(i, 9) * 0.3).toFixed(2), animationDelay: `${((t.baseX + 700) / 5300 * 0.9).toFixed(2)}s` } as React.CSSProperties,
    }
})

// Faint wind streaks that sweep across with each gust (from just off the left edge to past the right)
const STREAKS = [
    { y: 1050, length: 700, delay: '0s' },
    { y: 1380, length: 520, delay: '0.35s' },
    { y: 1650, length: 620, delay: '0.7s' },
].map(s => {
    const box: Box = { x: 0, y: s.y - 12, w: s.length, h: 24 }
    return { ...s, box, style: { '--from': acrossX(box, -800), '--to': acrossX(box, 4000), animationDelay: s.delay } as React.CSSProperties }
})

// Leaves: where each one leaves the trees, its size, and its timing
const LEAF_STARTS: [number, number][] = [
    [260, 900], [420, 1250], [560, 1450], [700, 1600], [330, 1500], [150, 1150], [620, 1250], [480, 1750],
    [3150, 1300], [3320, 1150], [3480, 1500], [3250, 1650],
]
const LEAVES = LEAF_STARTS.map(([x, y], i) => {
    const size = +(0.8 + r(i, 1) * 0.7).toFixed(2)
    const box: Box = { x: x - 8 * size, y: y - 8 * size, w: 16 * size, h: 16 * size }
    const delay = `${(-r(i, 5) * 14).toFixed(1)}s`
    return {
        box,
        // (distances in canvas units, as percentages of the leaf's own box)
        travel: { '--tx': acrossX(box, 1400), '--ty': acrossY(box, 260), animationDuration: `${(7 + r(i, 2) * 6).toFixed(1)}s`, animationDelay: delay } as React.CSSProperties,
        flutter: { '--fy': acrossY(box, 40), animationDuration: `${(1.2 + r(i, 3) * 1.2).toFixed(1)}s`, animationDelay: delay } as React.CSSProperties,
        spin: { animationDuration: `${(1.5 + r(i, 4) * 2).toFixed(1)}s` } as React.CSSProperties,
    }
})

export default function ForegroundTrees() {
    return (
        <ArtCanvas>
            <Piece box={STILL.box}>
                <PieceSvg box={STILL.box}>
                    <defs><Shade id="treesShadeStill" /></defs>
                    <path d={STILL.d} fill="url(#treesShadeStill)" fillRule="evenodd" />
                </PieceSvg>
            </Piece>

            {/* Each tree: its own everyday sway, with the gust bend layered on top (nested so the two motions add up) */}
            {TREES.map((t, i) => (
                <Piece key={i} box={t.box} className={styles.sway} style={t.sway}>
                    <div className={`${styles.layer} ${styles.gust}`} style={t.gust}>
                        <PieceSvg box={t.box}>
                            <defs><Shade id={`treesShade${i}`} /></defs>
                            <path d={t.d} fill={`url(#treesShade${i})`} fillRule="evenodd" />
                        </PieceSvg>
                    </div>
                </Piece>
            ))}

            {/* Wind streaks */}
            {STREAKS.map((s, i) => (
                <Piece key={i} box={s.box} className={styles.streak} style={s.style}>
                    <PieceSvg box={s.box}>
                        <defs>
                            <linearGradient id={`windStreak${i}`} x1="0" y1="0" x2="1" y2="0">
                                <stop offset="0" stopColor="#dbeeff" stopOpacity="0" />
                                <stop offset="0.5" stopColor="#dbeeff" stopOpacity="1" />
                                <stop offset="1" stopColor="#dbeeff" stopOpacity="0" />
                            </linearGradient>
                        </defs>
                        <path d={`M0 ${s.y} Q${s.length / 2} ${s.y - 10} ${s.length} ${s.y} Q${s.length / 2} ${s.y - 4} 0 ${s.y}Z`} fill={`url(#windStreak${i})`} />
                    </PieceSvg>
                </Piece>
            ))}

            {/* Leaves blowing off the trees: drift across (outer), flutter up and down (middle), tumble (inner) */}
            {LEAVES.map((l, i) => (
                <Piece key={i} box={l.box} className={styles.leafTravel} style={l.travel}>
                    <div className={`${styles.layer} ${styles.leafFlutter}`} style={l.flutter}>
                        <div className={`${styles.layer} ${styles.leafSpin}`} style={l.spin}>
                            <svg className={styles.layer} viewBox="-8 -8 16 16" preserveAspectRatio="none">
                                <path d="M0 -7 Q5 0 0 7 Q-5 0 0 -7Z" fill="#0d1628" />
                            </svg>
                        </div>
                    </div>
                </Piece>
            ))}
        </ArtCanvas>
    )
}
