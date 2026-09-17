// Who and what the site is, in one place: used by the page itself and by everything search engines and link previews
// read (the metadata, share images, sitemap, web app manifest and structured data). NEXT_PUBLIC_SITE_URL can point the
// absolute links somewhere else, e.g. a staging address.
//
// The url is the www host on purpose: it is the one behind Cloudflare with a certificate covering it. The bare
// horizons.gg resolves straight to the origin box, which answers with someone else's certificate, so every absolute
// link built from it (the share image above all) fails TLS for crawlers. If the apex is ever put behind Cloudflare
// too, this can go back to https://horizons.gg.

// The two lines the hero opens on, kept here so the page, the title tag and the share image cannot drift apart
const name = 'Horizons'
const tagline = 'Fullstack Web Development'

export const SITE = {
    url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.horizons.gg',
    name,
    tagline,
    author: 'Dakoda Lancelot',
    role: 'Fullstack Web Developer',
    title: `${name} · ${tagline}`,
    // First person, and plainly put: it is my own site, so it says what I build rather than how well I build it
    description: "I'm Koda, a fullstack web developer. I build websites and web apps with Next.js, React, TypeScript and Node.js, from the backend through to the frontend.",
    // The scene's navy, for browser chrome and the share image
    colour: '#0b101f',
    locale: 'en_AU',
}

export const SOCIALS = [
    { label: 'GitHub', href: 'https://github.com/ItsKodas' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/dakoda-lancelot' },
    { label: 'YouTube', href: 'https://www.youtube.com/channel/UC_3OvoziBu-ztAK9PlAz9Mw' },
    { label: 'Instagram', href: 'https://www.instagram.com/itskodas' },
] as const

export const SKILLS = ['Next.js', 'React', 'TypeScript', 'Node.js', 'Tailwind CSS', 'PostgreSQL', 'MongoDB', 'Docker', 'Prisma', 'MUI', 'Git']
