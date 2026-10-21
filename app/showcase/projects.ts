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

// A poster is a tall image that already frames itself, like an App Store screenshot, so it is shown whole
export interface Shot { src: string, alt: string, device: 'desktop' | 'mobile' | 'poster' }

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
    video?: { youtubeId: string, title: string }   // shown on the project page in place of the first screenshot
    links: {
        website?: string
        websiteLabel?: string
        moreSites?: { href: string, label: string }[]   // other versions of the site, shown after the main one
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
        years: [2025, 2025],
        category: 'website',
        context: 'client',
        featured: 1,
        line: 'Corporate website for a project management and project controls consultancy.',
        summary: "A corporate website for PMPC Group, a project management and project controls consultancy, built to look as established as the firm behind it.",
        body: [
            "The home page scrolls through autoplaying city and construction video, then leads into the solutions, about, services and contact pages, with the company's history on the about page.",
            "I built it in Next.js as a static site in early 2025 and later moved it onto a Next server, running in Docker behind Apache and Cloudflare. The client has since pointed their domain at a different site, so both my original build and the redesign I made in 2026 live on at horizons.gg.",
        ],
        highlights: [
            "Autoplaying video backgrounds, with a still poster shown while each one loads",
            "Scroll-triggered animations with Framer Motion",
            "A showcase of all 17 of the firm's services",
            "Containerised with Docker, behind Apache and Cloudflare with the origin bound to loopback",
        ],
        tech: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Framer Motion', 'Docker'],
        built: 'hand',
        logo: { src: '/projects/pmpc-group/logo.svg', background: 'light' },
        screenshots: [
            { src: '/projects/pmpc-group/01.webp', alt: 'The home page hero: the PMPC Group logo over a city skyline in fog', device: 'desktop' },
            { src: '/projects/pmpc-group/02.webp', alt: 'The home page service cards, one lifting under the cursor', device: 'desktop' },
            { src: '/projects/pmpc-group/03.webp', alt: 'The about page, with the company history', device: 'desktop' },
            { src: '/projects/pmpc-group/04.webp', alt: 'The solutions page', device: 'desktop' },
            { src: '/projects/pmpc-group/05.webp', alt: 'The home page hero on a phone', device: 'mobile' },
            { src: '/projects/pmpc-group/06.webp', alt: 'The service cards on a phone', device: 'mobile' },
        ],
        links: {
            website: 'https://pmpcold.horizons.gg/',
            websiteLabel: 'View the original',
            moreSites: [{ href: 'https://pmpcgroup.horizons.gg/', label: 'View the redesign' }],
        },
    },
    {
        slug: 'spot-on-drones',
        name: 'Spot On Drones',
        years: [2024, 2026],
        category: 'web-app',
        context: 'client',
        featured: 2,
        line: 'Website, client livestream and staff dashboard for an agricultural drone service.',
        summary: "A website and staff dashboard for Spot On Drones, an agricultural drone business in Victoria that sprays weeds, spreads seed and fertiliser, and maps paddocks.",
        body: [
            "The public site covers their services, a gallery of jobs and their contact details. Clients also get a password-protected live stream page, so they can watch a job from the drone as it happens. Staff connect it to YouTube through Google sign-in, and the page copes with the stream going offline.",
            "Behind a login, staff manage users with admin or CASA roles, upload images and videos to the gallery with labels and thumbnails, and keep the CASA aviation documents the business has to hold in one place.",
        ],
        highlights: [
            "Password-protected client live stream, connected to YouTube through Google OAuth",
            "Role-based staff dashboard for users, the gallery and CASA compliance documents",
            "Image and video uploads with generated thumbnails",
            "Running since 2024 in Docker, with MongoDB",
        ],
        tech: ['Next.js', 'React', 'TypeScript', 'MUI', 'MongoDB', 'YouTube API', 'Docker'],
        built: 'hand',
        logo: { src: '/projects/spot-on-drones/logo.png', background: 'light' },
        screenshots: [
            { src: '/projects/spot-on-drones/01.webp', alt: 'The home page: a spray drone over the paddocks, with the service figures beside it', device: 'desktop' },
            { src: '/projects/spot-on-drones/02.webp', alt: 'The gallery of jobs from the air, with images and videos', device: 'desktop' },
            { src: '/projects/spot-on-drones/03.webp', alt: 'The password-protected page where clients watch a job live', device: 'desktop' },
            { src: '/projects/spot-on-drones/04.webp', alt: 'The home page on a phone', device: 'mobile' },
            { src: '/projects/spot-on-drones/05.webp', alt: 'The gallery on a phone', device: 'mobile' },
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
        body: [
            "You place atoms in 3D, drag them around and watch what happens. Nothing chemical is written in: each element is only its atomic number and mass, and the electrons are solved from first principles with real-space Kohn-Sham density functional theory, so bonds, shapes and energies come out of the equations.",
            "The physics runs twice: a 64-bit reference solver on the CPU, and the same solver in WGSL compute shaders on the GPU, checked against each other. A machine-learned model trains itself in the background from the solver's answers, takes over when it is confident, and hands back to the full solve when it is not.",
        ],
        highlights: [
            "The GPU solver runs 30 to 100 times faster than the CPU reference, and agrees with it to 3.5e-7 Ha or better from H to LiH (4.1e-6 Ha for water)",
            "The view re-solves about 0.1 to 0.2 seconds after you move an atom",
            "The learned model answers a dynamics step in about 5 µs, and learned H₂ from nothing in 38 DFT calls",
            "Every physics change is gated by validation suites against published references: water's bond angle comes out at 104.8°",
            "Written from scratch in Rust: about ten crates, hand-written WGSL shaders and an egui interface",
        ],
        tech: ['Rust', 'wgpu', 'WGSL', 'egui'],
        built: 'claude',
        logo: { src: '/projects/atomic-sandbox/logo.png', background: 'dark' },
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
        summary: "The community platform and public website for the Australian Special Operations Taskforce, an Arma 3 milsim unit, covering everything from recruiting and member records to planning each operation.",
        body: [
            "Members sign in with Discord. Staff run the unit from a dashboard: an operations board and map, member MILPACs, the ORBAT, training, attendance, peer reviews, tickets and a gallery. Briefings and SOPs are written in a real-time collaborative editor, so several people can work on the same document at once.",
            "A Discord bot handles slash commands, role sync and reminders, and a separate service generates each member's MILPAC image. I have built and run it since 2024, and made about 1,490 of the project's roughly 1,545 contributions.",
        ],
        highlights: [
            "Real-time collaborative editing for briefings and SOPs, with Tiptap, Yjs and a Hocuspocus WebSocket server",
            "Discord bot for slash commands, role sync and reminders",
            "MILPAC image generation as its own containerised service",
            "Playwright end-to-end tests against seeded personas, CI, and a deploy on every push to main",
        ],
        tech: ['Next.js', 'React', 'TypeScript', 'MongoDB', 'Discord.js', 'Yjs', 'Playwright'],
        built: 'both',
        builtNote: 'By hand from 2024, with Claude since early 2026',
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
        body: [
            "Blastyard is an online team shooter built in Unreal Engine 5 and C++. You play as a toy robot across maps like Neon District, Moon Base and Skyrig, in team deathmatch, free for all and other modes, in lobbies any player can host with a join code.",
            "Movement is the heart of it: slides, wall runs, jetpacks and dives are predicted on the player's machine and checked by the server, and shots are re-simulated on the server from a shared seed. It started as a Godot prototype before moving to Unreal, and a one-click release script builds it, protects it with Easy Anti-Cheat and uploads it to the Epic Games Store for testers.",
        ],
        highlights: [
            "Server-authoritative, client-predicted movement: sprint, slide, wall run, jetpack and dive",
            "Destructible walls that regrow during a match",
            "Lobbies through Epic Online Services with join codes and peer-to-peer relay, plus my own UDP master server",
            "Python pipelines that generate materials and synthesise sound effects",
            "One-click releases: build, Easy Anti-Cheat, and upload to the Epic Games Store",
        ],
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
        body: [
            "Speak into your microphone and a chosen voice comes out of a virtual microphone that Discord, games or any other app can use, with an optional headphone monitor. You can make a voice of your own too: record or import audio, let it cut and transcribe the clips locally, then train a model of that voice on your own GPU.",
            "The hard part was making the whole pipeline run on an AMD graphics card under Windows: DirectML for live conversion, ROCm PyTorch for training and text to speech, and patches to the upstream RVC code. The download covers live conversion; training and text to speech run from source for now.",
        ],
        highlights: [
            "Live voice conversion through DirectML and ONNX Runtime",
            "Native RVC voice training on an AMD GPU, with a patch that made training 3.4 times faster",
            "Text to speech in one of your own voices from a short clip, with F5-TTS",
            "A backend suite of 1,545 passing tests, plus GPU integration tests",
            "A 12 MB installer that sets up its own Python runtime on first run",
        ],
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
        line: "Card and dice games to play with friends in the browser, from Greed to poker and Uno.",
        summary: "A card and dice room in the browser for playing with friends: sign in with Discord, take a seat with play chips, and share a five-character code so friends can join your table.",
        body: [
            "There is a floor of tables to choose from: Greed (also known as Farkle), Blackjack, poker, Uno, roulette, slots, Plinko and more, with bots to fill empty seats. Chips are play money only, with nothing to buy and nothing to cash out.",
            "The server hosts any game through one adapter interface and never looks inside a game's moves, and each seat gets its own view of the table, so your hidden cards never reach anyone else's browser. Greed's scorer tries every way of grouping a selection of dice to find the best score, so every combination of house rules scores correctly.",
        ],
        highlights: [
            "Game-agnostic table server over Socket.IO, with per-seat state so hidden cards stay hidden",
            "456 tests, including exact bust odds: 1,080 of the 46,656 possible six-dice rolls score nothing",
            "Discord sign-in, table codes and bots for every seat",
            "Card and table textures generated in code with SVG noise filters",
        ],
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
        body: [
            "The public site has the unit's history, ORBAT, honours and awards, a service record for every member with a generated uniform image, a gallery and the enlistment form. Staff and applicants sign in with Discord or Steam.",
            "The unit already ran on Google Sheets, so the sheets stay the master record: a worker imports them into Postgres on a schedule, checks them, and alerts staff when something fails. Payload CMS gives staff an admin area for everything else.",
        ],
        highlights: [
            "Scheduled importer from the unit's Google Sheets into Postgres, with validation and failure alerts",
            "A uniform image generated on the server for every member's record",
            "Generated share cards for every page",
            "Unit, integration and Playwright end-to-end tests in CI",
        ],
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
        body: [
            "Large Arma 3 operations push a server hard: with 60 or more players and high AI counts, it spends its time simulating units nobody is near, and past about 150 units that causes periodic frame spikes. AI Culler caps how many AI are simulated at once, deciding by distance, players' line of sight, Zeus overrides and whether the AI are fighting each other.",
            "On each player's machine, a second part stops drawing AI hidden behind buildings and hills, with a cheap terrain check first and a geometry check second, inside a fixed budget. Mission makers can protect units from culling in the editor, and Zeus gets status and settings panels.",
        ],
        highlights: [
            "Server-side classification in chunks of 25 units, spread over time so the server thread never blocks",
            "Client-side occlusion that sweeps 200 AI in about 0.8 seconds and adds no server load",
            "Works alongside CBA_A3, ACE3, ZEN, LAMBS Danger and headless clients",
            "Released on the Steam Workshop, with a documented API for mission makers",
        ],
        tech: ['SQF', 'Arma 3', 'CBA_A3', 'PowerShell'],
        built: 'claude',
        logo: { src: '/projects/ai-culler/logo.png', background: 'dark' },
        screenshots: [
            { src: '/projects/ai-culler/01.webp', alt: 'AI Culler on and off side by side in the performance test video', device: 'desktop' },
        ],
        video: { youtubeId: 'Gz_TsMQTI4g', title: 'AIC | Engagement Performance Test' },
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
        body: [
            "Built for sole traders: photograph a receipt and the server reads it with OCR, filling in the total and date with a confidence score. Receipts and invoices live in folders and categories, and any date range exports as a CSV or a zip of the images for your accountant.",
            "It is a full product: the Expo app for iOS and Android, an Express API with MongoDB, a web client, and account management with email password resets and account deletion.",
        ],
        highlights: [
            "Receipt OCR with Tesseract.js, filling in the total and date with a confidence score",
            "Expo and React Native app for iOS and Android, with a web client on the same API",
            "CSV exports and zip downloads of receipt images by date range",
            "Accounts with email password resets and full account deletion",
        ],
        tech: ['React Native', 'Expo', 'TypeScript', 'Express', 'MongoDB', 'Tesseract.js'],
        built: 'hand',
        logo: { src: '/projects/tax-assistant/logo.png', background: 'dark' },
        screenshots: [
            { src: '/projects/tax-assistant/01.webp', alt: "Three App Store screenshots: adding a receipt, the receipt list and a folder's control panel", device: 'desktop' },
            { src: '/projects/tax-assistant/02.webp', alt: 'The receipt list, with totals and GST for everything in the folder', device: 'poster' },
            { src: '/projects/tax-assistant/03.webp', alt: 'Adding a new receipt, with its category, value and date', device: 'poster' },
            { src: '/projects/tax-assistant/04.webp', alt: 'Folders that keep receipts and invoices for each purpose apart', device: 'poster' },
            { src: '/projects/tax-assistant/05.webp', alt: "A folder's control panel, with receipts, invoices and the spreadsheet export", device: 'poster' },
            { src: '/projects/tax-assistant/06.webp', alt: 'Settings for a folder, including its GST rate', device: 'poster' },
            { src: '/projects/tax-assistant/07.webp', alt: 'Categories for adding receipts more quickly', device: 'poster' },
        ],
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
        body: [
            "Arby's is a mobile windscreen repair and replacement business in Perth. I built their first site in 2022, with a quote form that autocompletes the car's make, model and year and sends each request to the business on Discord, and an admin dashboard for their services, staff and social feeds.",
            "I rebuilt it in 2025 and redesigned it in 2026 in a trade style: charcoal and hi-vis orange, a hero carousel with line art of a cracked windscreen, services and pricing cards, a service area map, and a four-step quote form.",
        ],
        highlights: [
            "Four-step quote form with rate limiting, delivered to the business on Discord",
            "The 2022 original: car make, model and year autocomplete, MongoDB and an admin dashboard",
            "Service area map with a 40 km free travel zone",
            "Structured data, share images and a sitemap for search",
            "A hero carousel that respects reduced motion",
        ],
        tech: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Docker'],
        built: 'both',
        builtNote: 'By hand from 2022, with Claude assisting the 2026 redesign',
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
        line: 'This site: a layered parallax night scene, my projects, and a client portal.',
        summary: "This site. Besides the parallax night scene at the top, it runs my quote form, an admin inbox and invoicing, and a portal where clients manage the sites I host for them.",
        body: [
            "The home page is a night scene drawn in layers: twinkling and shooting stars, clouds, mountains, a wind-blown forest, a lake with ripples and fog, and a campfire at the end of the page. Each layer moves at its own depth as you scroll.",
            "Phones can't hold all of it, so the page decides before it first paints how much of the scene a device can afford, adds the rest a tier at a time while timing frames, and steps back down if scrolling slows.",
        ],
        highlights: [
            "Scene tiers chosen before first paint from the screen and memory, so phones never load more than they can hold",
            "Layers moved by CSS scroll timelines where the browser supports them, which made scrolling smooth on phones",
            "A client portal for the deploys, backups, domains and analytics of the sites I host",
            "Quote form, admin inbox and scheduled invoicing, on Postgres with Prisma",
            "Self-hosted in Docker, deployed on every push by my own Actions runner",
        ],
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
    if (p.built === 'claude') return 'Assisted by Claude'
    return p.builtNote ?? ''
}

// The first character of each of the first two words, for a project without a logo
export const monogram = (name: string) => name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
