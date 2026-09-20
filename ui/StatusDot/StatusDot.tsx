import styles from './StatusDot.module.css'

type State = 'up' | 'down' | 'deploying' | 'stopped' | 'paused'

export function StatusDot({ state }: { state: State }) {
    // The word is the meaning; the dot is decoration and is hidden, so nothing depends on colour alone.
    return (
        <span className={styles.wrap}>
            <span className={[styles.dot, styles[state]].join(' ')} aria-hidden="true" />
            <span>{state}</span>
        </span>
    )
}
