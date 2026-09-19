'use client'

// The portfolio content below the hero, set on the night backdrop: calm, frosted panels in the scene's navy, with the
// lake's blue, the sky's lilac and the clouds' pink as accents.

import Link from 'next/link'
import Image from 'next/image'
import { GitHub, LinkedIn, YouTube, Instagram, NorthEast, ArrowForward } from '@mui/icons-material'

import PMPC_Group from '../../public/images/clients/pmpc.svg'
import SpotOnDrones from '../../public/images/clients/spotondrones-mono.png'
import Arbys from '../../public/images/clients/arbys-mark.png'
import ASOT from '../../public/images/clients/asot.svg'

import { SKILLS as skills, SOCIALS } from '../site'

// Logos as light marks on the night, each sized so they carry about the same visual weight. The single-colour SVGs are
// turned white here; Spot On Drones and Arby's have prepared white versions (two-tone, and the mark lifted off its
// tile) since turning the originals white loses their detail.
const WHITE: React.CSSProperties = { filter: 'brightness(0) invert(1)' }
// Each logo links to the site built for that client (a logo without an href is shown but not clickable)
const clients: { src: typeof PMPC_Group, name: string, href?: string, box: string, style?: React.CSSProperties }[] = [
    { src: PMPC_Group, name: 'PMPC Group', href: 'http://pmpcgroup.com.au/', box: 'h-10 w-24', style: WHITE },
    { src: SpotOnDrones, name: 'Spot On Drones', href: 'https://spotondrones.com.au/', box: 'h-10 w-32' },
    { src: Arbys, name: "Arby's Auto Glass", href: 'https://arbysauto.com/', box: 'h-11 w-11' },
    { src: ASOT, name: 'ASOT', href: 'https://www.asotmilsim.com/', box: 'h-10 w-28', style: WHITE },
]

// The way into the quote form, shown in the introduction and again at the end of the page
function QuoteLink({ className = '' }: { className?: string }) {
    return (
        <Link href="/quote"
            className={`group inline-flex items-center gap-2 rounded-full border border-[#f19bb3]/35 bg-[#f19bb3]/[0.08] px-5 py-2.5 text-sm font-semibold text-[#f7c5d3] transition-colors hover:border-[#f19bb3]/60 hover:text-white ${className}`}>
            Get a quote
            <ArrowForward sx={{ fontSize: 16 }} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
    )
}

const ICONS = { GitHub, LinkedIn, YouTube, Instagram }
const socials = SOCIALS.map(s => ({ ...s, icon: ICONS[s.label] }))

// Projects, each with a short blurb and links to where it lives: the live site and/or the code (either can be left out)
const projects: { name: string, year?: string, blurb: string, website?: string, github?: string }[] = [
    {
        name: 'The Back Room',
        year: '2026',
        blurb: 'A card and dice room in the browser for playing with friends: multiplayer Greed (Farkle) and Blackjack with room codes, bots, Discord sign-in and a chips-only economy.',
        website: 'https://thebackroom.dev/',
        github: 'https://github.com/ItsKodas/the-back-room',
    },
    {
        name: 'ASOT Milsim',
        year: '2024',
        blurb: 'Community platform for a military simulation unit, with real-time collaborative briefings, automated MILPAC generation, Discord role permissions and 3D terrain visualisation.',
        website: 'https://www.asotmilsim.com/',
        github: 'https://github.com/KL-Designs/ASOT',
    },
    {
        name: "Arby's Auto Glass",
        year: '2022',
        blurb: 'Service website for a Western Australian auto glass business, with a dynamic pricing table, a validated quote form and a Google Maps service area.',
        website: 'https://arbysauto.com/',
    },
    {
        name: 'Spot On Drones',
        year: '2024',
        blurb: 'Website and admin dashboard for an agricultural drone service, with password-protected livestreams, gallery management and live operational stats.',
        website: 'https://spotondrones.com.au/',
    },
    {
        name: 'PMPC Group',
        year: '2025',
        blurb: 'Marketing website for a project management consultancy, with scroll-triggered animations and a 17-service showcase.',
        website: 'http://pmpcgroup.com.au/',
    },
    {
        name: 'Horizons Portfolio',
        year: '2019',
        blurb: 'This site: a hand-built parallax night scene with a wind-blown forest, a living lake and a campfire to end the page on.',
        github: 'https://github.com/ItsKodas/Portfolio',
    },
]

// ─── Building blocks ──────────────────────────────────────────────────────────────

// Frosted panel in the night's navy, catching a little of the lake's light along its edge
function Panel({ children, className = '' }: { children: React.ReactNode, className?: string }) {
    return (
        <div className={`rounded-3xl border border-[#8fd4f5]/10 bg-[#111a38]/55 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_60px_-30px_rgba(0,0,0,0.6)] ${className}`}>
            {children}
        </div>
    )
}

function SectionTitle({ eyebrow, title }: { eyebrow: string, title: string }) {
    return (
        <div className="mb-8">
            <p className="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.3em] text-[#8fd4f5]/70">
                <span className="h-px w-8 bg-gradient-to-r from-[#8fd4f5]/70 to-transparent" />
                {eyebrow}
            </p>
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{title}</h2>
        </div>
    )
}

// ─── Page ─────────────────────────────────────────────────────────────────────────

