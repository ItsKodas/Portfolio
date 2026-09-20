'use client'

import { useCallback } from 'react'

import styles from './gallery.module.css'

// An iframe, not a div: an email is a whole document with its own body background, and dropping it into this
// page would let the admin area's stylesheet reach into markup that has to stand on its own in Gmail.
export function EmailPreview({ title, note, html }: { title: string, note: string, html: string }) {
    const fit = useCallback((frame: HTMLIFrameElement | null) => {
        if (!frame) return
        // Read the document each time rather than closing over it: srcDoc is still being parsed when the ref
        // runs, and the document the frame holds afterwards is a different one from the one it holds now.
        const size = () => {
            const page = frame.contentDocument
            if (page) frame.style.height = `${page.documentElement.scrollHeight}px`
        }
        size()
        frame.addEventListener('load', size)
        return () => frame.removeEventListener('load', size)
    }, [])

    return (
        <section className={styles.email}>
            <h3 className={styles.emailTitle}>{title}</h3>
            <p className={styles.note}>{note}</p>
            <iframe ref={fit} className={styles.frame} title={title} srcDoc={html} scrolling="no" />
        </section>
    )
}
