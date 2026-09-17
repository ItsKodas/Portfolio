import Image from 'next/image'

import { Piece, PieceSvg, originIn, acrossX, acrossY, type Box } from '../parallax/art'
import styles from './night.module.css'
import { FIRE, FOOTER_CANVAS } from './campfire'
import Footer from './footer.svg'

// Backdrop for the content below the hero: the night carries on from the forest floor as a quiet gradient, with soft
// glows and a sparse scattering of faint stars, and the page ends on a small scene (mountains, a lake, and a campfire
// on the shore). Only the campfire moves: its glow, flames and sparks are each their own small layer, moved with
// transform and opacity only, so the graphics card animates them without repainting the scene.

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

// The campfire's moving parts, in the scene's canvas units
const { x: FX, y: FY } = FIRE

const GLOW_BOX: Box = { x: FX - 260, y: FY - 290, w: 520, h: 520 }

// Flames: three tongues of different heights, each flickering on its own, stretching and leaning from its base
const FLAMES = [
    { fill: '#ff7a2a', duration: '0.9s', delay: '0s', d: `M${FX - 48} ${FY} C${FX - 60} ${FY - 60} ${FX - 20} ${FY - 100} ${FX - 6} ${FY - 150} C${FX + 20} ${FY - 96} ${FX + 58} ${FY - 60} ${FX + 48} ${FY}Z`, box: { x: FX - 64, y: FY - 156, w: 128, h: 160 } },
    { fill: '#ffb13a', duration: '0.7s', delay: '-0.3s', d: `M${FX - 32} ${FY} C${FX - 40} ${FY - 44} ${FX - 8} ${FY - 70} ${FX + 4} ${FY - 108} C${FX + 16} ${FY - 66} ${FX + 40} ${FY - 40} ${FX + 32} ${FY}Z`, box: { x: FX - 44, y: FY - 112, w: 88, h: 116 } },
    { fill: '#fff1a8', duration: '0.55s', delay: '-0.2s', d: `M${FX - 16} ${FY} C${FX - 20} ${FY - 24} ${FX - 2} ${FY - 40} ${FX + 2} ${FY - 62} C${FX + 10} ${FY - 38} ${FX + 20} ${FY - 22} ${FX + 16} ${FY}Z`, box: { x: FX - 24, y: FY - 66, w: 48, h: 70 } },
].map(f => ({ ...f, style: { transformOrigin: originIn(f.box, FX, FY), animationDuration: f.duration, animationDelay: f.delay } as React.CSSProperties }))

// Sparks rising off the fire (distances as percentages of each spark's own box)
const SPARKS = Array.from({ length: 9 }, (_, i) => {
    const dx = Math.round((r(i, 11) - 0.5) * 60)
    const box: Box = { x: FX + dx - 6, y: FY - 66, w: 12, h: 12 }
    return {
        box,
        style: {
            '--rise': acrossY(box, -Math.round(160 + r(i, 13) * 220)), '--drift': acrossX(box, Math.round((r(i, 12) - 0.5) * 120)),
            animationDuration: `${(1.6 + r(i, 14) * 1.6).toFixed(2)}s`, animationDelay: `${(-r(i, 15) * 3).toFixed(2)}s`,
        } as React.CSSProperties,
    }
})

function Campfire() {
    return (
        <>
            <Piece box={GLOW_BOX} canvas={FOOTER_CANVAS} className={styles.glow}>
                <PieceSvg box={GLOW_BOX}>
                    <defs>
                        <radialGradient id="campGlow">
                            <stop offset="0" stopColor="#ffb35c" stopOpacity="0.55" />
                            <stop offset="0.4" stopColor="#ff8a3c" stopOpacity="0.18" />
                            <stop offset="1" stopColor="#ff8a3c" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <circle cx={FX} cy={FY - 30} r="260" fill="url(#campGlow)" />
                </PieceSvg>
            </Piece>
            {FLAMES.map((f, i) => (
                <Piece key={i} box={f.box} canvas={FOOTER_CANVAS} className={styles.flame} style={f.style}>
                    <PieceSvg box={f.box}><path d={f.d} fill={f.fill} /></PieceSvg>
                </Piece>
            ))}
            {SPARKS.map((sp, i) => (
                <Piece key={i} box={sp.box} canvas={FOOTER_CANVAS} className={styles.spark} style={sp.style}>
                    <PieceSvg box={sp.box}><circle cx={sp.box.x + 6} cy={sp.box.y + 6} r="4" fill="#ffd27a" /></PieceSvg>
                </Piece>
            ))}
        </>
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
                <div className={styles.sceneCanvas} aria-hidden="true">
                    <Image src={Footer} alt='' fill />
                    <Campfire />
                </div>
            </div>
        </div>
    )
}
