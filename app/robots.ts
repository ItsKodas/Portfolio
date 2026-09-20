import type { MetadataRoute } from 'next'

import { SITE } from './site'

export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
    return {
        rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/portal'] },
        sitemap: `${SITE.url}/sitemap.xml`,
    }
}
