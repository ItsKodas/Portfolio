'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'

import { IParallax, Parallax, ParallaxLayer } from '@react-spring/parallax'
import { ThemeProvider } from '@mui/material'

import DarkTheme from "@/themes/dark"

import AnimatedLogo from '../logo/index'
import ScrollIcon from '../scroll/index'
import SpaceBackground from '../space/index'
import RotatingStars from '../stars/index'

import styles from './parallax.module.css'

import Sky from './sky.png'
import Clouds from './clouds.png'
import MountainsFar from './mountainsFar.png'
import MountainsFar2 from './mountainsFar2.png'
import Lake from './lake.png'
import Trees from './trees.svg'

export default function ParallaxView({ children }: Readonly<{ children: React.ReactNode }>) {
    const parallaxRef   = useRef<IParallax>(null)
    const measureRef    = useRef<HTMLDivElement>(null)
    const [pages, setPages] = useState(2)
    const [contentFactor, setContentFactor] = useState(1)
    const [scrollbarW, setScrollbarW] = useState(0)

    useEffect(() => {
        const el = document.createElement('div')
        el.style.cssText = 'width:100px;height:100px;overflow:scroll;position:fixed;visibility:hidden;top:-200px'
        document.body.appendChild(el)
        setScrollbarW(el.offsetWidth - el.clientWidth)
        document.body.removeChild(el)
    }, [])

    const recalc = useCallback(() => {
        if (!measureRef.current) return
        const contentH = measureRef.current.offsetHeight
        const vh       = window.innerHeight || 1
        const factor   = Math.max(contentH / vh, 1)
        setContentFactor(factor)
        setPages(1 + factor)
    }, [])

    useEffect(() => {
        recalc()
        const ro = new ResizeObserver(recalc)
        if (measureRef.current) ro.observe(measureRef.current)
        window.addEventListener('resize', recalc)
        return () => {
            ro.disconnect()
            window.removeEventListener('resize', recalc)
        }
    }, [recalc])

    return (
        <ThemeProvider theme={DarkTheme}>

            {/* Invisible measurement clone — fixed outside the parallax at true viewport width */}
            <div
                ref={measureRef}
                aria-hidden="true"
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    width: `calc(100% - ${scrollbarW}px)`,
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    zIndex: -9999,
                    overflow: 'clip',
                }}
            >
                {children}
            </div>

            <Parallax ref={parallaxRef} pages={pages} className='bg-[#0b101f]'>

                {/* ── Hero scene ─────────────────────────────────────── */}

                <ParallaxLayer offset={0} speed={0.1} factor={2}>
                    <Image quality={100} src={Sky} alt='Sky' fill className='object-cover' />
                    <RotatingStars />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.15} factor={2}>
                    <div className={styles.cloudDrift} style={{ position: 'relative', width: '100%', height: '100%' }}>
                        <Image quality={100} src={Clouds} alt='Clouds' fill className='object-cover' />
                    </div>
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.2} factor={2}>
                    <Image quality={100} src={MountainsFar} alt='MountainsFar' fill className='object-cover' />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.005} factor={2}>
                    <AnimatedLogo screenHeight />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.5} factor={2}>
                    <Image quality={100} src={MountainsFar2} alt='MountainsFar2' fill className='object-cover' />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.6} factor={2}>
                    <Image quality={100} src={Lake} alt='Lake' fill className='object-cover' />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={1} factor={2}>
                    <Image quality={100} src={Trees} alt='Trees' fill className='object-cover' />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.6} factor={2}>
                    <div className="relative h-screen flex justify-center">
                        <div className='absolute bottom-[30%]'>
                            <ScrollIcon />
                        </div>
                    </div>
                </ParallaxLayer>

                {/* ── Space background ───────────────────────────────── */}

                <ParallaxLayer offset={0.99} speed={1} factor={contentFactor}>
                    <div style={{
                        height: '100%',
                        maskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                    }}>
                        <SpaceBackground />
                    </div>
                </ParallaxLayer>

                {/* ── Content ────────────────────────────────────────── */}

                <ParallaxLayer offset={0.99} speed={1} factor={contentFactor}>
                    <div
                        className='relative w-full'
                        style={{
                            maskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                        }}
                    >
                        {children}
                    </div>
                </ParallaxLayer>

            </Parallax>
        </ThemeProvider>
    )
}
