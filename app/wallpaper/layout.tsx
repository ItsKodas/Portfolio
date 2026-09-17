import type { Metadata } from 'next'

import { SITE } from '../site'
import { MEDIA_SCRIPT } from './mediaScript'

const title = 'Live Wallpaper for Wallpaper Engine'
const description = 'The Horizons night scene as a free animated desktop wallpaper: drifting clouds, twinkling stars, a wind-blown forest and fireflies, with parallax that follows your mouse and the time, date and weather above the mountains.'

// Kept out of search results (it's the wallpaper itself rather than a page about it, and the Workshop page is the place
// to find it), but still previews nicely when shared, with the Workshop's preview image beside this file
export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: '/wallpaper' },
    robots: { index: false, follow: true },
    openGraph: { type: 'website', url: '/wallpaper', siteName: SITE.name, locale: SITE.locale, title: `${title} · ${SITE.name}`, description },
    twitter: { card: 'summary_large_image', title: `${title} · ${SITE.name}`, description },
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
