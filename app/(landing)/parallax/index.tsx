'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'

import { ThemeProvider } from '@mui/material'
import { animated, config, useSpring } from '@react-spring/web'

import DarkTheme from "@/themes/dark"

import AnimatedLogo from '../logo/index'
import CloudStream from '../clouds/index'
import Water from '../water/index'
import ScrollIcon from '../scroll/index'
import SpaceBackground from '../space/index'
import NightSky from '../stars/index'
import Fireflies from '../fireflies/index'
import Watchtower from '../watchtower/index'
import ForegroundTrees from '../trees/index'

import styles from './parallax.module.css'

import Sky from './sky.svg'
import MountainsFar from './mountainsFar.svg'
import MountainsNear from './mountainsNear.svg'
import Valley from './valley.svg'
import Forest from './forest.svg'

const CONTENT_OFFSET = 0.99 // screens from the top where the content starts
const CONTENT_SPEED  = 1

const fadeIn = {
    maskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
}

// Same motion as @react-spring/parallax's ParallaxLayer: on scroll, spring (config.slow) to an
// extra offset of -scroll * speed on top of the page's own scroll
function Layer({ speed, hidden, className = styles.layer, style, children }: { speed: number, hidden?: boolean, className?: string, style?: React.CSSProperties, children: React.ReactNode }) {
    const [{ y }, api] = useSpring(() => ({ y: 0, config: config.slow }))

    useEffect(() => {
        const onScroll = () => api.start({ y: -window.scrollY * speed })

        api.start({ y: -window.scrollY * speed, immediate: true })
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [api, speed])

    return (
        <animated.div className={className} style={{ ...style, visibility: hidden ? 'hidden' : undefined, transform: y.to(v => `translate3d(0,${v}px,0)`) }}>
            {children}
        </animated.div>
    )
}

// Dev-only toolbar for toggling hero layers
const LAYER_NAMES = ['Sky', 'Clouds', 'Far mountains', 'Logo', 'Near mountains', 'Valley', 'Water', 'Forest', 'Fireflies', 'Trees'] as const
type LayerName = typeof LAYER_NAMES[number]

function LayerToggles({ hidden, toggle }: { hidden: Set<LayerName>, toggle: (name: LayerName) => void }) {
    return (
        <div className='fixed top-2 left-1/2 -translate-x-1/2 z-50 flex flex-wrap gap-1 rounded-lg bg-black/60 px-2 py-1 text-xs backdrop-blur'>
            {LAYER_NAMES.map(name => (
                <button
                    key={name}
                    onClick={() => toggle(name)}
                    className={`rounded px-2 py-1 transition-opacity ${hidden.has(name) ? 'opacity-40 line-through' : 'bg-white/15'}`}
                >
                    {name}
                </button>
            ))}
        </div>
    )
}

export default function ParallaxView({ children }: Readonly<{ children: React.ReactNode }>) {
    const contentRef = useRef<HTMLDivElement>(null)
    const [pageHeight, setPageHeight] = useState<number>()
    const [hidden, setHidden] = useState<Set<LayerName>>(new Set())
    const toggle = (name: LayerName) => setHidden(prev => {
        const next = new Set(prev)
        if (next.has(name)) next.delete(name); else next.add(name)
        return next
    })
    const off = (name: LayerName) => hidden.has(name)

    // The content moves at (1 + speed)x the scroll, so the page only needs enough scroll
    // for its bottom to reach the bottom of the screen at that rate
    const recalc = useCallback(() => {
        if (!contentRef.current) return
        const vh = window.innerHeight
        const contentHeight = contentRef.current.offsetHeight
        const maxScroll = Math.max((CONTENT_OFFSET * vh + contentHeight - vh) / (1 + CONTENT_SPEED), 0)
        setPageHeight(vh + maxScroll)
    }, [])

    useEffect(() => {
        recalc()
        const observer = new ResizeObserver(recalc)
        if (contentRef.current) observer.observe(contentRef.current)
        window.addEventListener('resize', recalc)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', recalc)
        }
    }, [recalc])

    return (
        <ThemeProvider theme={DarkTheme}>
            {process.env.NODE_ENV === 'development' && <LayerToggles hidden={hidden} toggle={toggle} />}
            <div className='relative overflow-hidden bg-[#0b101f]' style={{ height: pageHeight ?? '100svh' }}>

                {/* ── Hero scene ─────────────────────────────────────── */}

                <section className='absolute inset-x-0 top-0 h-[200svh]'>
                    <Layer speed={0.1} hidden={off('Sky')}>
                        <Image priority src={Sky} alt='Sky' fill className='object-cover' />
                        <NightSky />
                    </Layer>

                    <Layer speed={0.15} hidden={off('Clouds')}>
                        <CloudStream />
                    </Layer>

                    <Layer speed={0.2} hidden={off('Far mountains')}>
                        <Image priority src={MountainsFar} alt='MountainsFar' fill className='object-cover' />
                    </Layer>

                    <Layer speed={0.005} hidden={off('Logo')}>
                        <AnimatedLogo />
                    </Layer>

                    <Layer speed={0.5} hidden={off('Near mountains')}>
                        <Image priority src={MountainsNear} alt='' fill className='object-cover' />
                    </Layer>

                    <Layer speed={0.6} hidden={off('Valley')}>
                        <Image priority src={Valley} alt='' fill className='object-cover' />
                        <Watchtower />
                        {/* visibility: visible keeps the water showing even when the valley itself is hidden */}
                        {!off('Water') && <div className='absolute inset-0' style={{ visibility: 'visible' }}><Water /></div>}
                    </Layer>

                    <Layer speed={0.75} hidden={off('Forest')}>
                        <Image priority src={Forest} alt='' fill className='object-cover' />
                    </Layer>

                    {/* Same speed as the valley, so they stay over the slopes they were painted on */}
                    <Layer speed={0.6} hidden={off('Fireflies')}>
                        <Fireflies />
                    </Layer>

                    <Layer speed={1} hidden={off('Trees')}>
                        <ForegroundTrees />
                    </Layer>

                    <Layer speed={0.6}>
                        <div className="relative h-svh flex justify-center">
                            <div className='absolute bottom-[30%]'>
                                <ScrollIcon />
                            </div>
                        </div>
                    </Layer>
                </section>

                {/* ── Content ────────────────────────────────────────── */}

                <Layer speed={CONTENT_SPEED} className='absolute inset-x-0' style={{ top: `${CONTENT_OFFSET * 100}svh`, willChange: 'transform' }}>
                    <div ref={contentRef} className='relative'>
                        <div className='absolute inset-0' style={fadeIn}>
                            <SpaceBackground />
                        </div>

                        <div className='relative' style={fadeIn}>
                            {children}
                        </div>
                    </div>
                </Layer>

            </div>
        </ThemeProvider>
    )
}
