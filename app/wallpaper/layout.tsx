import type { Metadata } from 'next'

export const metadata: Metadata = {
    title: 'Horizons Wallpaper',
    robots: { index: false },
}

export default function WallpaperLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return children
}
