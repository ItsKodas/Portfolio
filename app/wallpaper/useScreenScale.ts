import { useEffect, useState } from 'react'

// The screen size the wallpaper's text is drawn at its natural size for (a 1080p screen shows it a little smaller)
const DESIGN_WIDTH = 2000
const DESIGN_HEIGHT = 1125

// How much the wallpaper's text is scaled for this screen: to fit the smaller of its width and height
export function useScreenScale() {
    const [scale, setScale] = useState(1)
    useEffect(() => {
        const update = () => setScale(Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT))
        update()
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
    }, [])
    return scale
}
