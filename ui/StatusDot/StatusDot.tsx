import styles from './StatusDot.module.css'

export type State = 'up' | 'down' | 'deploying' | 'stopped' | 'paused' | 'unknown'

// label says the word this dot is standing for when the caller has a more exact one: a container is
// "running" or "exited" rather than up or down, and the site page's environment bar says so. The word is
// still the meaning, which is the whole contract here; only its wording moves.
export function StatusDot({ state, label }: { state: State, label?: string }) {
    // The word is the meaning; the dot is decoration and is hidden, so nothing depends on colour alone.
    return (
        <span className={styles.wrap}>
            <span className={[styles.dot, styles[state]].join(' ')} aria-hidden="true" />
            <span>{label ?? state}</span>
        </span>
    )
}
