import Image from 'next/image'

import { ProjectLogo } from './ProjectLogo'
import type { Project } from './projects'

// A project's cover, filling its parent (which sets the shape and is `relative`): its first desktop screenshot, or,
// until it has screenshots, a deliberate placeholder with its logo on a faint grid
export function Cover({ project, sizes, priority = false }: { project: Project, sizes: string, priority?: boolean }) {
    const shot = project.screenshots.find(s => s.device === 'desktop')
    if (shot) {
        return (
            <>
                <Image src={shot.src} alt={shot.alt} fill sizes={sizes} priority={priority} className="object-cover object-top" />
                {/* A project with a video gets a play mark on its cover, since its page opens with the video */}
                {project.video && (
                    <span data-testid="play-badge" aria-hidden
                        className="absolute left-1/2 top-1/2 flex h-[22%] max-h-14 min-h-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 px-[6%] text-white backdrop-blur-sm">
                        <svg viewBox="0 0 24 24" className="h-1/2 fill-current"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                )}
            </>
        )
    }
    return (
        <div data-testid="cover-placeholder"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0e1530]"
            style={{
                backgroundImage: 'linear-gradient(rgba(143,212,245,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(143,212,245,0.06) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
            }}>
            <ProjectLogo project={project} size={56} />
            <span className="text-xs font-medium tracking-wide text-[#8fa3c7]/80">Screenshots coming soon</span>
        </div>
    )
}
