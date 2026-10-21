'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { CATEGORIES, categoriesInUse, featured, inCategory, listed, type Category } from '@/app/showcase/projects'

import { CONTENT_SPEED, scrollToContent } from '../parallax/content'
import FeaturedCard from './FeaturedCard'
import ProjectRow from './ProjectRow'

// The projects on the home page: the four strongest as large cards, then the rest as a compact list, with tabs to
// narrow it to one kind. Picking a kind shows every project of that kind as large cards under the tabs, the featured
// ones included, so a filtered view is never missing anything. The server renders the "All" view.
export default function ProjectsSection() {
    const [category, setCategory] = useState<Category | 'all'>('all')
    const root = useRef<HTMLDivElement>(null)
    const strip = useRef<HTMLDivElement>(null)
    const stripTop = useRef<number | null>(null)

    // The featured cards sit above the tabs, so picking a kind shortens the page above them and the tabs would jump up
    // by that height, twice over since the content rises twice as fast as the scroll. So the strip's place on screen is
    // noted before the change and the page scrolled after it to put the strip back there.
    const pick = (id: Category | 'all') => {
        if (id === category) return
        stripTop.current = strip.current?.getBoundingClientRect().top ?? null
        setCategory(id)
    }
    // (Going back to All makes the page taller, but its height only catches up a moment later, so one scroll would be
    // cut short at the old bottom: it keeps aiming for the same place for a few frames until it gets there.)
    useLayoutEffect(() => {
        const before = stripTop.current
        stripTop.current = null
        if (before === null || !strip.current) return
        const moved = strip.current.getBoundingClientRect().top - before
        if (!moved) return
        const target = Math.max(0, window.scrollY + moved / (1 + CONTENT_SPEED))
        let frame = 0, tries = 30
        const settle = () => {
            window.scrollTo(0, target)
            if (Math.abs(window.scrollY - target) > 1 && --tries > 0) frame = requestAnimationFrame(settle)
        }
        settle()
        return () => cancelAnimationFrame(frame)
    }, [category])

    // Arriving on /#projects (the project pages link back here): the browser's own jump to the anchor can't allow for
    // the content rising faster than the scroll, so once the page has its full height, glide there properly
    useEffect(() => {
        if (window.location.hash !== '#projects') return
        const started = performance.now()
        let frame = 0
        const tryScroll = () => {
            if (document.documentElement.scrollHeight > window.innerHeight * 1.5) {
                const target = document.getElementById('projects') ?? root.current
                if (target) scrollToContent(target, 48, 'auto')
                return
            }
            if (performance.now() - started < 2000) frame = requestAnimationFrame(tryScroll)
        }
        frame = requestAnimationFrame(tryScroll)
        return () => cancelAnimationFrame(frame)
    }, [])

    const tabs: { id: Category | 'all', label: string }[] = [
        { id: 'all', label: 'All' },
        ...CATEGORIES.filter(c => categoriesInUse().includes(c.id)),
    ]

    return (
        <div ref={root}>
            {category === 'all' && (
                <div className="mb-10 grid gap-5 md:grid-cols-2">
                    {featured().map(p => <FeaturedCard key={p.slug} project={p} />)}
                </div>
            )}

            <div ref={strip} role="group" aria-label="Filter projects" className="-mx-5 mb-4 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
                {tabs.map(t => {
                    const on = t.id === category
                    return (
                        <button key={t.id} type="button" aria-pressed={on} onClick={() => pick(t.id)}
                            className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60 ${on
                                ? 'border-[#8fd4f5] bg-[#8fd4f5] text-[#0b101f]'
                                : 'border-[#8fd4f5]/20 text-[#b4c3dc] hover:border-[#8fd4f5]/45 hover:text-white'}`}>
                            {t.label}
                        </button>
                    )
                })}
            </div>

            {category === 'all'
                ? (
                    <div className="divide-y divide-[#8fd4f5]/[0.08]">
                        {listed().map(p => <ProjectRow key={p.slug} project={p} />)}
                    </div>
                )
                : (
                    <div className="mt-2 grid gap-5 md:grid-cols-2">
                        {inCategory(category).map(p => <FeaturedCard key={p.slug} project={p} />)}
                    </div>
                )}
        </div>
    )
}
