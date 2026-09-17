'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'

import { ThemeProvider } from '@mui/material'
import { animated, config, useSpring } from '@react-spring/web'

import DarkTheme from "@/themes/dark"
import { useLite, watchFrameRate } from '@/app/perf/usePerf'

import AnimatedLogo from '../logo/index'
import CloudStream from '../clouds/index'
import Water from '../water/index'
import ScrollIcon from '../scroll/index'
import NightBackdrop from '../night/index'
import NightSky from '../stars/index'
import Fireflies from '../fireflies/index'
import Watchtower from '../watchtower/index'
import ForegroundTrees from '../trees/index'

import ScrollbarTint from './scrollbarTint'
import UiToggle from './uiToggle'
import styles from './parallax.module.css'

import Sky from './sky.svg'
import MountainsFar from './mountainsFar.svg'
import MountainsNear from './mountainsNear.svg'
import Valley from './valley.svg'
import Forest from './forest.svg'

const CONTENT_OFFSET = 0.96 // screens from the top where the content starts
const CONTENT_SPEED  = 1

const fadeIn = {
    maskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
}

export type LayerProps = { speed: number, className?: string, style?: React.CSSProperties, children: React.ReactNode }

// Same motion as @react-spring/parallax's ParallaxLayer: on scroll, spring (config.slow) to an
// extra offset of -scroll * speed on top of the page's own scroll
function ScrollLayer({ speed, className = styles.layer, style, children }: LayerProps) {
    const [{ y }, api] = useSpring(() => ({ y: 0, config: config.slow }))

    useEffect(() => {
        const onScroll = () => api.start({ y: -window.scrollY * speed })

        api.start({ y: -window.scrollY * speed, immediate: true })
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [api, speed])

    return (
        <animated.div className={className} style={{ ...style, transform: y.to(v => `translate3d(0,${v}px,0)`) }}>
            {children}
        </animated.div>
    )
}

// The lite hero's layer: follows the scroll directly, with no spring to keep it moving afterwards, written straight onto
// the element from the scroll event (which already comes once a frame)
function LiteLayer({ speed, className = styles.layer, style, children }: LayerProps) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const el = ref.current
        if (!el) return
        const onScroll = () => { el.style.transform = `translate3d(0,${-window.scrollY * speed}px,0)` }

        onScroll()
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [speed])

    return <div ref={ref} className={className} style={style}>{children}</div>
}

// The full hero: every part of the scene at its own depth, each springing after the scroll. The desktop wallpaper
// (app/wallpaper) shows the same scene with layers that follow the mouse instead, and without the hero's links and note.
export function FullScene({ ui, Layer = ScrollLayer, wallpaper = false }: { ui: string, Layer?: React.ComponentType<LayerProps>, wallpaper?: boolean }) {
    return (
        <>
            <Layer speed={0.1}>
                <Image priority src={Sky} alt='Sky' fill className='object-cover' />
                <NightSky />
            </Layer>

            <Layer speed={0.15}>
                <CloudStream />
            </Layer>

            <Layer speed={0.2}>
                <Image priority src={MountainsFar} alt='MountainsFar' fill className='object-cover' />
            </Layer>

            <Layer speed={0.005}>
                <div className={`absolute inset-0 ${ui}`}>
                    <AnimatedLogo links={!wallpaper} />
                </div>
            </Layer>

            <Layer speed={0.5}>
                <Image priority src={MountainsNear} alt='' fill className='object-cover' />
            </Layer>

            <Layer speed={0.6}>
                <Image priority src={Valley} alt='' fill className='object-cover' />
                <Watchtower />
                <Water />
            </Layer>

            {/* The note pointing down to the work, moving with the valley, and behind the forest and trees so they
                cover it as the page scrolls */}
            {!wallpaper && (
                <Layer speed={0.6}>
                    <div className={`relative h-svh flex justify-center ${ui}`}>
                        <div className='absolute bottom-[20%]'>
                            <ScrollIcon />
                        </div>
                    </div>
                </Layer>
            )}

            <Layer speed={0.75}>
                <Image priority src={Forest} alt='' fill className='object-cover' />
            </Layer>

            {/* Same speed as the valley, so they stay over the slopes they were painted on */}
            <Layer speed={0.6}>
                <Fireflies />
            </Layer>

            <Layer speed={1}>
                <ForegroundTrees />
            </Layer>
        </>
    )
}

