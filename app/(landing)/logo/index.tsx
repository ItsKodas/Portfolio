'use client'

import Image from 'next/image'
import { Typography } from '@mui/material'
import { SportsEsports, Casino } from '@mui/icons-material'
import { useEffect, useRef, useState } from 'react'
import { useSpring, animated, to } from '@react-spring/web'

import { useLite } from '@/app/perf/usePerf'

import styles from './logo.module.css'
import Logo from './logo.png'

// The logo row at its natural size (icon, gap and title), which is scaled to fit its slot
const TITLE_WIDTH = 800
const GAP = 20
const NATURAL_WIDTH = 140 + GAP + TITLE_WIDTH
const SUBTITLE_TUCK = 16 // the subtitle is pulled up into the space below the title's letters (room for descenders)
// Vertical offset of the title block (measured from the rendered letters, not the text boxes, which carry extra
// room above and below): with the subtitle hidden the title's capitals are centred on the icon, and once the
// subtitle is in, the capitals' top lines up with the icon's top and the subtitle's baseline with its bottom
const TITLE_ALONE_Y = 12.7
const TITLE_WITH_SUBTITLE_Y = -12

// (links: whether the buttons under the title are shown; the desktop wallpaper leaves them out)
export default function AnimatedLogo({ links = true }: { links?: boolean }) {
    const slotRef = useRef<HTMLDivElement>(null)
    const rowRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(1)
    const [rowHeight, setRowHeight] = useState(0)


    // The slot is positioned and sized in the art's own coordinates (see logo.module.css); scale the logo to fill it
    useEffect(() => {
        const slot = slotRef.current
        if (!slot) return
        const observer = new ResizeObserver(() => {
            setScale(slot.offsetWidth / NATURAL_WIDTH)
            setRowHeight(rowRef.current?.offsetHeight ?? 0)
        })
        observer.observe(slot)
        return () => observer.disconnect()
    }, [])



    //? Animations
    // Same choreography as before, reworked to move only with transforms and clipping (no layout changes, so no
    // re-centring jitter): the icon rises up from behind the mountains, then eases over to the left with the title
    // unrolling out of its side, and once the title is out the subtitle slides down from underneath it.

    // (Shown straight away, with no intro, for reduced motion and in the lite hero)
    const lite = useLite()
    const reduceMotion = lite || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

    const rise = useSpring({
        from: { y: 420, opacity: 0 },
        to: { y: 0, opacity: 1 },
        delay: 400,
        immediate: reduceMotion,
        config: { mass: 1.4, tension: 120, friction: 26 },
    })

    // 0 = title hidden and the icon centred on its own, 1 = title fully out and the row in its final place
    // Once the title is fully out, the subtitle slides down from underneath it
    const subtitleStarted = useRef(false)
    const [subtitle, subtitleApi] = useSpring(() => ({ p: 0, config: { tension: 90, friction: 20, clamp: true } }))
    const unroll = useSpring({
        from: { p: 0 },
        to: { p: 1 },
        delay: 1500,
        immediate: reduceMotion,
        config: { tension: 38, friction: 17, clamp: true },
        // (starts as soon as the title looks fully out, rather than waiting for the spring's long, invisible tail)
        onChange: ({ value }) => {
            if (value.p < 0.97 || subtitleStarted.current) return
            subtitleStarted.current = true
            subtitleApi.start({ p: 1, delay: 80, immediate: reduceMotion })
        },
    })

    // How far the icon sits to the right while the title is still hidden: half the title's width plus the gap
    const ICON_SHIFT = (TITLE_WIDTH + GAP) / 2

    return (
        <div className={styles.canvas}>
            <div ref={slotRef} className={styles.slot}>
                <div ref={rowRef} className={`${styles.row} flex justify-center items-center select-none`} style={{ gap: GAP, transform: `translate(-50%, -50%) scale(${scale})` }}>
                    <animated.div style={{
                        opacity: rise.opacity,
                        transform: to([rise.y, unroll.p], (y, p) => `translate(${(1 - p) * ICON_SHIFT}px, ${y}px)`),
                    }}>
                        <div className='w-[140px] h-[140px] relative'>
                            <Image src={Logo} alt='Logo' fill className='object-cover' />
                        </div>
                    </animated.div>

                    {/* Travels with the icon, unrolling out of its right-hand edge, so the icon never passes over the text */}
                    {/* While the subtitle is still hidden the title sits level with the icon, then rises as the subtitle comes in, ending
                        with the two lines spanning the icon's height */}
                    <animated.div style={{
                        width: TITLE_WIDTH,
                        transform: to([unroll.p, subtitle.p], (p, q) => `translate(${(1 - p) * ICON_SHIFT}px, ${(TITLE_ALONE_Y + (TITLE_WITH_SUBTITLE_Y - TITLE_ALONE_Y) * q).toFixed(2)}px)`),
                    }}>
                        <animated.div style={{
                            clipPath: unroll.p.to(p => `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`),
                        }}>
                            <Typography variant='h1' fontSize={'8rem'} letterSpacing={'10px'} fontWeight={700} className="text-nowrap">HORIZONS</Typography>
                        </animated.div>
                        {/* Hidden above its own top edge (tucked under the title) and slides down into place */}
                        <div className="overflow-hidden" style={{ marginTop: -SUBTITLE_TUCK }}>
                            <animated.div style={{
                                transform: subtitle.p.to(p => `translateY(${((1 - p) * -100).toFixed(2)}%)`),
                                opacity: subtitle.p,
                            }}>
                                <Typography variant='h2' fontSize={'2.25rem'} letterSpacing={'11px'} className="pl-2 subtitle text-nowrap">Fullstack Web Development</Typography>
                            </animated.div>
                        </div>
                    </animated.div>
                </div>
            </div>

            {/* Links under the title, rising into place as the subtitle finishes coming in: just below the logo row, scaled
                with it, and like the logo tucked slightly behind the near mountains. On small screens the logo is scaled right
                down, so the buttons get some of that back to stay easy to tap. */}
            {links && <div className={styles.slot}>
                <animated.div className="absolute left-1/2 top-0 flex gap-6 select-none" style={{
                    opacity: subtitle.p.to(q => Math.max(0, (q - 0.5) / 0.5)),
                    transform: subtitle.p.to(q => `translate(-50%, ${((rowHeight / 2 + 4 + (1 - q) * 30) * scale).toFixed(1)}px) scale(${(scale * Math.min(1.6, Math.max(1, 0.55 / scale))).toFixed(3)})`),
                    transformOrigin: 'top center',
                    pointerEvents: subtitle.p.to(q => q > 0.9 ? 'auto' : 'none'),
                }}>
                    {HERO_LINKS.map(({ label, href, icon: Icon, primary }) => (
                        <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                            className={`flex items-center gap-3 whitespace-nowrap rounded-full border-2 px-8 py-3.5 text-[23px] font-semibold tracking-wide backdrop-blur-md transition-all duration-300 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50 ${primary
                                ? 'border-white/80 bg-white/90 text-[#27336b] hover:bg-white shadow-[0_10px_40px_-10px_rgba(255,255,255,0.45)]'
                                : 'border-white/60 bg-white/[0.08] text-white hover:bg-white/[0.18] hover:border-white'}`}>
                            <Icon sx={{ fontSize: 28 }} />
                            {label}
                        </a>
                    ))}
                </animated.div>
            </div>}
        </div>
    )
}

// Buttons under the hero title (drawn at the logo's natural size, and scaled with it)
const HERO_LINKS = [
    { label: 'Game Panel', href: 'https://pelican.horizons.gg', icon: SportsEsports, primary: true },
    { label: 'The Back Room', href: 'https://thebackroom.dev', icon: Casino, primary: false },
]
