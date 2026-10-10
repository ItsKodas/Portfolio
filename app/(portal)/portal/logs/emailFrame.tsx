'use client'

import { useEffect, useRef } from 'react'

import styles from './logs.module.css'

// An email as it went, in a frame for the reason the UI gallery uses one: it is a whole document with its
// own body, and the portal's stylesheet must not reach into it. Sandboxed too, because part of what is in
// it was typed by a stranger: allow-same-origin only lets this page read the frame's height, and with no
// allow-scripts nothing in it can run.
export function EmailFrame({ title, html }: { title: string, html: string }) {
    const ref = useRef<HTMLIFrameElement>(null)

    useEffect(() => {
        const frame = ref.current
        if (!frame) return
        const size = () => {
            const page = frame.contentDocument
            if (page) frame.style.height = `${page.documentElement.scrollHeight}px`
        }
        size()
        frame.addEventListener('load', size)
        return () => frame.removeEventListener('load', size)
    }, [html])

    return <iframe ref={ref} className={styles.frame} title={title} srcDoc={html} sandbox="allow-same-origin" scrolling="no" />
}
