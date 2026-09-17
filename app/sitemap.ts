import type { MetadataRoute } from 'next'

import { SITE } from './site'

export const dynamic = 'force-static'

// Just the home page: the wallpaper page is kept out of search results (see app/wallpaper/layout.tsx)
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: SITE.url, lastModified: new Date(), changeFrequency: 'monthly', priority: 1 },
    ]
}
