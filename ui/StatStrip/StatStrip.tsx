import styles from './StatStrip.module.css'

type Stat = {
    key: string
    value: string
    note?: string
    tone?: 'good' | 'warn' | 'crit'
}

export function StatStrip({ stats }: { stats: Stat[] }) {
    // An empty strip is two hairlines with nothing between them, which reads as a bug
    if (!stats.length) return null
    return (
        <dl className={styles.strip}>
            {stats.map(stat => (
                <div className={styles.stat} key={stat.key}>
                    <dt className={styles.key}>{stat.key}</dt>
                    <dd className={[styles.value, stat.tone && styles[stat.tone]].filter(Boolean).join(' ')}>
                        {stat.value}
                    </dd>
                    {stat.note && <dd className={styles.note}>{stat.note}</dd>}
                </div>
            ))}
        </dl>
    )
}
