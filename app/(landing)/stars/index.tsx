import { ArtCanvas, Piece, PieceSvg, originIn, acrossX, acrossY, type Box } from '../parallax/art'
import styles from './stars.module.css'

// Night sky over the hero: crisp little stars scattered across the upper sky (thicker towards the top and the right,
// thinning out towards the mountains), a few brighter ones with a soft glow, shooting stars, and a crescent moon up on
// the right. Placed in the parallax art's 3840x4320 canvas, so it lines up with the sky.
//
// The stars are split into groups that each drift and twinkle as a whole: every group is its own layer, moved with
// transform and opacity only, so the graphics card animates them without repainting.

interface Star {
    x: number
    y: number
    r: number
    opacity: number
    group: number // which twinkle group it belongs to (0 = steady)
}

// Seeded, so the server and client render the same sky
let seed = 20240917
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const TWINKLE_GROUPS = 6
const MOON = { x: 2760, y: 470, r: 52 } // low enough to stay in view on wide screens

function buildStars(): Star[] {
    const stars: Star[] = []
    while (stars.length < 420) {
        const x = rand() * 3840, y = 200 + rand() * 1400
        // Denser near the top, sparse on the left, thickest around the moon; fading out towards the horizon
        const nearMoon = Math.exp(-((x - MOON.x) ** 2 + ((y - MOON.y) * 1.3) ** 2) / (2 * 850 ** 2))
        const density = Math.pow(1 - (y - 200) / 1400, 1.2) * Math.min(1, 0.2 + 0.5 * Math.pow(x / 3840, 1.5) + 0.6 * nearMoon)
        if (rand() > density) continue
        const bright = rand() < 0.06
        stars.push({
            x, y,
            r: bright ? 3.6 + rand() * 0.8 : 1.8 + rand() * 1.2,
            opacity: bright ? 1 : 0.45 + rand() * 0.5,
            group: rand() < 0.2 ? 0 : 1 + Math.floor(rand() * TWINKLE_GROUPS),
        })
    }
    // Small tight clusters, like the little star groups in the painting
    const clusters: [number, number][] = [[2880, 300], [3510, 640]]
    for (const [cx, cy] of clusters) {
        for (let i = 0; i < 7; i++) {
            stars.push({ x: cx + (rand() - 0.5) * 90, y: cy + (rand() - 0.5) * 70, r: 1.5 + rand() * 1, opacity: 0.7 + rand() * 0.3, group: 1 + (i % TWINKLE_GROUPS) })
        }
    }
    // The very top of the sky, above where the field starts: normally cropped off-screen, but on screens that show the
    // whole canvas height (full screen, very wide or tall screens) it would be an empty band. Filled at the same density
    // as the top of the field, from its own seed so the stars below don't move.
    seed = 7351
    let top = 0
    while (top < 90) {
        const x = rand() * 3840, y = -40 + rand() * 250
        const density = Math.min(1, 0.2 + 0.5 * Math.pow(x / 3840, 1.5) + 0.6 * Math.exp(-((x - MOON.x) ** 2 + ((y - MOON.y) * 1.3) ** 2) / (2 * 850 ** 2)))
        if (rand() > density) continue
        const bright = rand() < 0.06
        stars.push({
            x, y,
            r: bright ? 3.6 + rand() * 0.8 : 1.8 + rand() * 1.2,
            opacity: bright ? 1 : 0.45 + rand() * 0.5,
            group: rand() < 0.2 ? 0 : 1 + Math.floor(rand() * TWINKLE_GROUPS),
        })
        top++
    }
    return stars
}

const STARS = buildStars()

// Drift for each star group: how far it wanders (canvas units) and how long a loop takes
const DRIFT = [
    { dx: 36, dy: -20, duration: 30, delay: 0 },
    { dx: -30, dy: 26, duration: 36, delay: -12 },
    { dx: 26, dy: 32, duration: 42, delay: -30 },
    { dx: -40, dy: -16, duration: 34, delay: -20 },
    { dx: 20, dy: -34, duration: 40, delay: -8 },
    { dx: -24, dy: -28, duration: 46, delay: -25 },
    { dx: 32, dy: 18, duration: 38, delay: -16 },
]

// Each group: its stars, the box they fit in, and its motion (distances as percentages of that box)
const GROUPS = Array.from({ length: TWINKLE_GROUPS + 1 }, (_, g) => {
    const stars = STARS.filter(s => s.group === g)
    const xs = stars.map(s => s.x), ys = stars.map(s => s.y), pad = 16
    const box: Box = {
        x: Math.floor(Math.min(...xs) - pad), y: Math.floor(Math.min(...ys) - pad),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs) + pad * 2), h: Math.ceil(Math.max(...ys) - Math.min(...ys) + pad * 2),
    }
    const d = DRIFT[g]
    return {
        g, stars, box,
        drift: { '--dx': acrossX(box, d.dx), '--dy': acrossY(box, d.dy), animationDuration: `${d.duration}s`, animationDelay: `${d.delay}s` } as React.CSSProperties,
        twinkle: g ? { animationDuration: `${(1.8 + g * 0.7).toFixed(1)}s`, animationDelay: `${(-g * 1.1).toFixed(1)}s` } : undefined,
    }
})

