'use client'

import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'

import { ArrowBack, ArrowForward, Close } from '@/ui/icons'
import type { Shot } from '@/app/showcase/projects'

// A screenshot as a button that opens it in the lightbox. Desktop shots fill a 16:10 frame; phone shots sit in a
// phone-shaped frame inside the same box, so a mixed row still lines up; posters, which frame themselves, are shown
// whole in it.
function Thumb({ shot, sizes, priority, onOpen }: { shot: Shot, sizes: string, priority?: boolean, onOpen: () => void }) {
    return (
        <button type="button" onClick={onOpen}
            className="group relative block aspect-[16/10] w-full overflow-hidden rounded-2xl border border-[#8fd4f5]/10 bg-[#0e1530] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
            {shot.device === 'desktop' && <Image src={shot.src} alt={shot.alt} fill sizes={sizes} priority={priority} className="object-cover object-top motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-[1.02]" />}
            {shot.device === 'mobile' && (
                <span data-phone-frame className="absolute inset-y-[6%] left-1/2 aspect-[9/19.5] -translate-x-1/2 overflow-hidden rounded-[18%/8%] border-[3px] border-[#2a3358] bg-black">
                    <Image src={shot.src} alt={shot.alt} fill sizes="200px" className="object-cover object-top" />
                </span>
            )}
            {shot.device === 'poster' && <Image src={shot.src} alt={shot.alt} fill sizes="200px" className="object-contain py-[4%]" />}
        </button>
    )
}

// The project page's screenshots: the first one large, the rest in a grid (a sideways row on a phone), and any of them
// full screen in a lightbox with previous and next, the arrow keys, and Escape to close
export function Gallery({ shots, name }: { shots: Shot[], name: string }) {
    const [open, setOpen] = useState<number | null>(null)
    const dialog = useRef<HTMLDialogElement>(null)
    const n = shots.length

    // showModal gives the lightbox focus trapping, the top layer and an inert page behind it
    useEffect(() => {
        const el = dialog.current
        if (open === null || !el) return
        if (!el.open) el.showModal()
    }, [open])

    const close = () => {
        if (dialog.current?.open) dialog.current.close()
        setOpen(null)
    }
    const move = (by: number) => setOpen(i => i === null ? i : (i + by + n) % n)

    // Clicking the darkened space closes the lightbox, as it does anywhere else: the empty parts of the bars above and
    // below the image, and the stage around it. The image is drawn object-contain, so its element spans the whole stage;
    // only a click inside the part the picture is actually drawn in counts as clicking the image.
    const closeUnlessButton = (e: React.MouseEvent) => {
        if (!(e.target as HTMLElement).closest('button')) close()
    }
    const closeOffImage = (e: React.MouseEvent) => {
        const img = e.currentTarget.querySelector('img')
        if (img && img.naturalWidth && img.naturalHeight) {
            const box = img.getBoundingClientRect()
            const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
            const w = img.naturalWidth * scale, h = img.naturalHeight * scale
            const left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2
            if (e.clientX >= left && e.clientX <= left + w && e.clientY >= top && e.clientY <= top + h) return
        }
        close()
    }
    const [first, ...rest] = shots

    return (
        <>
            <Thumb shot={first} sizes="(min-width: 896px) 896px, 100vw" priority onOpen={() => setOpen(0)} />
            {rest.length > 0 && (
                <div className="-mx-5 mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
                    {rest.map((shot, i) => (
                        <div key={shot.src} className="w-[70%] shrink-0 snap-start md:w-auto">
                            <Thumb shot={shot} sizes="(min-width: 768px) 290px, 70vw" onOpen={() => setOpen(i + 1)} />
                        </div>
                    ))}
                </div>
            )}

            {open !== null && (
                <dialog ref={dialog} aria-label={`${name} screenshot ${open + 1} of ${n}`}
                    onCancel={e => { e.preventDefault(); close() }}
                    onKeyDown={e => {
                        if (e.key === 'ArrowLeft') move(-1)
                        if (e.key === 'ArrowRight') move(1)
                    }}
                    className="m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 text-white backdrop:bg-[#05080f]/95">
                    <div className="flex h-full flex-col">
                        <div data-testid="lightbox-bar" onClick={closeUnlessButton} className="flex items-center gap-3 px-4 py-3">
                            <p className="min-w-0 flex-1 truncate text-sm text-[#b4c3dc]">{shots[open].alt}</p>
                            <span className="text-sm tabular-nums text-[#8fa3c7]">{open + 1} / {n}</span>
                            <button type="button" aria-label="Close" onClick={close}
                                className="rounded-full p-2 text-[#dbe6f7] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
                                <Close size={22} />
                            </button>
                        </div>
                        <div data-testid="lightbox-stage" onClick={closeOffImage} className="relative min-h-0 flex-1">
                            <Image key={shots[open].src} src={shots[open].src} alt={shots[open].alt} fill sizes="100vw" className="object-contain" />
                        </div>
                        {n > 1 && (
                            <div onClick={closeUnlessButton} className="flex justify-center gap-3 py-4">
                                <button type="button" aria-label="Previous screenshot" onClick={() => move(-1)}
                                    className="rounded-full border border-white/20 p-2.5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
                                    <ArrowBack size={20} />
                                </button>
                                <button type="button" aria-label="Next screenshot" onClick={() => move(1)}
                                    className="rounded-full border border-white/20 p-2.5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fd4f5]/60">
                                    <ArrowForward size={20} />
                                </button>
                            </div>
                        )}
                    </div>
                </dialog>
            )}
        </>
    )
}
