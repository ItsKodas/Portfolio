import styles from './Meter.module.css'

type Props = {
    label: string
    value: string
    percent: number
    tone?: 'good' | 'warn' | 'crit'
    threshold?: number
    note?: string
    noteTone?: 'warn'
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

export function Meter({ label, value, percent, tone, threshold, note, noteTone }: Props) {
    return (
        <div className={styles.meter}>
            <div className={styles.label}>
                <span className={styles.name}>{label}</span>
                <span className={styles.value}>{value}</span>
            </div>
            {/* The bar is a picture of the number printed beside it, so it is hidden rather than
                described twice. */}
            <div className={styles.track} aria-hidden="true">
                <span
                    data-fill
                    className={[styles.fill, tone && styles[tone]].filter(Boolean).join(' ')}
                    style={{ width: `${clamp(percent)}%` }}
                />
                {threshold !== undefined && <span className={styles.tick} style={{ left: `${clamp(threshold)}%` }} />}
            </div>
            {note && <div className={[styles.note, noteTone && styles[noteTone]].filter(Boolean).join(' ')}>{note}</div>}
        </div>
    )
}
