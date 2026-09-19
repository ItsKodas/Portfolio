import type { MetadataRoute } from 'next'

import { SITE } from './site'

export const dynamic = 'force-static'

// The home page and the quote form: the wallpaper page is kept out of search results (see app/wallpaper/layout.tsx),
// and the admin area is disallowed in robots.ts
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: SITE.url, lastModified: new Date(), changeFrequency: 'monthly', priority: 1 },
        { url: `${SITE.url}/quote`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.8 },
    ]
}