// Shooting stars: each streaks across the upper sky once per cycle, then waits (start point, angle, cycle length). The
// piece holds the tail behind the head, rotated about the head to its direction of travel
const SHOOTING = [
    { x: 3300, y: 330, angle: 152, duration: '13s', delay: '-2s' },
    { x: 1900, y: 250, angle: 160, duration: '19s', delay: '-9s' },
    { x: 2900, y: 700, angle: 148, duration: '23s', delay: '-15s' },
].map(m => {
    const box: Box = { x: m.x - 262, y: m.y - 6, w: 268, h: 12 }
    return {
        ...m, box,
        turn: { transformOrigin: originIn(box, m.x, m.y), transform: `rotate(${m.angle}deg)` } as React.CSSProperties,
        shoot: { '--travel': acrossX(box, 900), animationDuration: m.duration, animationDelay: m.delay } as React.CSSProperties,
    }
})

const MOON_BOX: Box = { x: MOON.x - MOON.r * 5, y: MOON.y - MOON.r * 5, w: MOON.r * 10, h: MOON.r * 10 }

export default function NightSky() {
    return (
        <ArtCanvas>
            {/* A few steady stars, then the twinkling groups (each on its own cycle), each group drifting slowly along
                its own loop, so the field gently shifts without ever wandering off */}
            {GROUPS.map(({ g, stars, box, drift, twinkle }) => (
                <Piece key={g} box={box} className={styles.drift} style={drift}>
                    <div className={`${styles.layer} ${twinkle ? styles.twinkle : ''}`} style={twinkle}>
                        <PieceSvg box={box}>
                            <defs>
                                <radialGradient id={`starGlow${g}`}>
                                    <stop offset="0" stopColor="#dff0ff" stopOpacity="0.3" />
                                    <stop offset="1" stopColor="#dff0ff" stopOpacity="0" />
                                </radialGradient>
                            </defs>
                            {/* Soft halos behind the brightest stars */}
                            {stars.filter(s => s.r >= 3.6).map((s, i) => <circle key={`glow${i}`} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} r={(s.r * 2.5).toFixed(1)} fill={`url(#starGlow${g})`} />)}
                            {stars.map((s, i) => <circle key={i} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} r={s.r.toFixed(1)} fill="#f4f9ff" opacity={s.opacity.toFixed(2)} />)}
                        </PieceSvg>
                    </div>
                </Piece>
            ))}

            {/* Shooting stars: a bright head with a fading tail */}
            {SHOOTING.map((m, i) => (
                <Piece key={i} box={m.box} style={m.turn}>
                    <div className={`${styles.layer} ${styles.shoot}`} style={m.shoot}>
                        <PieceSvg box={m.box}>
                            <defs>
                                <linearGradient id={`shootTail${i}`} x1="1" y1="0" x2="0" y2="0">
                                    <stop offset="0" stopColor="#f4f9ff" stopOpacity="0.9" />
                                    <stop offset="1" stopColor="#f4f9ff" stopOpacity="0" />
                                </linearGradient>
                            </defs>
                            <path d={`M${m.x} ${m.y - 2.5} L${m.x} ${m.y + 2.5} L${m.x - 260} ${m.y}Z`} fill={`url(#shootTail${i})`} />
                            <circle cx={m.x} cy={m.y} r="4" fill="#f4f9ff" />
                        </PieceSvg>
                    </div>
                </Piece>
            ))}

            {/* Moon */}
            <Piece box={MOON_BOX}>
                <PieceSvg box={MOON_BOX}>
                    <defs>
                        <radialGradient id="moonGlow">
                            <stop offset="0" stopColor="#e8f4ff" stopOpacity="0.35" />
                            <stop offset="0.35" stopColor="#cfe6ff" stopOpacity="0.12" />
                            <stop offset="1" stopColor="#cfe6ff" stopOpacity="0" />
                        </radialGradient>
                        {/* Crescent: the moon disc with an offset disc cut out of its upper right */}
                        <mask id="crescent">
                            <circle cx={MOON.x} cy={MOON.y} r={MOON.r} fill="#fff" />
                            <circle cx={MOON.x + MOON.r * 0.42} cy={MOON.y - MOON.r * 0.36} r={MOON.r * 0.9} fill="#000" />
                        </mask>
                    </defs>
                    <circle cx={MOON.x} cy={MOON.y} r={MOON.r * 5} fill="url(#moonGlow)" />
                    <circle cx={MOON.x} cy={MOON.y} r={MOON.r} fill="#fbfaf1" mask="url(#crescent)" />
                </PieceSvg>
            </Piece>
        </ArtCanvas>
    )
}
