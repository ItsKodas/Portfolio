import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ArrowBack, ArrowForward, GitHub, NorthEast, EpicGames, Steam } from '@/ui/icons'
import { Cover } from '@/app/showcase/Cover'
import { Panel } from '@/app/showcase/Panel'
import { ProjectLogo } from '@/app/showcase/ProjectLogo'
import {
    CATEGORY_NAME, CONTEXT_LABEL, PROJECTS, builtLine, getProject, neighbours, yearsLabel, type Project,
} from '@/app/showcase/projects'

import { Gallery } from './Gallery'

// A page per project, for anyone who wants more than the card on the home page: its screenshots, what it does, the
// hard parts, what it is built with and how, and every link it has. Sits outside the (landing) group, so it loads
// none of the hero scene.

export const dynamicParams = false

export const generateStaticParams = () => PROJECTS.map(p => ({ slug: p.slug }))

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const project = getProject((await params).slug)
    if (!project) return {}
    const cover = project.screenshots[0]
    return {
        title: project.name,
        description: project.summary,
        alternates: { canonical: `/projects/${project.slug}` },
        openGraph: cover ? { images: [{ url: cover.src, alt: cover.alt }] } : undefined,
    }
}

const STORE_ICON = { 'Epic Games Store': EpicGames, 'Steam': Steam }

const chip = 'group inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition-colors'
const lake = `${chip} border-[#8fd4f5]/20 bg-[#8fd4f5]/[0.06] text-[#bfe6fb] hover:border-[#8fd4f5]/45 hover:text-white`
const lilac = `${chip} border-[#b597cc]/25 bg-[#b597cc]/[0.07] text-[#d9c6ea] hover:border-[#b597cc]/50 hover:text-white`
const out = <NorthEast size={14} className="opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />

function Links({ project }: { project: Project }) {
    const { website, websiteLabel, github, workshop, download, gameSite, stores } = project.links
    const external = { target: '_blank', rel: 'noopener noreferrer' }
    return (
        <div className="flex flex-wrap gap-2">
            {website && <a href={website} {...external} className={lake}>{websiteLabel ?? 'Visit site'} {out}</a>}
            {github && <a href={github} {...external} className={lilac}><GitHub size={16} /> GitHub</a>}
            {stores?.map(({ name, href }) => {
                const Icon = STORE_ICON[name]
                return href
                    ? <a key={name} href={href} {...external} className={lake}><Icon size={16} /> {name} {out}</a>
                    : (
                        <span key={name} aria-disabled="true" title={`${name}: coming soon`}
                            className={`${chip} cursor-not-allowed border-white/10 bg-white/[0.03] text-[#8fa3c7]/70`}>
                            <Icon size={16} /> {name}
                            <span className="text-[11px] uppercase tracking-wide text-[#8fa3c7]/60">Coming soon</span>
                        </span>
                    )
            })}
            {workshop && <a href={workshop} {...external} className={lake}><Steam size={16} /> Steam Workshop {out}</a>}
            {download && <a href={download} {...external} className={lake}>Download {out}</a>}
            {gameSite && <Link href={gameSite} className={lake}>Game website</Link>}
        </div>
    )
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <section className="mt-14">
            <h2 className="mb-4 text-2xl font-bold tracking-tight text-white">{title}</h2>
            {children}
        </section>
    )
}

export default async function ProjectPage({ params }: Props) {
    const project = getProject((await params).slug)
    if (!project) notFound()
    const { previous, next } = neighbours(project.slug)

    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-12 text-[#dbe6f7] sm:py-20">
            <div className="mx-auto max-w-4xl">
                <Link href="/#projects" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack size={16} /> Back to projects
                </Link>

                <header className="mb-6 flex items-center gap-5">
                    <ProjectLogo project={project} size={64} />
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{project.name}</h1>
                        <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#f7c5d3]/80">
                            {yearsLabel(project)} · {CATEGORY_NAME[project.category]} · {CONTEXT_LABEL[project.context]}
                        </p>
                    </div>
                </header>

                <p className="mb-6 max-w-3xl text-lg leading-relaxed text-[#dbe6f7]">{project.summary}</p>
                <Links project={project} />

                <div className="mt-10">
                    {project.screenshots.length > 0
                        ? <Gallery shots={project.screenshots} name={project.name} />
                        : <div className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-[#8fd4f5]/10"><Cover project={project} sizes="896px" /></div>}
                </div>

                <Section title="What it does">
                    <div className="max-w-3xl space-y-4 text-base leading-relaxed text-[#b4c3dc]/85">
                        {project.body.map(p => <p key={p}>{p}</p>)}
                    </div>
                </Section>

                <Section title="Highlights">
                    <ul className="max-w-3xl space-y-3 text-base leading-relaxed text-[#b4c3dc]/85">
                        {project.highlights.map(h => (
                            <li key={h} className="flex gap-3">
                                <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-[#8fd4f5]/70" />
                                <span>{h}</span>
                            </li>
                        ))}
                    </ul>
                </Section>

                <div className="mt-14 grid gap-5 sm:grid-cols-2">
                    <Panel className="p-6">
                        <h2 className="mb-4 text-lg font-bold text-white">Built with</h2>
                        <div className="flex flex-wrap gap-2">
                            {project.tech.map(t => <span key={t} className="rounded-full bg-white/[0.06] px-3 py-1 text-sm text-[#c9d4ee]">{t}</span>)}
                        </div>
                    </Panel>
                    <Panel className="p-6">
                        <h2 className="mb-4 text-lg font-bold text-white">How it was built</h2>
                        <p className="text-base text-[#b4c3dc]/85">{builtLine(project)}</p>
                    </Panel>
                </div>

                <nav aria-label="More projects" className="mt-16 flex flex-wrap justify-between gap-4 border-t border-[#8fd4f5]/10 pt-8 text-sm">
                    {previous && (
                        <Link href={`/projects/${previous.slug}`} className="group inline-flex items-center gap-2 font-medium text-[#8fd4f5]/80 hover:text-white">
                            <ArrowBack size={16} /> {previous.name}
                        </Link>
                    )}
                    {next && (
                        <Link href={`/projects/${next.slug}`} className="group ml-auto inline-flex items-center gap-2 font-medium text-[#8fd4f5]/80 hover:text-white">
                            {next.name} <ArrowForward size={16} />
                        </Link>
                    )}
                </nav>
            </div>
        </main>
    )
}
