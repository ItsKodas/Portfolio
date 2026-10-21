import { describe, expect, it } from 'vitest'

import { PROJECTS } from './showcase/projects'
import { SITE } from './site'
import sitemap from './sitemap'

describe('the sitemap', () => {
    it('lists every project page', () => {
        const urls = sitemap().map(e => e.url)
        for (const p of PROJECTS) expect(urls).toContain(`${SITE.url}/projects/${p.slug}`)
    })
})
