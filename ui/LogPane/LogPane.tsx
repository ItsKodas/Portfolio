'use client'

import { useEffect, useRef } from 'react'

import styles from './LogPane.module.css'

type Line = {
    time: string
    text: string
    stream?: 'out' | 'err'
}

type Props = {
    lines: Line[]
    label: string
    following?: boolean
    // Take the height left over rather than the fixed box, for a page that has given this pane the room
    fill?: boolean
}

export function LogPane({ lines, label, following, fill }: Props) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        // Newest at the bottom, like every log anyone has ever read
        const pane = ref.current
        if (pane && following) pane.scrollTop = pane.scrollHeight
    }, [lines, following])

    return (
        <div
            ref={ref}
            className={[styles.pane, fill && styles.fill].filter(Boolean).join(' ')}
            role="region"
            aria-label={label}
            // A region that scrolls must be focusable, or a keyboard cannot scroll it
            tabIndex={0}
        >
            {lines.length === 0
                ? <div className={styles.empty}>Nothing yet.</div>
                : lines.map((line, index) => (
                    <div className={[styles.line, line.stream === 'err' && styles.err].filter(Boolean).join(' ')} key={index}>
                        <span className={styles.time}>{line.time}</span>
                        <span className={styles.text}>{line.text}</span>
                    </div>
                ))}
        </div>
    )
}
