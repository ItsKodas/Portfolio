'use client'

// Start, stop and restart. The buttons call the server action directly and report what it said, the same
// shape app/(portal)/portal/forms.tsx uses for the pre-auth actions. Nothing here decides whether the
// caller may do this: the action re-derives that from the session every time.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { lifecycleAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

const ACTIONS = [
    { id: 'start', label: 'Start' },
    { id: 'stop', label: 'Stop' },
    { id: 'restart', label: 'Restart' },
] as const

const OFF = 'hostd has lifecycle turned off for this project, so these would be refused.'

export function Lifecycle({ id, enabled }: { id: string, enabled: boolean }) {
    const router = useRouter()
    const [pending, setPending] = useState<string | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    async function run(action: string) {
        setPending(action)
        setSaid(null)
        try {
            const result = await lifecycleAction(id, action)
            setSaid(result)
            // The states on this page were read before the action, so they are now out of date. refresh()
            // re-runs the server component rather than patching a guess in over the top of them.
            if (result.ok) router.refresh()
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(null)
        }
    }

    return (
        <>
            <div className={styles.controls}>
                {ACTIONS.map(action => (
                    <Button
                        key={action.id}
                        variant={action.id === 'restart' ? 'primary' : undefined}
                        size="small"
                        // Genuinely unavailable rather than merely off in this view, and the reason is
                        // spelled out beside it rather than left to the cursor.
                        disabled={!enabled || pending !== null}
                        title={enabled ? undefined : OFF}
                        onClick={() => run(action.id)}
                    >
                        {pending === action.id ? `${action.label}...` : action.label}
                    </Button>
                ))}
                {!enabled && <span className={styles.state}>{OFF}</span>}
            </div>

            {said && (
                <div className={styles.said}>
                    {said.ok
                        ? <Callout title="Asked for">{said.message}</Callout>
                        : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                </div>
            )}
        </>
    )
}
