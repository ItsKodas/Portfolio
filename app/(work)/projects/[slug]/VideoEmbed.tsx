'use client'

import Image from 'next/image'
import { useState } from 'react'

import type { Project, Shot } from '@/app/showcase/projects'

// A project's video: its thumbnail with a play button, and YouTube's player only once someone presses play. Nothing
// is loaded from YouTube before then, which keeps the page fast and sets no cookies on a visitor who never watches,
// and the privacy-enhanced player (youtube-nocookie.com) is used when they do.
export function VideoEmbed({ video, poster }: { video: NonNullable<Project['video']>, poster: Shot }) {
    const [playing, setPlaying] = useState(false)

    return (
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-[#8fd4f5]/10 bg-black">
            {playing
                ? (
                    <iframe src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0`} title={video.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerPolicy="strict-origin-when-cross-origin" allowFullScreen className="absolute inset-0 h-full w-full" />
                )
                : (
                    <button type="button" onClick={() => setPlaying(true)} aria-label={`Play video: ${video.title}`}
                        className="group absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8fd4f5]/60">
                        <Image src={poster.src} alt="" fill sizes="(min-width: 896px) 896px, 100vw" priority className="object-cover" />
                        <span aria-hidden className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur-sm transition-colors group-hover:bg-[#e62117]">
                            <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8 fill-current"><path d="M8 5v14l11-7z" /></svg>
                        </span>
                    </button>
                )}
        </div>
    )
}
