import React from 'react'

import ParallaxView from './parallax'



export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <ParallaxView>
            {children}
        </ParallaxView>
    )
}