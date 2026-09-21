'use client'

// Start, stop and restart. The buttons call the server action directly and report what it said, the same
// shape app/(portal)/portal/forms.tsx uses for the pre-auth actions. Nothing here decides whether the
// caller may do this: the action re-derives that from the session every time.
//
// Two controls rather than three. Start and Stop are one button that says the thing this site needs next,
// because only one of them was ever going to do anything and a site that is already running does not need
// to be offered a start. It reads the site's state to decide, so a state nobody could read leaves the
// button alone rather than guessing at which half to show.
//
// Until the action is done, though, the state underneath is not the thing to read. hostd answers when it
// has taken the job, so the pair came back to life over a site that was still coming up and a second
// click landed on a container mid-restart. While ./settling says something is happening, the pair says
// what that is and stays out of the way until it has finished.

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import type { SiteState } from '../../siteState'
import { lifecycleAction, type SiteActionResult } from './actions'
import { useSettling, type LifecycleAction } from './settling'
import styles from './site.module.css'

const OFF = 'hostd has lifecycle turned off for this project, so these would be refused.'
const UNREADABLE = 'The containers could not be read, so there is nothing to act on until they can be.'

// Said before it is done, not after. Stopping is the one control here that leaves the site switched off
// behind it: a restart comes back by itself, a stop waits for somebody to come back and start it.
const STOPPING = 'Visitors will see the holding page until somebody starts it again. Nothing is deleted, '
    + 'and starting it brings the site back as it was.'

// On the button doing the work, for as long as it is being done. It is the click's own verb rather than
// the state's, which is the point: halfway through a stop the site reads stopped, and a button that then
// says Start is describing the next move over the top of the one it is making.
const BUSY: Record<LifecycleAction, string> = {
    start: 'Starting...',
    stop: 'Stopping...',
    restart: 'Restarting...',
}

// Over the sentence the action gave us, while it is still going on
const WORKING: Record<LifecycleAction, string> = {
    start: 'Starting it',
    stop: 'Stopping it',
    restart: 'Restarting it',
}

const GAVE_UP = 'A minute and a half, and the site still is not where that was taking it. Reload the page. '
    + 'If it still is not there, the agent log on the dedi is the place to look.'

export function Lifecycle({ id, enabled, state }: { id: string, enabled: boolean, state: SiteState }) {
    const router = useRouter()
    const [pending, setPending] = useState<LifecycleAction | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [asking, setAsking] = useState(false)
    const { settling, gaveUp, begin } = useSettling()

    // Sent, or taken and not yet finished. Both are the site in the middle of something, and neither is a
    // moment to offer a second click.
    const acting = pending ?? settling?.action ?? null

    // A site that is up is asking to be stopped; anything else that is readable is asking to be started.
    // Unknown is neither, and is the reason the pair is disabled rather than shown as a guess.
    const known = state !== 'unknown'
    const toggle = state === 'up' ? 'stop' : 'start'
    // Not while something is happening: mid-restart hostd can refuse a status read, and that is this
    // operation rather than a fault to report. The pair is held below for a better reason than that one.
    const why = settling ? null : !enabled ? OFF : !known ? UNREADABLE : null
    const held = why !== null || acting !== null

    // Which half of the pair the first button is, which is the state's to say only while nothing is
    // happening to it. While something is, it is whichever of the two was clicked.
    const shown = acting === 'start' || acting === 'stop' ? acting : toggle

    const waited = useRef(false)
    useEffect(() => {
        // The sentence was about what was going to happen. It has, and the strip and the log beside it
        // are already showing the result, so it stops being news.
        if (waited.current && !settling) setSaid(null)
        waited.current = settling !== null
    }, [settling])

    async function run(action: LifecycleAction) {
        setPending(action)
        setSaid(null)
        try {
            const result = await lifecycleAction(id, action)
            setSaid(result)
            // The states on this page were read before the action, so they are now out of date. refresh()
            // re-runs the server component rather than patching a guess in over the top of them, and the
            // wait below keeps re-running it until one of them says the site got where it was going.
            if (result.ok) {
                begin(action)
                router.refresh()
            }
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
                    variant={shown === 'stop' ? 'danger' : 'primary'}
                    // Genuinely unavailable rather than merely off in this view, and the reason is
                    // spelled out beside it rather than left to the cursor.
                    disabled={held}
                    title={why ?? undefined}
                    onClick={press}
                >
                    {acting === shown ? BUSY[shown] : shown === 'stop' ? 'Stop' : 'Start'}
                </Button>
                <Button
                    disabled={held}
                    title={why ?? undefined}
                    onClick={() => run('restart')}
                >
                    {acting === 'restart' ? BUSY.restart : 'Restart'}
                </Button>
                {why && <span className={styles.state}>{why}</span>}
            </div>

            {said && (
                <div className={styles.said}>
                    {said.ok
                        ? (
                            <Callout title={settling ? WORKING[settling.action] : 'Asked for'}>
                                {said.message}
                                {/* A picture of the waiting the sentence above already describes, so it
                                    is hidden rather than announced twice. */}
                                {settling && (
                                    <span className={styles.bar} aria-hidden="true">
                                        <span className={styles.barRun} />
                                    </span>
                                )}
                            </Callout>
                        )
                        : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                </div>
            )}

            {gaveUp && (
                <div className={styles.said}>
                    <Callout tone="warn" title="This is taking longer than it should">{GAVE_UP}</Callout>
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
