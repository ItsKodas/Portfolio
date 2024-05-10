import { Parallax, ParallaxLayer } from '@react-spring/parallax'

import AnimatedLogo from '../components/logo'
import ScrollIcon from '../assets/svg/scroll'



export default function ParallaxView({ children }: { children?: any }) {
    return (
        <Parallax pages={1.5}>
            <ParallaxLayer offset={0} speed={0.1} factor={2}
                style={{
                    backgroundImage: 'url(/parallax/sky.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                }}
            />

            <ParallaxLayer offset={0} speed={0.2} factor={2}
                style={{
                    backgroundImage: 'url(/parallax/mountainsFar.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                }}
            />

            <ParallaxLayer offset={0} speed={0.005} factor={1}>
                <AnimatedLogo screenHeight />
            </ParallaxLayer>

            <ParallaxLayer offset={0} speed={0.5} factor={2}
                style={{
                    backgroundImage: 'url(/parallax/mountainsFar2.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                }}
            />

            <ParallaxLayer offset={0} speed={0.6} factor={2}
                style={{
                    backgroundImage: 'url(/parallax/lake.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                }}
            />

            <ParallaxLayer offset={0} speed={1} factor={2}
                style={{
                    backgroundImage: 'url(/parallax/trees.png)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                }}
            />

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
    )
}