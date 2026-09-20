import type { ReactNode } from 'react'

import styles from './Callout.module.css'

type Props = {
    tone?: 'good' | 'warn' | 'crit'
    title: string
    children: ReactNode
}

export function Callout({ tone, title, children }: Props) {
    // A problem should be announced when it appears; a note about how backups work should not interrupt.
    const isProblem = tone === 'crit' || tone === 'warn'
    return (
        <div className={[styles.callout, tone && styles[tone]].filter(Boolean).join(' ')} role={isProblem ? 'alert' : undefined}>
            <p className={styles.title}>{title}</p>
            <div className={styles.body}>{children}</div>
        </div>
    )
}
