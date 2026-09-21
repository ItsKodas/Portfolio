import styles from './StatusDot.module.css'

export type State = 'up' | 'down' | 'deploying' | 'stopped' | 'paused' | 'unknown'

// label says the word this dot is standing for when the caller has a more exact one: a container is
// "running" or "exited" rather than up or down, and the site page's environment bar says so. The word is
// still the meaning, which is the whole contract here; only its wording moves.
//
// bare is for the lists that carry one dot per site, where the same six words repeated down a column say
// less than their absence does. The word does not go away: it stops being drawn, and reaches a mouse
// through the dot's title instead.
export function StatusDot({ state, label, bare }: { state: State, label?: string, bare?: boolean }) {
    const word = label ?? state
    // The word is the meaning; the dot is decoration and is hidden, so nothing depends on colour alone.
    // The title rides on the hidden element deliberately: a browser still shows it on hover, and assistive
    // technology ignores it, so the word is not announced twice over.
    return (
        <span className={styles.wrap}>
            <span
                className={[styles.dot, styles[state], bare && styles.target].filter(Boolean).join(' ')}
                aria-hidden="true"
                title={bare ? word : undefined}
            />
            <span className={bare ? styles.hidden : undefined}>{word}</span>
        </span>
    )
}