export default function Landing() {
    return (
        <div className="mx-auto max-w-5xl px-5 pt-40 text-[#dbe6f7]">

            {/* Clients */}
            <section>
                <p className="mb-8 text-center text-xs font-semibold uppercase tracking-[0.3em] text-[#8fd4f5]/50">Trusted by</p>
                <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-8">
                    {clients.map(c => {
                        const logo = <Image src={c.src} alt={c.name} fill className="object-contain" style={c.style} />
                        const look = `relative ${c.box} opacity-50 transition-all duration-300 hover:opacity-90`
                        return c.href
                            ? <Link key={c.name} href={c.href} target="_blank" rel="noopener noreferrer" title={`Visit ${c.name}`} className={`${look} hover:-translate-y-0.5 focus-visible:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/50 rounded-md`}>{logo}</Link>
                            : <div key={c.name} title={c.name} className={look}>{logo}</div>
                    })}
                </div>
            </section>

            {/* About */}
            <section className="mt-28 grid items-start gap-10 md:grid-cols-[1.4fr_1fr]">
                <div>
                    <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Dakoda Lancelot</h1>
                    <p className="mb-6 text-lg font-medium text-[#f19bb3]">Fullstack Developer</p>
                    <p className="max-w-xl text-base leading-relaxed text-[#b4c3dc]/80">
                        Building modern digital experiences with clean code and thoughtful design. Specialising in fullstack
                        web development, from scalable backends to polished, performant frontends.
                    </p>
                    <QuoteLink className="mt-8" />
                </div>

                <Panel className="p-6">
                    <p className="mb-4 text-xs font-semibold uppercase tracking-[0.25em] text-[#b597cc]/80">Find me on</p>
                    <div className="flex flex-col gap-1">
                        {socials.map(({ label, href, icon: Icon }) => (
                            <Link key={label} href={href} target="_blank" rel="me noopener noreferrer"
                                className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[#b4c3dc] transition-colors hover:bg-white/[0.04] hover:text-white">
                                <Icon sx={{ fontSize: 20 }} className="text-[#8fd4f5]/70 transition-colors group-hover:text-[#8fd4f5]" />
                                <span className="text-sm font-medium">{label}</span>
                                <NorthEast sx={{ fontSize: 14 }} className="ml-auto opacity-30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-80" />
                            </Link>
                        ))}
                    </div>
                </Panel>
            </section>

            {/* Projects */}
            <section className="mt-32">
                <SectionTitle eyebrow="Projects" title="Things I've made" />
                <div className="grid gap-5 md:grid-cols-2">
                    {projects.map(p => (
                        <Panel key={p.name} className="flex flex-col p-7 transition-colors hover:border-[#8fd4f5]/25">
                            <div className="mb-3 flex items-baseline justify-between gap-3">
                                <h3 className="text-xl font-bold text-white">{p.name}</h3>
                                {p.year && <span className="text-sm font-medium text-[#8fa3c7]">{p.year}</span>}
                            </div>
                            <p className="mb-6 text-sm leading-relaxed text-[#b4c3dc]/75">{p.blurb}</p>
                            <div className="mt-auto flex flex-wrap gap-2">
                                {p.website && (
                                    <Link href={p.website} target="_blank" rel="noopener noreferrer"
                                        className="group inline-flex items-center gap-1.5 rounded-full border border-[#8fd4f5]/20 bg-[#8fd4f5]/[0.06] px-4 py-2 text-sm font-medium text-[#bfe6fb] transition-colors hover:border-[#8fd4f5]/45 hover:text-white">
                                        Visit site
                                        <NorthEast sx={{ fontSize: 14 }} className="opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                                    </Link>
                                )}
                                {p.github && (
                                    <Link href={p.github} target="_blank" rel="noopener noreferrer"
                                        className="group inline-flex items-center gap-1.5 rounded-full border border-[#b597cc]/25 bg-[#b597cc]/[0.07] px-4 py-2 text-sm font-medium text-[#d9c6ea] transition-colors hover:border-[#b597cc]/50 hover:text-white">
                                        <GitHub sx={{ fontSize: 16 }} /> GitHub
                                    </Link>
                                )}
                            </div>
                        </Panel>
                    ))}
                </div>
            </section>

            {/* Stack */}
            <section className="mt-32">
                <SectionTitle eyebrow="Toolkit" title="What I work with" />
                <div className="flex flex-wrap gap-3">
                    {skills.map(s => (
                        <span key={s} className="rounded-2xl border border-[#8fd4f5]/[0.12] bg-[#111a38]/55 px-5 py-3 text-sm font-medium text-[#dbe6f7] backdrop-blur-md transition-colors hover:border-[#8fd4f5]/30 hover:text-white">
                            {s}
                        </span>
                    ))}
                </div>
            </section>

            {/* Contact */}
            <section className="mt-32 text-center">
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">Let&apos;s build something</h2>
                <p className="mx-auto mb-8 max-w-md text-base leading-relaxed text-[#b4c3dc]/75">
                    Have a project in mind or just want to say hi? Reach out on any of these.
                </p>
                <div className="mb-8"><QuoteLink /></div>
                <div className="flex flex-wrap justify-center gap-3">
                    {socials.map(({ label, href, icon: Icon }) => (
                        <Link key={label} href={href} target="_blank" rel="me noopener noreferrer" aria-label={label}
                            className="flex h-12 w-12 items-center justify-center rounded-full border border-[#8fd4f5]/15 bg-[#111a38]/55 text-[#a9e0fc] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-[#8fd4f5]/40 hover:text-white">
                            <Icon sx={{ fontSize: 20 }} />
                        </Link>
                    ))}
                </div>
                <p className="mt-16 text-xs tracking-[0.2em] text-[#8fa3c7]/60">© {new Date().getFullYear()} HORIZONS · DAKODA LANCELOT</p>
            </section>

        </div>
    )
}
