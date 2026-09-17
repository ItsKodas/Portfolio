import styles from './stars.module.css'

// Night sky over the hero: crisp little stars scattered across the upper sky (thicker towards the top and the right,
// thinning out towards the mountains), a few brighter ones with a soft glow, and a crescent moon up on the right.
// Drawn in the same 3840x4320 canvas as the parallax art and scaled like object-cover, so it lines up with the sky.

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
    return stars
}

const MOON = { x: 2760, y: 470, r: 52 } // low enough to stay in view on wide screens
const STARS = buildStars()

// Drift for each star group: how far it wanders (canvas units, about half that in screen pixels) and how long a loop takes
const DRIFT: React.CSSProperties[] = ([
    { '--dx': '36px', '--dy': '-20px', animationDuration: '30s', animationDelay: '0s' },
    { '--dx': '-30px', '--dy': '26px', animationDuration: '36s', animationDelay: '-12s' },
    { '--dx': '26px', '--dy': '32px', animationDuration: '42s', animationDelay: '-30s' },
    { '--dx': '-40px', '--dy': '-16px', animationDuration: '34s', animationDelay: '-20s' },
    { '--dx': '20px', '--dy': '-34px', animationDuration: '40s', animationDelay: '-8s' },
    { '--dx': '-24px', '--dy': '-28px', animationDuration: '46s', animationDelay: '-25s' },
    { '--dx': '32px', '--dy': '18px', animationDuration: '38s', animationDelay: '-16s' },
] as Record<string, string>[])

// Shooting stars: each streaks across the upper sky once per cycle, then waits (start point, angle, cycle length)
const SHOOTING = [
    { x: 3300, y: 330, angle: 152, duration: '13s', delay: '-2s' },
    { x: 1900, y: 250, angle: 160, duration: '19s', delay: '-9s' },
    { x: 2900, y: 700, angle: 148, duration: '23s', delay: '-15s' },
]

export default function NightSky() {
    const byGroup = (g: number) => STARS.filter(s => s.group === g)

    return (
        <svg className={styles.sky} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
                <radialGradient id="starGlow">
                    <stop offset="0" stopColor="#dff0ff" stopOpacity="0.3" />
                    <stop offset="1" stopColor="#dff0ff" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="shootTail" x1="1" y1="0" x2="0" y2="0">
                    <stop offset="0" stopColor="#f4f9ff" stopOpacity="0.9" />
                    <stop offset="1" stopColor="#f4f9ff" stopOpacity="0" />
                </linearGradient>
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

            {/* A few steady stars, then the twinkling groups (each on its own cycle). Each group also drifts slowly
                along its own loop, so the field gently shifts without ever wandering off */}
            {Array.from({ length: TWINKLE_GROUPS + 1 }, (_, g) => (
                <g key={g} className={styles.drift} style={DRIFT[g]}>
                    <g className={g ? styles.twinkle : undefined} style={g ? { animationDuration: `${(1.8 + g * 0.7).toFixed(1)}s`, animationDelay: `${(-g * 1.1).toFixed(1)}s` } : undefined}>
                        {/* Soft halos behind the brightest stars (inside the group so they move with their star) */}
                        {byGroup(g).filter(s => s.r >= 3.6).map((s, i) => <circle key={`glow${i}`} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} r={(s.r * 2.5).toFixed(1)} fill="url(#starGlow)" />)}
                        {byGroup(g).map((s, i) => <circle key={i} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} r={s.r.toFixed(1)} fill="#f4f9ff" opacity={s.opacity.toFixed(2)} />)}
                    </g>
                </g>
            ))}

            {/* Shooting stars: a bright head with a fading tail, rotated to its direction of travel */}
            {SHOOTING.map((m, i) => (
                <g key={i} transform={`translate(${m.x} ${m.y}) rotate(${m.angle})`}>
                    <g className={styles.shoot} style={{ animationDuration: m.duration, animationDelay: m.delay }}>
                        <path d="M0 -2.5 L0 2.5 L-260 0Z" fill="url(#shootTail)" />
                        <circle r="4" fill="#f4f9ff" />
                    </g>
                </g>
            ))}

            {/* Moon */}
            <circle cx={MOON.x} cy={MOON.y} r={MOON.r * 5} fill="url(#moonGlow)" />
            <circle cx={MOON.x} cy={MOON.y} r={MOON.r} fill="#fbfaf1" mask="url(#crescent)" />
        </svg>
    )
}
