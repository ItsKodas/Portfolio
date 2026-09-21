'use client'

// Start, stop and restart. The buttons call the server action directly and report what it said, the same
// shape app/(portal)/portal/forms.tsx uses for the pre-auth actions. Nothing here decides whether the
// caller may do this: the action re-derives that from the session every time.
//
// Two controls rather than three. Start and Stop are one button that says the thing this site needs next,
// because only one of them was ever going to do anything and a site that is already running does not need
// to be offered a start. It reads the site's state to decide, so a state nobody could read leaves the
// button alone rather than guessing at which half to show.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import type { SiteState } from '../../siteState'
import { lifecycleAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

const OFF = 'hostd has lifecycle turned off for this project, so these would be refused.'
const UNREADABLE = 'The containers could not be read, so there is nothing to act on until they can be.'

// Said before it is done, not after. Stopping is the one control here that leaves the site switched off
// behind it: a restart comes back by itself, a stop waits for somebody to come back and start it.
const STOPPING = 'Visitors will see the holding page until somebody starts it again. Nothing is deleted, '
    + 'and starting it brings the site back as it was.'

export function Lifecycle({ id, enabled, state }: { id: string, enabled: boolean, state: SiteState }) {
    const router = useRouter()
    const [pending, setPending] = useState<string | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [asking, setAsking] = useState(false)

    // A site that is up is asking to be stopped; anything else that is readable is asking to be started.
    // Unknown is neither, and is the reason the pair is disabled rather than shown as a guess.
    const known = state !== 'unknown'
    const toggle = state === 'up' ? 'stop' : 'start'
    const label = toggle === 'stop' ? 'Stop' : 'Start'
    const why = !enabled ? OFF : !known ? UNREADABLE : null

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

    function press() {
        // Starting and restarting both end with the site up, so neither is worth a question. Stopping
        // does not, and it is one click away from a live client site.
        if (toggle === 'stop') return setAsking(true)
        void run('start')
    }

    return (
        <>
            <div className={styles.controls}>
                <Button
                    variant={toggle === 'stop' ? 'danger' : 'primary'}
                    // Genuinely unavailable rather than merely off in this view, and the reason is
                    // spelled out beside it rather than left to the cursor.
                    disabled={why !== null || pending !== null}
                    title={why ?? undefined}
                    onClick={press}
                >
                    {pending === toggle ? `${label}...` : label}
                </Button>
                <Button
                    disabled={why !== null || pending !== null}
                    title={why ?? undefined}
                    onClick={() => run('restart')}
                >
                    {pending === 'restart' ? 'Restart...' : 'Restart'}
                </Button>
                {why && <span className={styles.state}>{why}</span>}
            </div>

            {said && (
                <div className={styles.said}>
                    {said.ok
                        ? <Callout title="Asked for">{said.message}</Callout>
                        : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                </div>
            )}

            <Dialog
                open={asking}
                onClose={() => setAsking(false)}
                title="Stop this site?"
                footer={
                    <>
                        <Button onClick={() => setAsking(false)}>Cancel</Button>
                        <Button
                            variant="danger"
                            onClick={() => { setAsking(false); void run('stop') }}
                        >
                            Stop the site
                        </Button>
                    </>
                }
            >
                {STOPPING}
            </Dialog>
        </>
    )
}
