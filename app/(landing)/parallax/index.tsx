'use client'

import Head from 'next/head'
import Link from 'next/link'
import Image from 'next/image'

import { Parallax, ParallaxLayer } from '@react-spring/parallax'
import { ThemeProvider } from '@mui/material'

import DarkTheme from "@/themes/dark"

import AnimatedLogo from '../logo/index'
import ScrollIcon from '../scroll/index'

import Sky from './sky.png'
import MountainsFar from './mountainsFar.png'
import MountainsFar2 from './mountainsFar2.png'
import Lake from './lake.png'
import Trees from './trees.png'



export default function ParallaxView({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <ThemeProvider theme={DarkTheme}>
            <Parallax pages={2} className='bg-[#0f1726]'>

                <ParallaxLayer offset={0} speed={0.1} factor={2}>
                    <Image quality={100} src={Sky} alt='Sky' fill className='object-cover' />
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

                <ParallaxLayer offset={0.9} speed={1} factor={1}>
                    <div className="m-5 relative h-screen flex justify-center text-center">
                        <div className='absolute top-52'>
                            {children}
                        </div>
                    </div>
                </ParallaxLayer>

            </Parallax>
        </ThemeProvider>
    )
}