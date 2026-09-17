import { TREES_PATH } from './shape'
import styles from './trees.module.css'

// Foreground trees with wind: the left and right tree groups sway gently from their bases and bend harder in
// periodic gusts, faint wind streaks sweep across during a gust, and small silhouette leaves blow off the trees.
// The ground stays still. Drawn in the same 3840x4320 canvas as the parallax art and scaled like object-cover.

// Where the trees meet the ground: everything above this line sways, everything below stays put
const GROUND_Y = 1928

// Leaves: where each one leaves the trees, its size, and its timing (all stable, so server and client agree)
const r = (i: number, k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1
const LEAF_STARTS: [number, number][] = [
    [260, 900], [420, 1250], [560, 1450], [700, 1600], [330, 1500], [150, 1150], [620, 1250], [480, 1750],
    [3150, 1300], [3320, 1150], [3480, 1500], [3250, 1650],
]
const LEAVES = LEAF_STARTS.map(([x, y], i) => ({
    x, y,
    size: +(0.8 + r(i, 1) * 0.7).toFixed(2),
    travel: `${(7 + r(i, 2) * 6).toFixed(1)}s`,
    flutter: `${(1.2 + r(i, 3) * 1.2).toFixed(1)}s`,
    spin: `${(1.5 + r(i, 4) * 2).toFixed(1)}s`,
    delay: `${(-r(i, 5) * 14).toFixed(1)}s`,
}))

// Faint wind streaks that sweep across with each gust
const STREAKS = [
    { y: 1050, length: 700, delay: '0s' },
    { y: 1380, length: 520, delay: '0.35s' },
    { y: 1650, length: 620, delay: '0.7s' },
]

// The artwork stops at the canvas edges, which cut the outermost trees off in a straight line (visible when the trees
// sway, or on screens that show more than the canvas width). Past each edge, the silhouette is continued with a mirror
// image of the trees just inside it: on the left mirrored around the tallest tree's trunk, so it becomes a whole tree.
const LEFT_MIRROR_X = 16
const RIGHT_MIRROR_X = 3840

// Each tree in the silhouette (including the mirrored ones past the edges): its tip, and the point on the ground it bends
// from. Trees are listed left to right within each group.
interface Tree { tipX: number, tipY: number, baseX: number }
const GROUPS: { left: number, right: number, trees: Tree[] }[] = [
    {
        left: -1700, right: 890, trees: [
            { tipX: -748, tipY: 1378, baseX: -633 },
            { tipX: -514, tipY: 1152, baseX: -516 },
            { tipX: -340, tipY: 1112, baseX: -356 },
            { tipX: -80, tipY: 805, baseX: -80 },
            { tipX: 16, tipY: 470, baseX: 14 },
            { tipX: 112, tipY: 805, baseX: 112 },
            { tipX: 372, tipY: 1112, baseX: 388 },
            { tipX: 546, tipY: 1152, baseX: 548 },
            { tipX: 780, tipY: 1378, baseX: 665 },
        ],
    },
    {
        left: 3010, right: 5500, trees: [
            { tipX: 3162, tipY: 1088, baseX: 3165 },
            { tipX: 3385, tipY: 998, baseX: 3278 },
            { tipX: 3519, tipY: 683, baseX: 3520 },
            { tipX: 3749, tipY: 748, baseX: 3760 },
            { tipX: 3931, tipY: 748, baseX: 3920 },
            { tipX: 4161, tipY: 683, baseX: 4160 },
            { tipX: 4295, tipY: 998, baseX: 4402 },
            { tipX: 4518, tipY: 1088, baseX: 4515 },
        ],
    },
]
const TREES = GROUPS.flatMap(g => g.trees)

// Split each group of trees into one region per tree: at every height, the silhouette is divided halfway between the
// trunks of the trees that reach that high. The regions tile the group exactly (nothing doubled, nothing left out), and
// a branch that reaches past the halfway line simply moves with its neighbour, which is too small a difference to see.
const TOP_MARGIN = 80 // regions start a little above each tip
const axisX = (t: Tree, y: number) => t.tipX + (t.baseX - t.tipX) * Math.max(0, y - t.tipY) / (GROUND_Y - t.tipY)
const REGIONS = GROUPS.flatMap(({ left, right, trees }) => trees.map((tree, i) => {
    const leftEdge: string[] = [], rightEdge: string[] = []
    const top = tree.tipY - TOP_MARGIN
    for (let y = top; ; y = Math.min(GROUND_Y, y + 20)) {
        const present = trees.filter(t => y >= t.tipY - TOP_MARGIN)
        const k = present.indexOf(tree)
        // (each region reaches 3 units past the halfway line, so neighbours overlap a hair and no seam shows)
        const l = k > 0 ? (axisX(present[k - 1], y) + axisX(tree, y)) / 2 - 3 : left
        const r2 = k < present.length - 1 ? (axisX(tree, y) + axisX(present[k + 1], y)) / 2 + 3 : right
        leftEdge.push(`${l.toFixed(0)} ${y}`)
        rightEdge.push(`${r2.toFixed(0)} ${y}`)
        if (y === GROUND_Y) break
    }
    // Tallest tree in the group also takes everything above its tip, so no sliver is ever cut off at the top
    const tallest = Math.min(...trees.map(t => t.tipY)) === tree.tipY && i === trees.findIndex(t => t.tipY === tree.tipY)
    const cap = tallest ? `M${left} 0 L${right} 0 L${right} ${top} L${left} ${top}Z ` : ''
    return cap + 'M' + [...leftEdge, ...rightEdge.reverse()].join(' L') + 'Z'
}))

// Per-tree motion: every tree sways on the same slow rhythm but with its own strength and a slight lag, and gusts
// reach each tree a moment later the further right it stands. Neighbours stay close enough in step that the silhouette
// never visibly shears where their regions meet, while the canopy still moves as separate trees.
const TREE_MOTION = TREES.map((t, i) => ({
    sway: {
        transformOrigin: `${t.baseX}px ${GROUND_Y}px`,
        '--amp': (0.75 + r(i, 7) * 0.5).toFixed(2),
        animationDelay: `${(-(t.baseX + 700) / 5300 * 1.6 - r(i, 8) * 0.35).toFixed(2)}s`,
    } as React.CSSProperties,
    gust: {
        transformOrigin: `${t.baseX}px ${GROUND_Y}px`,
        '--amp': (0.85 + r(i, 9) * 0.3).toFixed(2),
        animationDelay: `${((t.baseX + 700) / 5300 * 0.9).toFixed(2)}s`,
    } as React.CSSProperties,
}))

export default function ForegroundTrees() {
    return (
        <svg className={styles.trees} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
                <radialGradient id="treeShade" gradientUnits="userSpaceOnUse" cx="1918" cy="2070" r="2985">
                    <stop offset="0" stopColor="#0a1634" />
                    <stop offset="0.5" stopColor="#0e1726" />
                    <stop offset="1" stopColor="#0b101f" />
                </radialGradient>
                <linearGradient id="windStreak" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#dbeeff" stopOpacity="0" />
                    <stop offset="0.5" stopColor="#dbeeff" stopOpacity="1" />
                    <stop offset="1" stopColor="#dbeeff" stopOpacity="0" />
                </linearGradient>
                <clipPath id="pastLeftEdge"><rect x="-1700" y="0" width={1700 + LEFT_MIRROR_X} height="4320" /></clipPath>
                <clipPath id="pastRightEdge"><rect x={RIGHT_MIRROR_X - 2} y="0" width="1700" height="4320" /></clipPath>
                {/* The whole silhouette, continued past both edges; everything below reuses it */}
                <g id="treesFull" fill="url(#treeShade)">
                    <path id="treesShape" d={TREES_PATH} fillRule="evenodd" />
                    {/* (clip on a wrapping group, so the clip applies in canvas space, not the mirrored space) */}
                    <g clipPath="url(#pastLeftEdge)"><use href="#treesShape" transform={`matrix(-1 0 0 1 ${LEFT_MIRROR_X * 2} 0)`} /></g>
                    <g clipPath="url(#pastRightEdge)"><use href="#treesShape" transform={`matrix(-1 0 0 1 ${RIGHT_MIRROR_X * 2} 0)`} /></g>
                </g>
                {/* Still parts: the ground and the rocky middle */}
                <clipPath id="treesStill">
                    <rect x="-1700" y={GROUND_Y - 4} width="7300" height="3000" />
                    <rect x="890" y="0" width="2120" height={GROUND_Y} />
                </clipPath>
                {REGIONS.map((d, i) => <clipPath key={i} id={`tree${i}`}><path d={d} /></clipPath>)}
            </defs>

            <use href="#treesFull" clipPath="url(#treesStill)" />

            {/* Each tree: its own everyday sway, with the gust bend layered on top (nested so the two motions add up) */}
            {TREES.map((t, i) => (
                <g key={i} className={`${styles.bend} ${styles.sway}`} style={TREE_MOTION[i].sway}>
                    <g className={`${styles.bend} ${styles.gust}`} style={TREE_MOTION[i].gust}>
                        <use href="#treesFull" clipPath={`url(#tree${i})`} />
                    </g>
                </g>
            ))}

            {/* Wind streaks */}
            {STREAKS.map((s, i) => (
                <path key={i} className={styles.streak} style={{ animationDelay: s.delay }}
                    d={`M0 ${s.y} Q${s.length / 2} ${s.y - 10} ${s.length} ${s.y} Q${s.length / 2} ${s.y - 4} 0 ${s.y}Z`} fill="url(#windStreak)" />
            ))}

            {/* Leaves blowing off the trees: drift across (outer), flutter up and down (middle), tumble (inner) */}
            {LEAVES.map((l, i) => (
                <g key={i} transform={`translate(${l.x} ${l.y})`}>
                    <g className={styles.leafTravel} style={{ animationDuration: l.travel, animationDelay: l.delay }}>
                        <g className={styles.leafFlutter} style={{ animationDuration: l.flutter, animationDelay: l.delay }}>
                            <path className={styles.leafSpin} style={{ animationDuration: l.spin }}
                                d={`M0 ${-7 * l.size} Q${5 * l.size} 0 0 ${7 * l.size} Q${-5 * l.size} 0 0 ${-7 * l.size}Z`} fill="#0d1628" />
                        </g>
                    </g>
                </g>
            ))}
        </svg>
    )
}
