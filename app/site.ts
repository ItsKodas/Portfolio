// Who and what the site is, in one place: used by the page itself and by everything search engines and link previews
// read (the metadata, share images, sitemap, web app manifest and structured data). NEXT_PUBLIC_SITE_URL can point the
// absolute links somewhere else, e.g. a staging address.

export const SITE = {
    url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://horizons.gg',
    name: 'Horizons',
    author: 'Dakoda Lancelot',
    role: 'Fullstack Web Developer',
    title: 'Horizons · Dakoda Lancelot, Fullstack Web Developer',
    description: 'The portfolio of Dakoda Lancelot, a fullstack web developer building fast, modern websites and web apps with Next.js, React, TypeScript and Node.js, from scalable backends to polished frontends.',
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
