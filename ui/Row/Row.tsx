import type { ReactNode } from 'react'

import styles from './Row.module.css'

type Props = {
    tone?: 'crit' | 'warn'
    onClick?: () => void
    lead?: ReactNode
    title: ReactNode
    sub?: ReactNode
    aside?: ReactNode
    meta?: ReactNode
}

export function Row({ tone, onClick, lead, title, sub, aside, meta }: Props) {
    const classes = [styles.row, tone && styles[tone]].filter(Boolean).join(' ')
    const inner = (
        <>
            {lead && <span className={styles.lead}>{lead}</span>}
            <span className={styles.grow}>
                <span className={styles.title}>{title}</span>
                {sub && <span className={styles.sub}>{sub}</span>}
            </span>
            {aside && <span className={styles.aside}>{aside}</span>}
            {meta && <span className={styles.meta}>{meta}</span>}
        </>
    )

    // A div with a click handler is unreachable by keyboard and invisible to a screen reader. A row that
    // does something is a button; a row that does not is not pretending to be one.
    if (!onClick) return <div className={classes}>{inner}</div>
    return <button type="button" className={classes} onClick={onClick}>{inner}</button>
}
