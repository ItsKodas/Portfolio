import type { ReactNode } from 'react'

import styles from './KeyValue.module.css'

type Pair = {
    key: string
    value: ReactNode
    tone?: 'warn' | 'crit'
}

export function KeyValue({ pairs }: { pairs: Pair[] }) {
    if (!pairs.length) return null
    return (
        <dl className={styles.kv}>
            {pairs.map(pair => (
                <div style={{ display: 'contents' }} key={pair.key}>
                    <dt className={styles.key}>{pair.key}</dt>
                    <dd className={[styles.value, pair.tone && styles[pair.tone]].filter(Boolean).join(' ')}>
                        {pair.value}
                    </dd>
                </div>
            ))}
        </dl>
    )
}
