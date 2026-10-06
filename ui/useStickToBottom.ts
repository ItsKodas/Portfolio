'use client'

// Keeps a scrolling box at its bottom while new content arrives, unless the reader has scrolled up to
// read something earlier. One hook for every box in the portal that reads newest-at-the-bottom (a log, a
// deploy's output, what a command printed), so they all follow the same way and stop following the same way.
//
// Two things used to leave those boxes stuck short of the bottom:
//
// - Deciding "the reader left" from where a scroll event finds the box. The event arrives a frame after
//   the scroll that caused it, and in a burst of lines more content has landed by then, so the box reads
//   as scrolled up when nobody touched it and following stops for good. Only the reader moving up counts
//   here: content growing underneath never lowers scrollTop.
// - Scrolling only when the lines change. A box whose height settles after the lines land (a flex pane
//   taking its share, a callout above it going away, the mono font swapping in and rewrapping, a closed
//   <details> opening) ends short of the bottom with nothing new on the way to fix it. Content and size
//   are watched instead, whatever caused them to change.

import { useEffect, useRef } from 'react'

// Close enough to the bottom to count as at it: a line and a bit, so a stray nudge does not stop following
const SLACK = 24

export function useStickToBottom<T extends HTMLElement>() {
    const ref = useRef<T>(null)

    useEffect(() => {
        const box = ref.current
        if (!box) return

        // Following from the start: what a reader opens one of these for is the end of it
        let pinned = true
        let last = 0

        function stick() {
            if (!box || !pinned) return
            box.scrollTop = box.scrollHeight
            last = box.scrollTop
        }

        function onScroll() {
            if (!box) return
            const distance = box.scrollHeight - box.scrollTop - box.clientHeight
            if (distance <= SLACK) pinned = true
            else if (box.scrollTop < last) pinned = false
            last = box.scrollTop
        }

        // The box itself for its own height, and each of its children for theirs: a line rewrapping when
        // the font arrives changes the content's height without a single node changing. jsdom has no
        // ResizeObserver, and a browser old enough to lack one still gets the content watch below.
        const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick)
        sizes?.observe(box)
        for (const child of Array.from(box.children)) sizes?.observe(child)

        const content = new MutationObserver(records => {
            for (const record of records) {
                if (record.target !== box) continue
                // Let go of the lines that scrolled off the top, or a log capped at 2000 lines would hold
                // on to every line it ever showed
                for (const node of Array.from(record.removedNodes)) if (node instanceof Element) sizes?.unobserve(node)
                for (const node of Array.from(record.addedNodes)) if (node instanceof Element) sizes?.observe(node)
            }
            stick()
        })
        content.observe(box, { childList: true, subtree: true, characterData: true })

        box.addEventListener('scroll', onScroll, { passive: true })
        stick()

        return () => {
            box.removeEventListener('scroll', onScroll)
            content.disconnect()
            sizes?.disconnect()
        }
    }, [])

    return ref
}
