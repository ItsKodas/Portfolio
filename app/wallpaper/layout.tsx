import type { Metadata } from 'next'

import { MEDIA_SCRIPT } from './mediaScript'

export const metadata: Metadata = {
    title: 'Horizons Wallpaper',
    robots: { index: false },
}

export default function WallpaperLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <>
            {/* Registers for what's playing before anything else runs, as Wallpaper Engine asks (see media.ts) */}
            <script dangerouslySetInnerHTML={{ __html: MEDIA_SCRIPT }} />
            {children}
        </>
    )
}
