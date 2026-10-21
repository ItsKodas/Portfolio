// Every project on the site, in one place: the home page's featured cards and list, and each project's own page at
// /projects/<slug>, all read from here. Kept as plain data with pure helpers so both a client component and a server
// page can import it.
//
// The copy follows the spec's rules (docs/superpowers/specs/2026-10-21-projects-showcase-design.md): first person,
// plain and specific, numbers only as the project's own README states them, and no em dashes. projects.test.ts holds
// the rules that can be checked.

export type Category = 'website' | 'web-app' | 'desktop-app' | 'mobile-app' | 'game' | 'mod'

// The category tabs, in the order they appear
export const CATEGORIES: { id: Category, label: string }[] = [
    { id: 'website', label: 'Websites' },
    { id: 'web-app', label: 'Web apps' },
    { id: 'desktop-app', label: 'Desktop apps' },
    { id: 'mobile-app', label: 'Mobile apps' },
    { id: 'game', label: 'Games' },
    { id: 'mod', label: 'Mods' },
]

export const CATEGORY_NAME: Record<Category, string> = {
    'website': 'Website',
    'web-app': 'Web app',
    'desktop-app': 'Desktop app',
    'mobile-app': 'Mobile app',
    'game': 'Game',
    'mod': 'Mod',
}

export type Context = 'client' | 'personal' | 'community'

export const CONTEXT_LABEL: Record<Context, string> = {
    client: 'Client project',
    personal: 'Personal project',
    community: 'Community project',
}

// How it was made: written by hand, with Claude, or a mix (which then needs a note saying how)
export type Built = 'hand' | 'claude' | 'both'

export interface Shot { src: string, alt: string, device: 'desktop' | 'mobile' }

export interface Project {
    slug: string
    name: string
    years: [number, number]        // first and last year worked on
    category: Category
    context: Context
    featured?: 1 | 2 | 3 | 4       // position among the featured cards on the home page
    line: string                   // the one line on cards and rows
    summary: string                // the project page's opening paragraph
    body: string[]                 // "What it does"
    highlights: string[]
    tech: string[]
    built: Built
    builtNote?: string
    logo?: { src: string, background: 'light' | 'dark' }
    screenshots: Shot[]            // the first desktop one is the cover; none shows a placeholder
    links: {
        website?: string
        websiteLabel?: string
        github?: string
        workshop?: string
        download?: string
        gameSite?: string          // a page on this site, so a path rather than a URL
        stores?: { name: 'Epic Games Store' | 'Steam', href?: string }[]   // no href shows as coming soon
    }
}

