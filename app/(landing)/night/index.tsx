import Image from 'next/image'

import styles from './night.module.css'
import { FIRE, FOOTER_CANVAS } from './campfire'
import Footer from './footer.svg'

// Backdrop for the content below the hero: the night carries on from the forest floor as a quiet gradient, with soft
// glows and a sparse scattering of faint stars, and the page ends on a small scene (mountains, a lake, and a campfire
// on the shore). Only the campfire moves.

// Stable pseudo-random numbers, so server and client render the same
const r = (i: number, k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1

const STARS = Array.from({ length: 70 }, (_, i) => ({
    left: `${(r(i, 1) * 100).toFixed(2)}%`,
    top: `${(8 + r(i, 2) * 80).toFixed(2)}%`,
    size: +(1 + Math.pow(r(i, 3), 3) * 2).toFixed(1),
    opacity: +(0.15 + r(i, 4) * 0.4).toFixed(2),
    twinkle: r(i, 5) < 0.3 ? `${(3 + r(i, 6) * 4).toFixed(1)}s` : undefined,
    delay: `${(-r(i, 7) * 6).toFixed(1)}s`,
}))

// Sparks rising off the fire
const SPARKS = Array.from({ length: 9 }, (_, i) => ({
    dx: Math.round((r(i, 11) - 0.5) * 60),
    drift: Math.round((r(i, 12) - 0.5) * 120),
    rise: Math.round(160 + r(i, 13) * 220),
    dur: +(1.6 + r(i, 14) * 1.6).toFixed(2),
    delay: +(-r(i, 15) * 3).toFixed(2),
}))

function Campfire() {
    const { x, y } = FIRE
    return (
        <svg className={styles.fire} viewBox={`0 0 ${FOOTER_CANVAS.width} ${FOOTER_CANVAS.height}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
            <defs>
                <radialGradient id="campGlow">
                    <stop offset="0" stopColor="#ffb35c" stopOpacity="0.55" />
                    <stop offset="0.4" stopColor="#ff8a3c" stopOpacity="0.18" />
                    <stop offset="1" stopColor="#ff8a3c" stopOpacity="0" />
                </radialGradient>
            </defs>
            <circle className={styles.glow} cx={x} cy={y - 30} r="260" fill="url(#campGlow)" />
            {/* Flames: three tongues of different heights, each flickering on its own */}
            <path className={styles.flame} style={{ animationDuration: '0.9s' }} fill="#ff7a2a"
                d={`M${x - 48} ${y} C${x - 60} ${y - 60} ${x - 20} ${y - 100} ${x - 6} ${y - 150} C${x + 20} ${y - 96} ${x + 58} ${y - 60} ${x + 48} ${y}Z`} />
            <path className={styles.flame} style={{ animationDuration: '0.7s', animationDelay: '-0.3s' }} fill="#ffb13a"
                d={`M${x - 32} ${y} C${x - 40} ${y - 44} ${x - 8} ${y - 70} ${x + 4} ${y - 108} C${x + 16} ${y - 66} ${x + 40} ${y - 40} ${x + 32} ${y}Z`} />
            <path className={styles.flame} style={{ animationDuration: '0.55s', animationDelay: '-0.2s' }} fill="#fff1a8"
                d={`M${x - 16} ${y} C${x - 20} ${y - 24} ${x - 2} ${y - 40} ${x + 2} ${y - 62} C${x + 10} ${y - 38} ${x + 20} ${y - 22} ${x + 16} ${y}Z`} />
            {SPARKS.map((s, i) => (
                <circle key={i} className={styles.spark} cx={x + s.dx} cy={y - 60} r="4" fill="#ffd27a"
                    style={{ '--rise': `${-s.rise}px`, '--drift': `${s.drift}px`, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` } as React.CSSProperties} />
            ))}
        </svg>
    )
}

export default function NightBackdrop() {
    return (
        <div className={styles.night}>
            {STARS.map((s, i) => (
                <span key={i} className={s.twinkle ? `${styles.star} ${styles.twinkle}` : styles.star}
                    style={{ left: s.left, top: s.top, width: s.size, height: s.size, opacity: s.opacity, animationDuration: s.twinkle, animationDelay: s.delay }} />
            ))}
            <div className={styles.scene}>
                <Image src={Footer} alt='' fill className='object-cover object-bottom' />
                <Campfire />
            </div>
        </div>
    )
}