// The lite hero, for browsers that can't keep up with the full one (usually drawing without the graphics card): the
// same scene at three depths instead of ten, so there are far fewer screen-sized layers to move. The sky, clouds, far
// mountains and logo stay put and scroll with the page; the near mountains, valley, lake, note, forest and fireflies
// move together at the valley's speed; the foreground trees move on their own. (The stylesheets switch the scenery's
// own animations off.)
function LiteScene({ ui }: { ui: string }) {
    return (
        <>
            <div className={`${styles.layer} ${styles.still}`}>
                <Image priority src={Sky} alt='Sky' fill className='object-cover' />
                <NightSky />
                <CloudStream />
                <Image priority src={MountainsFar} alt='MountainsFar' fill className='object-cover' />
                <div className={`absolute inset-0 ${ui}`}>
                    <AnimatedLogo />
                </div>
            </div>

            <LiteLayer speed={0.6}>
                <Image priority src={MountainsNear} alt='' fill className='object-cover' />
                <Image priority src={Valley} alt='' fill className='object-cover' />
                <Watchtower />
                <Water />
                <div className={`absolute inset-x-0 top-0 h-svh flex justify-center ${ui}`}>
                    <div className='absolute bottom-[20%]'>
                        <ScrollIcon />
                    </div>
                </div>
                <Image priority src={Forest} alt='' fill className='object-cover' />
                <Fireflies />
            </LiteLayer>

            <LiteLayer speed={1}>
                <ForegroundTrees />
            </LiteLayer>
        </>
    )
}

export default function ParallaxView({ children }: Readonly<{ children: React.ReactNode }>) {
    const lite = useLite()
    const ContentLayer = lite ? LiteLayer : ScrollLayer

    const [pageHeight, setPageHeight] = useState<number>()
    // Whether the hero's title, buttons and note are hidden, leaving just the scenery
    const [uiHidden, setUiHidden] = useState(false)
    const ui = `${styles.ui} ${uiHidden ? styles.uiHidden : ''}`

    // Time the first frames, and fall back to the lite hero if the browser can't keep up
    useEffect(() => watchFrameRate(), [])

    // The content moves at (1 + speed)x the scroll, so the page only needs enough scroll
    // for its bottom to reach the bottom of the screen at that rate. (Switching modes remounts the content, so it's
    // measured through a callback ref, which follows it to the new element.)
    const [content, setContent] = useState<HTMLDivElement | null>(null)
    const recalc = useCallback(() => {
        if (!content) return
        const vh = window.innerHeight
        const maxScroll = Math.max((CONTENT_OFFSET * vh + content.offsetHeight - vh) / (1 + CONTENT_SPEED), 0)
        setPageHeight(vh + maxScroll)
    }, [content])

    useEffect(() => {
        recalc()
        const observer = new ResizeObserver(recalc)
        if (content) observer.observe(content)
        window.addEventListener('resize', recalc)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', recalc)
        }
    }, [content, recalc])

    // Pause the hero's animations once the content has scrolled up over it and the scene is out of sight (the content
    // top sits CONTENT_OFFSET screens down and rises 1 + CONTENT_SPEED pixels per pixel scrolled). The lite hero is also
    // taken out of drawing altogether once the content's faded top edge has passed as well. (The full hero's springs
    // trail the scroll, so part of it can still be showing for a moment; it keeps drawing.)
    const heroRef = useRef<HTMLElement>(null)
    useEffect(() => {
        let frame = 0
        const update = () => {
            frame = 0
            const risen = window.scrollY * (1 + CONTENT_SPEED) - CONTENT_OFFSET * window.innerHeight
            const fade = 10 * parseFloat(getComputedStyle(document.documentElement).fontSize)
            heroRef.current?.classList.toggle(styles.paused, risen > 40)
            heroRef.current?.classList.toggle(styles.gone, lite && risen > fade + 40)
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
        update()
        window.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('resize', onScroll)
        return () => {
            window.removeEventListener('scroll', onScroll)
            window.removeEventListener('resize', onScroll)
            if (frame) cancelAnimationFrame(frame)
        }
    }, [lite])

    return (
        <ThemeProvider theme={DarkTheme}>
            <ScrollbarTint />
            <UiToggle hidden={uiHidden} onToggle={() => setUiHidden(h => !h)} />
            <div className='relative overflow-hidden bg-[#0b101f]' style={{ height: pageHeight ?? '100svh' }}>

                {/* ── Hero scene ─────────────────────────────────────── */}

                <section ref={heroRef} className='absolute inset-x-0 top-0 h-[200svh]'>
                    {lite ? <LiteScene ui={ui} /> : <FullScene ui={ui} />}
                </section>

                {/* ── Content ────────────────────────────────────────── */}

                <ContentLayer speed={CONTENT_SPEED} className='absolute inset-x-0' style={{ top: `${CONTENT_OFFSET * 100}svh`, willChange: 'transform' }}>
                    {/* Sized by the content itself (the page height is worked out from it), plus room for the scene the page ends on */}
                    <div ref={setContent} className='relative'>
                        <div className='absolute inset-0' style={fadeIn}>
                            <NightBackdrop />
                        </div>

                        <div className='relative' style={fadeIn}>
                            {children}
                        </div>
                        {/* Room for the campfire scene at the bottom: most of its height, as its top is open sky the content can sit over */}
                        <div aria-hidden className='relative' style={{ height: 'max(170px, calc(100vw * 1400 / 3840 * 0.65))' }} />
                    </div>
                </ContentLayer>

            </div>
        </ThemeProvider>
    )
}
