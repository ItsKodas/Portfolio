'use client'

import Image from 'next/image'
import { Typography } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useSpring, animated } from '@react-spring/web'

import './logo.css'
import Logo from './logo.png'



function getWindowDimensions() {
    const { innerWidth: width, innerHeight: height } = window
    return { width, height }
}



export default function AnimatedLogo({ screenHeight }: { screenHeight?: boolean }) {

    const [windowDimensions, setWindowDimensions] = useState(getWindowDimensions())
    const [topDistance, setTopDistance] = useState<number | string>(0)
    const [logoZoom, setLogoZoom] = useState(1)
    const [screenRatio, setScreenRatio] = useState(1)


    useEffect(() => {
        function handleResize() {
            setWindowDimensions(getWindowDimensions())
        }

        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    useEffect(() => {
        const ratio = windowDimensions.width / windowDimensions.height
        setScreenRatio(ratio)

        if (ratio >= 2.4) return setTopDistance(200 / ratio)
        if (ratio >= 2.15) return setTopDistance('8%')
        if (ratio >= 1.8) return setTopDistance('11%')
        if (ratio >= 1) return setTopDistance('18%')
        if (ratio < 1) return setTopDistance('40%')
    }, [windowDimensions])

    useEffect(() => {
        setLogoZoom(windowDimensions.width >= windowDimensions.height ? (windowDimensions.width * 0.0005) : (windowDimensions.width * 0.0009))
    }, [topDistance])



    //? Animations

    const translateLogo = useSpring({
        from: { opacity: 0, marginTop: 1000 },
        to: { opacity: 1, marginTop: 0 },
        delay: 500,
        config: { tension: 250, friction: 100 }
    })

    const translateTitleDesktop = useSpring({
        from: { maxWidth: 0 },
        to: { maxWidth: 800 },
        delay: 2000,
        config: { tension: 200, friction: 100 }
    })



    return (
        <>
            <div className={`flex justify-center items-center gap-5 select-none`} style={{ marginTop: topDistance, transform: `scale(${logoZoom})` }}>
                <animated.div style={translateLogo}>
                    <div className='w-[140px] h-[140px] relative'>
                        <Image src={Logo} alt='Logo' fill className='object-cover' />
                    </div>
                </animated.div>

                <animated.div style={translateTitleDesktop}>
                    <div>
                        <Typography variant='h1' fontSize={'8rem'} letterSpacing={'10px'} fontWeight={700} className="overflow-hidden">HORIZONS</Typography>
                        <Typography variant='h2' fontSize={'2.25rem'} letterSpacing={'11px'} className="pl-2 subtitle overflow-hidden text-nowrap">Fullstack Web Development</Typography>
                        {/* <h2 className='ml-2 text-2xl overflow-hidden text-nowrap'>Z: {(windowDimensions.width * 0.0006).toFixed(2)} | H: {windowDimensions.height}px | W: {windowDimensions.width}px | R: {(windowDimensions.width / windowDimensions.height).toFixed(2)}</h2> */}
                    </div>
                </animated.div>
            </div>
        </>
    )
}