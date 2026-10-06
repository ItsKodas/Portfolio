'use client'

// A block of captured output (what a deploy printed, what Apache said about a file) that opens at its
// end rather than its start. The end is where a failure says what went wrong, and a reader who wants
// the start can scroll up to it. The look is the caller's (a <pre> inside its own styles): this only
// decides where it opens.

import { useStickToBottom } from '@/ui/useStickToBottom'

export function Tail({ children }: { children: string }) {
    const ref = useStickToBottom<HTMLPreElement>()
    return <pre ref={ref}>{children}</pre>
}
