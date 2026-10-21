import Link from 'next/link'

import { ArrowForward } from '@/ui/icons'
import { Cover } from '@/app/showcase/Cover'
import { ProjectLogo } from '@/app/showcase/ProjectLogo'
import { CATEGORY_NAME, yearsLabel, type Project } from '@/app/showcase/projects'

// A project in the compact list: a small screenshot (or its logo, until it has one), its name, kind and years, and one
// line that is cut short rather than wrapping, so the list stays the same height on a phone
export default function ProjectRow({ project }: { project: Project }) {
    const hasShot = project.screenshots.some(s => s.device === 'desktop')
    return (
        <Link href={`/projects/${project.slug}`} data-testid="project-row"
            className="group flex items-center gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
            <div className="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0e1530]">
                {hasShot ? <Cover project={project} sizes="64px" /> : <ProjectLogo project={project} size={36} />}
            </div>
            {hasShot && <div className="hidden sm:block"><ProjectLogo project={project} size={32} /></div>}
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3">
                    <h3 className="font-semibold text-white">{project.name}</h3>
                    <span className="text-xs font-medium text-[#8fa3c7]">{CATEGORY_NAME[project.category]} · {yearsLabel(project)}</span>
                </div>
                <p className="truncate text-sm text-[#b4c3dc]/70">{project.line}</p>
            </div>
            <ArrowForward size={18} className="shrink-0 text-[#8fd4f5]/60 group-hover:text-[#8fd4f5] motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
        </Link>
    )
}