export const PROJECTS: Project[] = [
    {
        slug: 'pmpc-group',
        name: 'PMPC Group',
        years: [2025, 2026],
        category: 'website',
        context: 'client',
        featured: 1,
        line: 'Corporate website for a project management and project controls consultancy.',
        summary: 'Marketing website for a project management consultancy, with scroll-triggered animations and a 17-service showcase.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Framer Motion', 'Docker'],
        built: 'hand',
        logo: { src: '/projects/pmpc-group/logo.svg', background: 'dark' },
        screenshots: [
            { src: '/projects/pmpc-group/01.webp', alt: 'The home page hero: the PMPC Group logo over a city skyline in fog', device: 'desktop' },
            { src: '/projects/pmpc-group/02.webp', alt: 'The home page service cards, one lifting under the cursor', device: 'desktop' },
            { src: '/projects/pmpc-group/03.webp', alt: 'The about page, with the company history', device: 'desktop' },
            { src: '/projects/pmpc-group/04.webp', alt: 'The solutions page', device: 'desktop' },
            { src: '/projects/pmpc-group/05.webp', alt: 'The home page hero on a phone', device: 'mobile' },
            { src: '/projects/pmpc-group/06.webp', alt: 'The service cards on a phone', device: 'mobile' },
        ],
        links: { website: 'https://pmpcgroup.horizons.gg/', websiteLabel: 'View my build' },
    },
    {
        slug: 'spot-on-drones',
        name: 'Spot On Drones',
        years: [2024, 2026],
        category: 'web-app',
        context: 'client',
        featured: 2,
        line: 'Website, client livestream and staff dashboard for an agricultural drone service.',
        summary: 'Website and admin dashboard for an agricultural drone service, with password-protected livestreams, gallery management and live operational stats.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'MUI', 'MongoDB', 'YouTube API', 'Docker'],
        built: 'hand',
        logo: { src: '/projects/spot-on-drones/logo.png', background: 'light' },
        screenshots: [
            { src: '/projects/spot-on-drones/01.webp', alt: 'The home page: a spray drone in flight over the company ute and trailer', device: 'desktop' },
            { src: '/projects/spot-on-drones/02.webp', alt: 'The gallery of jobs, with images and videos', device: 'desktop' },
            { src: '/projects/spot-on-drones/03.webp', alt: 'The home page on a phone', device: 'mobile' },
        ],
        links: { website: 'https://www.spotondrones.com/' },
    },
    {
        slug: 'atomic-sandbox',
        name: 'Atomic Sandbox',
        years: [2026, 2026],
        category: 'desktop-app',
        context: 'personal',
        featured: 3,
        line: 'Real-time quantum chemistry sandbox in Rust, solving the electrons live on the GPU.',
        summary: 'A real-time quantum chemistry sandbox, built from scratch in Rust. Its LIRA engine solves the electrons with density functional theory on any GPU, live, so bonds, shapes and reactions emerge from the physics instead of being scripted.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Rust', 'wgpu', 'WGSL', 'egui'],
        built: 'claude',
        screenshots: [
            { src: '/projects/atomic-sandbox/01.webp', alt: 'Ethylene with each of its electron orbitals drawn in its own colour', device: 'desktop' },
            { src: '/projects/atomic-sandbox/02.webp', alt: 'A water molecule with its electron density cloud and bonds', device: 'desktop' },
            { src: '/projects/atomic-sandbox/03.webp', alt: 'Propene seen through the free camera', device: 'desktop' },
            { src: '/projects/atomic-sandbox/04.webp', alt: 'The periodic table used to place atoms', device: 'desktop' },
            { src: '/projects/atomic-sandbox/05.webp', alt: 'The learned model training itself in the background', device: 'desktop' },
            { src: '/projects/atomic-sandbox/06.webp', alt: 'Ethylene orbitals drawn as clouds of dots', device: 'desktop' },
        ],
        links: { github: 'https://github.com/ItsKodas/atomic-sandbox' },
    },
    {
        slug: 'asot-milsim',
        name: 'ASOT Milsim',
        years: [2024, 2026],
        category: 'web-app',
        context: 'community',
        featured: 4,
        line: 'Community platform for a military simulation unit, with live collaborative briefings.',
        summary: 'Community platform for a military simulation unit, with real-time collaborative briefings, automated MILPAC generation, Discord role permissions and 3D terrain visualisation.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'MongoDB', 'Discord.js', 'Yjs', 'Playwright'],
        built: 'both',
        builtNote: 'By hand from 2024, with Claude since late 2025',
        logo: { src: '/projects/asot-milsim/logo.png', background: 'dark' },
        screenshots: [
            { src: '/projects/asot-milsim/01.webp', alt: 'The public home page of the unit', device: 'desktop' },
            { src: '/projects/asot-milsim/02.webp', alt: 'The ORBAT, showing every section and who fills it', device: 'desktop' },
            { src: '/projects/asot-milsim/03.webp', alt: 'The MILPACs list of members', device: 'desktop' },
            { src: '/projects/asot-milsim/04.webp', alt: "One member's MILPAC profile with ranks and awards", device: 'desktop' },
            { src: '/projects/asot-milsim/05.webp', alt: 'The gallery of in-game photos', device: 'desktop' },
            { src: '/projects/asot-milsim/06.webp', alt: 'The home page on a phone', device: 'mobile' },
            { src: '/projects/asot-milsim/07.webp', alt: 'The ORBAT on a phone', device: 'mobile' },
        ],
        links: { website: 'https://www.asotmilsim.com/', github: 'https://github.com/KL-Designs/ASOT' },
    },
    {
        slug: 'blastyard',
        name: 'Blastyard',
        years: [2026, 2026],
        category: 'game',
        context: 'personal',
        line: 'Online third-person team arena shooter: wall run, slide and jetpack as a toy robot.',
        summary: 'A third-person team arena shooter: sprint, slide, wall run and jetpack around the arena as a toy robot, and play team deathmatch with friends in lobbies anyone can host.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Unreal Engine 5', 'C++', 'Epic Online Services', 'Python'],
        built: 'claude',
        logo: { src: '/projects/blastyard/logo.svg', background: 'dark' },
        screenshots: [
            { src: '/projects/blastyard/01.webp', alt: 'A robot jetpacking off a crane above the clouds at sunset on the Skyrig map', device: 'desktop' },
            { src: '/projects/blastyard/02.webp', alt: 'Wall running past neon signs in Neon District', device: 'desktop' },
            { src: '/projects/blastyard/03.webp', alt: 'A low-gravity jump across the Moon Base craters', device: 'desktop' },
            { src: '/projects/blastyard/04.webp', alt: 'Jetpacking over a street at night in Downtown', device: 'desktop' },
            { src: '/projects/blastyard/05.webp', alt: 'The armory, where each robot is customised', device: 'desktop' },
            { src: '/projects/blastyard/06.webp', alt: 'The main menu over a practice arena', device: 'desktop' },
        ],
        links: {
            gameSite: '/blastyard',
            stores: [
                { name: 'Epic Games Store', href: 'https://store.epicgames.com/p/blastyard-b6300d' },
                { name: 'Steam' },
            ],
        },
    },
    {
        slug: 'voxweave',
        name: 'Voxweave',
        years: [2026, 2026],
        category: 'desktop-app',
        context: 'personal',
        line: 'Windows app for real-time voice conversion through a virtual microphone.',
        summary: 'A Windows app for real-time voice conversion: speak into your mic and a chosen voice comes out on a virtual microphone. It also records voice datasets, trains custom voice models on the GPU and turns typed text into speech, all on your own computer.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Tauri', 'React', 'TypeScript', 'Python', 'PyTorch', 'ONNX Runtime'],
        built: 'claude',
        screenshots: [
            { src: '/projects/voxweave/01.webp', alt: 'Live mode: microphone, virtual microphone, voice and sound settings', device: 'desktop' },
            { src: '/projects/voxweave/02.webp', alt: 'Live effects applied to the converted voice', device: 'desktop' },
            { src: '/projects/voxweave/03.webp', alt: 'Recording a voice dataset clip by clip', device: 'desktop' },
            { src: '/projects/voxweave/04.webp', alt: 'Training a custom voice model on the GPU', device: 'desktop' },
            { src: '/projects/voxweave/05.webp', alt: 'Text to speech in one of your own voices', device: 'desktop' },
            { src: '/projects/voxweave/06.webp', alt: 'The debug view analysing a voice', device: 'desktop' },
        ],
        links: { github: 'https://github.com/ItsKodas/voxweave', download: 'https://github.com/ItsKodas/voxweave/releases/latest' },
    },
    {
        slug: 'the-back-room',
        name: 'The Back Room',
        years: [2026, 2026],
        category: 'web-app',
        context: 'personal',
        line: 'Card and dice games in the browser with friends: Greed and Blackjack with room codes.',
        summary: 'A card and dice room in the browser for playing with friends: multiplayer Greed (Farkle) and Blackjack with room codes, bots, Discord sign-in and a chips-only economy.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['TypeScript', 'React', 'Express', 'Socket.IO', 'MongoDB', 'Docker'],
        built: 'claude',
        logo: { src: '/projects/the-back-room/logo.svg', background: 'dark' },
        screenshots: [
            { src: '/projects/the-back-room/01.webp', alt: 'The floor, with every table and game you can join', device: 'desktop' },
            { src: '/projects/the-back-room/02.webp', alt: 'A poker table at the end of a hand, showing a full house', device: 'desktop' },
            { src: '/projects/the-back-room/03.webp', alt: 'Your turn in a game of Uno against friends and bots', device: 'desktop' },
            { src: '/projects/the-back-room/04.webp', alt: 'A game of Plinko', device: 'desktop' },
            { src: '/projects/the-back-room/05.webp', alt: 'The floor on a phone', device: 'mobile' },
            { src: '/projects/the-back-room/06.webp', alt: 'Uno on a phone, with a Draw Two in play', device: 'mobile' },
        ],
        links: { website: 'https://thebackroom.dev/', github: 'https://github.com/ItsKodas/the-back-room' },
    },
    {
        slug: '1st-canzuk-brigade',
        name: '1st CANZUK Brigade',
        years: [2026, 2026],
        category: 'website',
        context: 'community',
        line: 'Website and staff area for a Hell Let Loose unit, fed from its own spreadsheets.',
        summary: "Website and staff area for a Hell Let Loose community unit, with Discord sign-in, an enlistment form that fills in from Steam, ORBAT role sync to Discord and a scheduled importer for the unit's spreadsheets.",
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'Payload CMS', 'PostgreSQL', 'Tailwind CSS', 'Playwright'],
        built: 'claude',
        logo: { src: '/projects/1st-canzuk-brigade/logo.png', background: 'dark' },
        screenshots: [
            { src: '/projects/1st-canzuk-brigade/01.webp', alt: 'The ORBAT, from brigade headquarters down to each section', device: 'desktop' },
            { src: '/projects/1st-canzuk-brigade/02.webp', alt: 'Honours and awards, with every medal and its citation', device: 'desktop' },
            { src: '/projects/1st-canzuk-brigade/03.webp', alt: 'About the brigade', device: 'desktop' },
            { src: '/projects/1st-canzuk-brigade/04.webp', alt: 'The home page, with enlistment open', device: 'desktop' },
            { src: '/projects/1st-canzuk-brigade/05.webp', alt: 'The home page on a phone', device: 'mobile' },
        ],
        links: { website: 'https://1stcanzukbrigade.com/' },
    },
    {
        slug: 'ai-culler',
        name: 'AI Culler',
        years: [2026, 2026],
        category: 'mod',
        context: 'personal',
        line: 'Arma 3 performance mod that culls AI the server and players have no need to run.',
        summary: 'A two-part Arma 3 performance mod for large milsim operations: the server stops simulating AI nobody can see or reach, and each player stops drawing AI hidden behind terrain and buildings.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['SQF', 'Arma 3', 'CBA_A3', 'PowerShell'],
        built: 'claude',
        logo: { src: '/projects/ai-culler/logo.png', background: 'dark' },
        screenshots: [],
        links: {
            workshop: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3744994173',
            github: 'https://github.com/ItsKodas/ai-culler',
        },
    },
    {
        slug: 'tax-assistant',
        name: 'Tax Assistant',
        years: [2023, 2024],
        category: 'mobile-app',
        context: 'personal',
        line: 'iOS and Android app that reads receipts with OCR and keeps them ready for tax time.',
        summary: 'An iOS and Android app for keeping receipts and invoices at tax time: snap a receipt and OCR reads its date and total, sort everything into folders and categories, and export a date range to CSV.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['React Native', 'Expo', 'TypeScript', 'Express', 'MongoDB', 'Tesseract.js'],
        built: 'hand',
        logo: { src: '/projects/tax-assistant/logo.png', background: 'dark' },
        screenshots: [],
        links: {},
    },
    {
        slug: 'arbys-auto-glass',
        name: "Arby's Auto Glass",
        years: [2022, 2026],
        category: 'website',
        context: 'client',
        line: 'Website and quote form for a Perth mobile windscreen repair business.',
        summary: 'Service website for a Western Australian auto glass business, with a dynamic pricing table, a validated quote form and a Google Maps service area.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Docker'],
        built: 'both',
        builtNote: 'By hand from 2022, with the 2026 redesign built with Claude',
        logo: { src: '/projects/arbys-auto-glass/logo.png', background: 'light' },
        screenshots: [
            { src: '/projects/arbys-auto-glass/01.webp', alt: 'The home page hero carousel', device: 'desktop' },
            { src: '/projects/arbys-auto-glass/02.webp', alt: 'The services and pricing cards', device: 'desktop' },
            { src: '/projects/arbys-auto-glass/03.webp', alt: 'The service area map and free travel zone', device: 'desktop' },
            { src: '/projects/arbys-auto-glass/04.webp', alt: 'The four-step quote form', device: 'desktop' },
            { src: '/projects/arbys-auto-glass/05.webp', alt: 'The home page on a phone', device: 'mobile' },
            { src: '/projects/arbys-auto-glass/06.webp', alt: 'The quote form on a phone', device: 'mobile' },
        ],
        links: { website: 'https://www.arbysauto.com/' },
    },
    {
        slug: 'horizons-portfolio',
        name: 'Horizons Portfolio',
        years: [2019, 2026],
        category: 'website',
        context: 'personal',
        line: 'This site: a hand-built parallax night scene, my projects, and a client portal.',
        summary: 'This site: a hand-built parallax night scene with a wind-blown forest, a living lake and a campfire to end the page on.',
        body: ['Placeholder, written up in full from the repository.'],
        highlights: ['Placeholder.'],
        tech: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'PostgreSQL', 'Prisma', 'Docker'],
        built: 'both',
        builtNote: 'About half by hand and half with Claude',
        logo: { src: '/projects/horizons-portfolio/logo.png', background: 'dark' },
        screenshots: [
            { src: '/projects/horizons-portfolio/01.webp', alt: 'The hero: a parallax night scene over a lake, with the Horizons logo', device: 'desktop' },
            { src: '/projects/horizons-portfolio/02.webp', alt: 'The quote form clients use to ask for work', device: 'desktop' },
            { src: '/projects/horizons-portfolio/03.webp', alt: 'The hero on a phone', device: 'mobile' },
        ],
        links: { github: 'https://github.com/ItsKodas/Portfolio' },
    },
]

