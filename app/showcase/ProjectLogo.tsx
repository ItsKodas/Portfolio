import Image from 'next/image'

import { monogram, type Project } from './projects'

// A project's logo on a rounded tile: white for a logo drawn for a light background, the night's navy otherwise. A
// project without a logo gets its initials instead, which are decorative, since its name is always shown beside it.
export function ProjectLogo({ project, size }: { project: Project, size: number }) {
    const light = project.logo?.background === 'light'
    return (
        <div className={`relative shrink-0 overflow-hidden rounded-xl border ${light ? 'border-white/60 bg-white' : 'border-[#8fd4f5]/15 bg-[#111a38]'}`}
            style={{ width: size, height: size }}>
            {project.logo
                ? <Image src={project.logo.src} alt={`${project.name} logo`} fill sizes={`${size}px`} className="object-contain p-[12%]" />
                : (
                    <span aria-hidden className="flex h-full w-full items-center justify-center bg-[#1a2550] font-bold tracking-tight text-white"
                        style={{ fontSize: size * 0.38 }}>
                        {monogram(project.name)}
                    </span>
                )}
        </div>
    )
}
