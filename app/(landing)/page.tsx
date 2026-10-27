'use client'

// The portfolio content below the hero, set on the night backdrop: calm, frosted panels in the scene's navy, with the
// lake's blue, the sky's lilac and the clouds' pink as accents.

import Link from 'next/link'
import Image from 'next/image'
import { GitHub, LinkedIn, YouTube, Instagram, NorthEast, ArrowForward } from '@/ui/icons'

import PMPC_Group from '../../public/images/clients/pmpc.svg'
import SpotOnDrones from '../../public/images/clients/spotondrones-mono.png'
import Arbys from '../../public/images/clients/arbys-mark.png'
import ASOT from '../../public/images/clients/asot.svg'

import { SKILLS as skills, SOCIALS } from '../site'
import { TOOLKIT_LOGOS } from './toolkitLogos'
import { Panel } from '@/app/showcase/Panel'
import ProjectsSection from './projects/ProjectsSection'
import EmailLink from './EmailLink'

// Logos as light marks on the night, each sized so they carry about the same visual weight. The single-colour SVGs are
// turned white here; Spot On Drones and Arby's have prepared white versions (two-tone, and the mark lifted off its
// tile) since turning the originals white loses their detail.
const WHITE: React.CSSProperties = { filter: 'brightness(0) invert(1)' }
// Each logo links to the site built for that client (a logo without an href is shown but not clickable)
const clients: { src: typeof PMPC_Group, name: string, href?: string, box: string, style?: React.CSSProperties }[] = [
    { src: PMPC_Group, name: 'PMPC Group', href: 'https://pmpcgroup.com.au/', box: 'h-10 w-24', style: WHITE },
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
            <ArrowForward size={16} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
    )
}

const ICONS = { GitHub, LinkedIn, YouTube, Instagram }
const socials = SOCIALS.map(s => ({ ...s, icon: ICONS[s.label] }))

// ─── Building blocks ──────────────────────────────────────────────────────────────

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
                <p className="mb-8 text-center text-xs font-semibold uppercase tracking-[0.3em] text-[#8fd4f5]/50">Worked with</p>
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
                    <div className="max-w-xl space-y-4 text-base leading-relaxed text-[#b4c3dc]/80">
                        <p>
                            I&apos;m a full-stack developer: I&apos;ve spent years building websites and web apps for clients, from
                            the database to the front end, written by hand. With AI tools in the mix I now build well past the web
                            too: desktop apps, a game and mods. I use Claude as part of how I work. I decide what gets built and how
                            it fits together, and I review and test everything that ships.
                        </p>
                        <p className="font-medium text-[#dbe6f7]">I&apos;m open to full-time roles as well as contract work.</p>
                    </div>
                    <div className="mt-8 flex flex-wrap gap-3">
                        <QuoteLink />
                        <EmailLink />
                    </div>
                </div>

                <Panel className="p-6">
                    <p className="mb-4 text-xs font-semibold uppercase tracking-[0.25em] text-[#b597cc]/80">Find me on</p>
                    <div className="flex flex-col gap-1">
                        {socials.map(({ label, href, icon: Icon }) => (
                            <Link key={label} href={href} target="_blank" rel="me noopener noreferrer"
                                className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[#b4c3dc] transition-colors hover:bg-white/[0.04] hover:text-white">
                                <Icon size={20} className="text-[#8fd4f5]/70 transition-colors group-hover:text-[#8fd4f5]" />
                                <span className="text-sm font-medium">{label}</span>
                                <NorthEast size={14} className="ml-auto opacity-30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-80" />
                            </Link>
                        ))}
                    </div>
                </Panel>
            </section>

            {/* Projects (the hero's My Projects button scrolls here) */}
            <section id="projects" className="mt-32">
                <SectionTitle eyebrow="Projects" title="Built by me, start to finish" />
                <p className="-mt-4 mb-10 max-w-2xl text-base leading-relaxed text-[#b4c3dc]/80">
                    Everything here was designed, built and shipped by me: client websites, web apps, desktop apps, a game and mods.
                </p>
                <ProjectsSection />
            </section>

            {/* Stack */}
            <section className="mt-32">
                <SectionTitle eyebrow="Toolkit" title="Tools I've used" />
                <div className="flex flex-wrap gap-3">
                    {skills.map(s => {
                        const logo = TOOLKIT_LOGOS[s]
                        return (
                            <span key={s} className="group inline-flex items-center gap-2.5 rounded-2xl border border-[#8fd4f5]/[0.12] bg-[#111a38]/55 px-4 py-2.5 text-sm font-medium text-[#dbe6f7] backdrop-blur-md transition-colors hover:border-[#8fd4f5]/30 hover:text-white">
                                {logo && (
                                    <svg viewBox={logo.viewBox} fill="currentColor" aria-hidden="true" focusable="false"
                                        className="h-[18px] w-[18px] shrink-0 text-[#a9e0fc] transition-colors group-hover:text-white">
                                        <path d={logo.d} />
                                    </svg>
                                )}
                                {s}
                            </span>
                        )
                    })}
                </div>
            </section>

            {/* Contact */}
            <section className="mt-32 text-center">
                <h2 className="mb-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">Let&apos;s build something</h2>
                <p className="mx-auto mb-8 max-w-md text-base leading-relaxed text-[#b4c3dc]/75">
                    Have a project in mind, or a role you think I&apos;d suit? Get in touch.
                </p>
                <div className="mb-8 flex flex-wrap justify-center gap-3"><QuoteLink /><EmailLink /></div>
                <div className="flex flex-wrap justify-center gap-3">
                    {socials.map(({ label, href, icon: Icon }) => (
                        <Link key={label} href={href} target="_blank" rel="me noopener noreferrer" aria-label={label}
                            className="flex h-12 w-12 items-center justify-center rounded-full border border-[#8fd4f5]/15 bg-[#111a38]/55 text-[#a9e0fc] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-[#8fd4f5]/40 hover:text-white">
                            <Icon size={20} />
                        </Link>
                    ))}
                </div>
                <p className="mt-16 text-xs tracking-[0.2em] text-[#8fa3c7]/60">© {new Date().getFullYear()} HORIZONS · DAKODA LANCELOT</p>
            </section>

        </div>
    )
}