// Newest first by the last year worked on, then by the first, then by name
const byRecency = (a: Project, b: Project) =>
    b.years[1] - a.years[1] || b.years[0] - a.years[0] || a.name.localeCompare(b.name)

export const getProject = (slug: string) => PROJECTS.find(p => p.slug === slug)

export const featured = () => PROJECTS.filter(p => p.featured).sort((a, b) => a.featured! - b.featured!)

export const listed = () => PROJECTS.filter(p => !p.featured).sort(byRecency)

export const inCategory = (c: Category) => PROJECTS.filter(p => p.category === c).sort(byRecency)

export const categoriesInUse = () => CATEGORIES.map(c => c.id).filter(id => PROJECTS.some(p => p.category === id))

// The projects either side of this one, in the order the home page shows them, wrapping at both ends
export function neighbours(slug: string): { previous?: Project, next?: Project } {
    const order = [...featured(), ...listed()]
    const i = order.findIndex(p => p.slug === slug)
    if (i === -1) return {}
    return { previous: order[(i - 1 + order.length) % order.length], next: order[(i + 1) % order.length] }
}

export const yearsLabel = (p: Project) => p.years[0] === p.years[1] ? String(p.years[0]) : `${p.years[0]} to ${p.years[1]}`

export function builtLine(p: Project) {
    if (p.built === 'hand') return 'Written by hand'
    if (p.built === 'claude') return 'Built with Claude, designed and directed by me'
    return p.builtNote ?? ''
}

// The first character of each of the first two words, for a project without a logo
export const monogram = (name: string) => name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
