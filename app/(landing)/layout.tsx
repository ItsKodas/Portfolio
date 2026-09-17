import React from 'react'

import { SITE, SKILLS, SOCIALS } from '../site'
import ParallaxView from './parallax'

// Structured data for search engines: who the site belongs to and what they do, so results can show them as a person
// with their profiles rather than just a page
const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
        {
            '@type': 'WebSite',
            '@id': `${SITE.url}/#website`,
            url: SITE.url,
            name: SITE.name,
            description: SITE.description,
            inLanguage: 'en-AU',
            publisher: { '@id': `${SITE.url}/#person` },
        },
        {
            '@type': 'Person',
            '@id': `${SITE.url}/#person`,
            name: SITE.author,
            url: SITE.url,
            image: `${SITE.url}/icon`,
            jobTitle: SITE.role,
            knowsAbout: SKILLS,
            sameAs: SOCIALS.map(s => s.href),
        },
        {
            '@type': 'ProfilePage',
            '@id': `${SITE.url}/#profile`,
            url: SITE.url,
            name: SITE.title,
            isPartOf: { '@id': `${SITE.url}/#website` },
            mainEntity: { '@id': `${SITE.url}/#person` },
        },
    ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <ParallaxView>
            {/* (escaped so nothing in the data can close the script tag early) */}
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
            {children}
        </ParallaxView>
    )
}
