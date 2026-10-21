import Link from 'next/link'

import { ArrowForward } from '@/ui/icons'
import { Cover } from '@/app/showcase/Cover'
import { Panel } from '@/app/showcase/Panel'
import { ProjectLogo } from '@/app/showcase/ProjectLogo'
import { CATEGORY_NAME, CONTEXT_LABEL, yearsLabel, type Project } from '@/app/showcase/projects'

// One of the four projects shown large at the top of the section. The whole card opens the project's page, where its
// live site, code and store links are, so a card only ever has the one place to go.
export default function FeaturedCard({ project }: { project: Project }) {
    return (
        <Link href={`/projects/${project.slug}`} data-testid="featured-card"
            className="group block rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
            <Panel className="flex h-full flex-col overflow-hidden transition-colors group-hover:border-[#8fd4f5]/30">
                <div className="relative aspect-[16/10] overflow-hidden sm:aspect-video">
                    <div className="absolute inset-0 motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-[1.03]">
                        <Cover project={project} sizes="(min-width: 768px) 480px, 100vw" />
                    </div>
                </div>
                <div className="relative flex flex-1 flex-col px-6 pb-6 pt-10">
                    <div className="absolute -top-7 left-6 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)]">
                        <ProjectLogo project={project} size={56} />
                    </div>
                    <div className="mb-1 flex items-baseline justify-between gap-3">
                        <h3 className="text-xl font-bold text-white">{project.name}</h3>
                        <span className="text-sm font-medium text-[#8fa3c7]">{yearsLabel(project)}</span>
                    </div>
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#f7c5d3]/80">
                        {CATEGORY_NAME[project.category]} · {CONTEXT_LABEL[project.context]}
                    </p>
                    <p className="mb-5 text-sm leading-relaxed text-[#b4c3dc]/80">{project.line}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5">
                        {project.tech.slice(0, 4).map(t => (
                            <span key={t} className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-[#c9d4ee]">{t}</span>
                        ))}
                        <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-[#8fd4f5]">
                            Read more <ArrowForward size={15} className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
                        </span>
                    </div>
                </div>
            </Panel>
        </Link>
    )
}
