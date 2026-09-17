'use client'

import Image from 'next/image'
import { Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useSpring, animated, to } from '@react-spring/web'

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

export default function AnimatedLogo() {
    const slotRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(1)

    // The slot is positioned and sized in the art's own coordinates (see logo.module.css); scale the logo to fill it
    useEffect(() => {
        const slot = slotRef.current
        if (!slot) return
        const observer = new ResizeObserver(() => setScale(slot.offsetWidth / NATURAL_WIDTH))
        observer.observe(slot)
        return () => observer.disconnect()
    }, [])



    //? Animations
    // Same choreography as before, reworked to move only with transforms and clipping (no layout changes, so no
    // re-centring jitter): the icon rises up from behind the mountains, then eases over to the left with the title
    // unrolling out of its side, and once the title is out the subtitle slides down from underneath it.

    const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
                <div className={`${styles.row} flex justify-center items-center select-none`} style={{ gap: GAP, transform: `translate(-50%, -50%) scale(${scale})` }}>
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
        </div>
    )
}
