import type { ReactNode } from 'react'

import styles from './Chip.module.css'

export function Chip({ tone, children }: { tone?: 'good' | 'warn' | 'crit', children: ReactNode }) {
    return <span className={[styles.chip, tone && styles[tone]].filter(Boolean).join(' ')}>{children}</span>
}
