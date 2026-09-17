import type { MetadataRoute } from 'next'

import { SITE } from './site'

export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: SITE.title,
        short_name: SITE.name,
        description: SITE.description,
        start_url: '/',
        display: 'standalone',
        background_color: SITE.colour,
        theme_color: SITE.colour,
        icons: [
            { src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' },
            { src: '/icon', sizes: '512x512', type: 'image/png' },
            { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
        ],
    }
}
