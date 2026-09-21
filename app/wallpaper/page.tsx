'use client'

// The hero scene as a desktop wallpaper for Wallpaper Engine (built into a folder of its own by scripts/wallpaper.mjs).
// Just the scenery, with the time, date and weather in the middle of the screen, filling the screen: nothing scrolls, and
// instead of following the scroll each layer drifts with the mouse by its depth, so the foreground trees move the most
// and the sky barely at all.

import { useEffect } from 'react'
import { animated, config, to, useSpring } from '@react-spring/web'

import { setPerf } from '@/app/perf/usePerf'
import { FullScene, type LayerProps } from '@/app/(landing)/parallax'
import styles from '@/app/(landing)/parallax/parallax.module.css'
import SceneCurtain from '@/app/(landing)/parallax/curtain'

import Clock from './clock'
import Visualizer from './visualizer'
import { NowPlayingCorner } from './nowPlaying'
import SiteLinks from './siteLinks'
import { MOTION, useSettings } from './settings'

// How far the nearest layer drifts at full strength, as a share of the screen's width (the scene is scaled up by
// twice this so its edges never come into view). Layers drift half as far up and down as they do sideways.
const MAX_SHIFT = 0.04

// The mouse position across the screen, from -1 to 1 each way, shared by every layer
const pointer = { x: 0, y: 0 }
const pointerListeners = new Set<() => void>()

if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', e => {
        pointer.x = e.clientX / window.innerWidth * 2 - 1
        pointer.y = e.clientY / window.innerHeight * 2 - 1
        pointerListeners.forEach(l => l())
    }, { passive: true })
}

function MouseLayer({ speed, className = styles.layer, style, children }: LayerProps) {
    const { parallax, strength } = useSettings()
    const [{ x, y }, api] = useSpring(() => ({ x: 0, y: 0, config: config.molasses }))

    useEffect(() => {
        const move = () => {
            const reach = parallax ? strength / 100 * MAX_SHIFT * speed * window.innerWidth : 0
            api.start({ x: -pointer.x * reach, y: -pointer.y * reach / 2 })
        }
        move()
        pointerListeners.add(move)
        return () => { pointerListeners.delete(move) }
    }, [api, speed, parallax, strength])

    return (
        <animated.div className={className} style={{ ...style, transform: to([x, y], (x, y) => `translate3d(${x}px,${y}px,0)`) }}>
            {children}
        </animated.div>
    )
}

export default function Wallpaper() {
    const settings = useSettings()
    const { parallax, strength, still, paused } = settings

    useEffect(() => setPerf(still ? 'lite' : 'full'), [still])

    // The parts of the scene switched off in the settings, for the stylesheets' html[data-still~="..."] rules
    const held = MOTION.filter(part => !settings[part]).join(' ')
    useEffect(() => { document.documentElement.dataset.still = held }, [held])

    // (plus a hair, so rounding never leaves a sliver of edge showing)
    const overscan = parallax ? 1.005 + 2 * MAX_SHIFT * strength / 100 : 1

    return (
        <>
            <div className='relative h-svh overflow-hidden bg-[#0b101f]'>
                <section className={`absolute inset-x-0 top-0 h-[200svh] ${paused ? styles.paused : ''}`}
                    style={{ transform: `scale(${overscan})`, transformOrigin: '50% 50svh' }}>
                    <FullScene Layer={MouseLayer} title={null} sound={<Visualizer />} note={false} />
                    {/* The time, date and weather, in front of the scenery, drifting at about the valley's depth */}
                    <MouseLayer speed={0.4}>
                        <Clock />
                    </MouseLayer>
                </section>
            </div>
            <NowPlayingCorner />
            <SiteLinks />
            <SceneCurtain />
        </>
    )
}
