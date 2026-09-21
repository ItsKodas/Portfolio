'use client'

// The three things that start work on an environment: deploy its branch, put the last good version back,
// and follow a different branch. Each calls its server action, which re-derives who is asking from the
// session and refuses a client outright, so nothing here decides anything: it names an environment and an
// action, and that is all it is trusted with.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { deployAction, rollbackAction, setBranchAction, type SiteActionResult } from './actions'
import { shortCommit } from './deploys'
import styles from './site.module.css'

// hostd records a deploy when it finishes, not when it starts, so there is nothing to ask for the
// progress of: an environment mid-deploy looks exactly like one that is idle. What this does have is the
// moment it asked, so it watches for a record newer than the newest one it had and refreshes until one
// lands. That is per browser: another tab, or Koda on his phone, sees the history and not the waiting.
const POLL_MS = 5000
// A deploy that is still not recorded after this either failed in a way hostd could not write down, or
// is a build far longer than any of these sites has. Either way the page stops refreshing itself and
// says so rather than spinning for ever.
const GIVE_UP_MS = 10 * 60 * 1000

const OFF = 'hostd has deploys turned off for this project, so these would be refused.'

type Props = {
    id: string
    environment: string
    enabled: boolean
    branch: string | null
    // The commit hostd would go back to, worked out from the same rule it uses. Null when there is no
    // earlier healthy deploy, which is when a rollback would be refused.
    rollbackTo: string | null
    // When the newest record in the history started. The watch below ends when this changes.
    latest: string | null
}

export function DeployControls({ id, environment, enabled, branch, rollbackTo, latest }: Props) {
    const router = useRouter()
    const [pending, setPending] = useState<string | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    // What the newest record was when we started something, or null when we are not waiting on anything.
    // An object rather than the string itself, because "no deploys yet" is a legitimate value to wait on.
    const [watch, setWatch] = useState<{ from: string | null } | null>(null)
    const [gaveUp, setGaveUp] = useState(false)
    const [asking, setAsking] = useState<'rollback' | 'branch' | null>(null)
    const [wanted, setWanted] = useState(branch ?? '')

    useEffect(() => {
        if (!watch) return
        // Something landed, so this is over and the page is already showing it
        if (latest !== watch.from) {
            setWatch(null)
            return
        }
        const timer = setInterval(() => router.refresh(), POLL_MS)
        const stop = setTimeout(() => { setWatch(null); setGaveUp(true) }, GIVE_UP_MS)
        return () => { clearInterval(timer); clearTimeout(stop) }
    }, [watch, latest, router])

    async function run(what: string, action: () => Promise<SiteActionResult>) {
        setPending(what)
        setSaid(null)
        setGaveUp(false)
        try {
            const result = await action()
            setSaid(result)
            // Only a started deploy is worth waiting for. A refusal has already happened and has nothing
            // coming after it.
            if (result.ok) {
                setWatch({ from: latest })
                router.refresh()
            }
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(null)
            setAsking(null)
        }
    }

    const busy = pending !== null || watch !== null
    const waiting = watch !== null

    return (
        <>
            <div className={styles.controls}>
                <Button
                    variant="primary"
                    disabled={!enabled || busy}
                    title={enabled ? undefined : OFF}
                    onClick={() => run('deploy', () => deployAction(id, environment))}
                >
                    {pending === 'deploy' ? 'Starting...' : 'Deploy now'}
                </Button>

                <Button
                    disabled={!enabled || busy || rollbackTo === null}
                    // Spelled out rather than left to the cursor, and it is the reason the button is off
                    // rather than a general note about rollbacks.
                    title={rollbackTo === null ? 'There is no earlier healthy deploy to go back to.' : undefined}
                    onClick={() => setAsking('rollback')}
                >
                    Roll back
                </Button>

                <Button variant="quiet" disabled={!enabled || busy} onClick={() => { setWanted(branch ?? ''); setAsking('branch') }}>
                    Change branch
                </Button>

                {!enabled && <span className={styles.state}>{OFF}</span>}
            </div>

            {waiting && (
                <div className={styles.said}>
                    <Callout title="Working on it">
                        It builds first and swaps over after. This page is checking every few seconds and
                        will show the result when there is one.
                    </Callout>
                </div>
            )}

            {gaveUp && (
                <div className={styles.said}>
                    <Callout tone="warn" title="Still nothing">
                        Ten minutes with nothing written down. Reload the page, and if it is still empty
                        the agent log on the dedi is the place to look.
                    </Callout>
                </div>
            )}

            {said && !waiting && (
                <div className={styles.said}>
                    {said.ok
                        ? <Callout title="Asked for">{said.message}</Callout>
                        : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                </div>
            )}

            <Dialog
                open={asking === 'rollback'}
                onClose={() => setAsking(null)}
                title="Roll back this environment"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(null)}>Leave it</Button>
                        <Button
                            variant="primary"
                            disabled={pending !== null}
                            onClick={() => run('rollback', () => rollbackAction(id, environment))}
                        >
                            {pending === 'rollback' ? 'Rolling back...' : 'Roll back'}
                        </Button>
                    </>
                }
            >
                <p>
                    {environment} goes back to <span className={styles.mono}>{shortCommit(rollbackTo ?? '')}</span>,
                    the last commit it served healthily. Visitors see the holding page for a few seconds
                    while it swaps over.
                </p>
                <p className={styles.note}>
                    The branch is not changed, so the next push deploys normally. hostd chooses the commit
                    itself: there is no way to ask for a different one from here.
                </p>
            </Dialog>

            <Dialog
                open={asking === 'branch'}
                onClose={() => setAsking(null)}
                title="Follow a different branch"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(null)}>Cancel</Button>
                        <Button
                            variant="primary"
                            disabled={pending !== null || !wanted.trim() || wanted === branch}
                            onClick={() => run('branch', () => setBranchAction(id, environment, wanted.trim()))}
                        >
                            {pending === 'branch' ? 'Switching...' : 'Switch and deploy'}
                        </Button>
                    </>
                }
            >
                <Field
                    label="Branch"
                    value={wanted}
                    spellCheck={false}
                    autoComplete="off"
                    hint={branch ? `It follows ${branch} today.` : 'This environment follows no branch yet.'}
                    onChange={event => setWanted(event.target.value)}
                />
                <p className={styles.note}>
                    Switching deploys the tip of the new branch straight away, and starts polling it again
                    if this environment was paused.
                </p>
            </Dialog>
        </>
    )
}
