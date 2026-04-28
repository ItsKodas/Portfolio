'use client'

import Image from 'next/image'

import { Parallax, ParallaxLayer } from '@react-spring/parallax'
import { ThemeProvider } from '@mui/material'

import DarkTheme from "@/themes/dark"

import AnimatedLogo from '../logo/index'
import ScrollIcon from '../scroll/index'
import SpaceBackground from '../space/index'
import RotatingStars from '../stars/index'

import Sky from './sky.png'
import MountainsFar from './mountainsFar.png'
import MountainsFar2 from './mountainsFar2.png'
import Lake from './lake.png'
import Trees from './trees.svg'



export default function ParallaxView({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <ThemeProvider theme={DarkTheme}>
            <Parallax pages={3} className='bg-[#0b101f]'>

                {/* ── Hero scene ─────────────────────────────────────── */}

                <ParallaxLayer offset={0} speed={0.1} factor={2}>
                    <Image quality={100} src={Sky} alt='Sky' fill className='object-cover' />
                    <RotatingStars />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.2} factor={2}>
                    <Image quality={100} src={MountainsFar} alt='MountainsFar' fill className='object-cover' />
                </ParallaxLayer>

                <ParallaxLayer offset={0} speed={0.005} factor={1}>
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

                {/* ── Space background (content section) ─────────────── */}

                <ParallaxLayer offset={0.99} speed={1} factor={2}>
                    <div
                        style={{
                            height: '100%',
                            maskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10rem)',
                        }}
                    >
                        <SpaceBackground />
                    </div>
                </ParallaxLayer>

                {/* ── Content ────────────────────────────────────────── */}

                <ParallaxLayer offset={0.99} speed={1} factor={2}>
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
