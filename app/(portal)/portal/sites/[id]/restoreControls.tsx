'use client'

// Putting a backup back over live, and watching it happen. The operator's alone: hostd keeps backup-restore
// among its admin-only verbs, the panel never renders any of this for a client, and both server actions
// re-derive who is asking from the session anyway. The site's name is typed back and sent to hostd as typed,
// so hostd's own comparison is the confirmation; nothing here decides anything.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import type { RestoreRecord } from '@/server/hostd/backups'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { restoreBackupAction, restoresAction } from './actions'
import styles from './site.module.css'

// A restore pauses the site, so it is watched more closely than a copy is
const POLL_MS = 3000
// Longer than any of these sites' restores take, safety copy included. Past it the page stops asking and
// says so rather than spinning for ever.
const GIVE_UP_MS = 30 * 60 * 1000

// Where a restore is, in words. hostd's steps are restore-run.ts's: safety, space, extract, prepare, then
// one per service (load:<service>, sqlite:<service>, storage:<path>), restore-state and clean.
export function stepWords(step: string | null): string {
    if (step === null) return 'Starting'
    if (step === 'safety') return 'Making a fresh copy of the live site first'
    if (step === 'space') return 'Checking there is room to unpack the copy'
    if (step === 'extract') return 'Unpacking the copy'
    if (step === 'prepare') return 'Pausing the site'
    if (step.startsWith('load:')) return `Putting the ${step.slice(5)} database back`
    if (step.startsWith('sqlite:')) return `Putting the ${step.slice(7)} database file back`
    if (step.startsWith('storage:')) return `Putting the stored files back (${step.slice(8)})`
    if (step === 'restore-state') return 'Starting the site again'
    if (step === 'clean') return 'Tidying up'
    return step
}

function newest(restores: RestoreRecord[]): RestoreRecord | null {
    return [...restores].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
}

type StatusProps = {
    id: string
    // What the panel read from hostd when the page was drawn
    restores: RestoreRecord[]
    running: boolean
}

// The latest restore, and while one runs, where it has got to. Polls the restores rather than refreshing
// the whole page, then refreshes once at the end so the list shows the safety copy it made.
export function RestoreStatus({ id, restores: initial, running: initiallyRunning }: StatusProps) {
    const router = useRouter()
    const [restores, setRestores] = useState(initial)
    const [running, setRunning] = useState(initiallyRunning)
    const [gaveUp, setGaveUp] = useState(false)

    // A refresh after a restore was started hands down new props: take them
    useEffect(() => { setRestores(initial); setRunning(initiallyRunning); setGaveUp(false) }, [initial, initiallyRunning])

    useEffect(() => {
        if (!running) return
        let cancelled = false
        const timer = setInterval(async () => {
            try {
                const result = await restoresAction(id)
                if (cancelled || !result.ok) return
                setRestores(result.restores)
                setRunning(result.running)
                if (!result.running) router.refresh()
            } catch {
                // the next tick tries again
            }
        }, POLL_MS)
        const stop = setTimeout(() => { setRunning(false); setGaveUp(true) }, GIVE_UP_MS)
        return () => { cancelled = true; clearInterval(timer); clearTimeout(stop) }
    }, [id, running, router])

    const latest = newest(restores)

    if (gaveUp) {
        return (
            <div className={styles.said}>
                <Callout tone="warn" title="Still restoring">
                    Thirty minutes and the restore has not finished. Reload the page to see where it is.
                </Callout>
            </div>
        )
    }
    if (running || latest?.outcome === 'running') {
        return (
            <div className={styles.said}>
                <Callout title="Restoring">
                    {`${stepWords(latest?.step ?? null)}. `}
                    The site is paused while its databases and files are replaced. This page is checking every
                    few seconds.
                </Callout>
            </div>
        )
    }
    if (!latest) return null
    if (latest.outcome === 'ok') {
        return (
            <div className={styles.said}>
                <Callout tone="good" title="The last restore worked">
                    {`Copy ${latest.snapshot} was put back over live`}
                    {latest.safety ? `, after a fresh copy (${latest.safety}) of what was there before.` : '.'}
                </Callout>
            </div>
        )
    }
    return (
        <div className={styles.said}>
            <Callout tone="crit" title="The last restore did not work">
                {`Putting ${latest.snapshot} back stopped at "${stepWords(latest.step)}": `}
                {latest.reason ?? 'no reason was recorded'}
            </Callout>
        </div>
    )
}

type ButtonProps = {
    id: string
    // The site's name, which has to be typed back
    name: string
    snapshot: string
    // When the copy was made, as the list shows it, so the confirmation names the same thing
    label: string
    // Why a restore would be refused right now (a copy or another restore running), or null
    block: string | null
}

export function RestoreButton({ id, name, snapshot, label, block }: ButtonProps) {
    const router = useRouter()
    const [asking, setAsking] = useState(false)
    const [typed, setTyped] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const named = typed.trim() === name

    async function restore() {
        setPending(true)
        setError(null)
        try {
            const result = await restoreBackupAction(id, snapshot, typed.trim())
            if (result.ok) {
                setAsking(false)
                setTyped('')
                router.refresh()
            } else {
                setError(result.error)
            }
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }

    return (
        <>
            <Button
                size="small"
                variant="quiet"
                disabled={block !== null}
                title={block ?? undefined}
                onClick={() => { setError(null); setTyped(''); setAsking(true) }}
            >
                Restore
            </Button>

            <Dialog
                open={asking}
                onClose={() => setAsking(false)}
                title="Put this copy back over live"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(false)}>Cancel</Button>
                        <Button variant="danger" disabled={pending || !named} onClick={restore}>
                            {pending ? 'Starting...' : 'Restore'}
                        </Button>
                    </>
                }
            >
                <p>
                    {`${name}'s live site goes back to the copy from ${label} `}
                    (<span className={styles.mono}>{snapshot}</span>).
                </p>
                <ul>
                    <li>A fresh copy of live is made first, so this can be undone by restoring that one.</li>
                    <li>The site is paused while its databases and stored files are replaced, then started again.</li>
                    <li>Everything it saved after {label} is replaced. Code and settings are left alone.</li>
                </ul>
                <Field
                    label={`Type ${name} to confirm`}
                    value={typed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => setTyped(event.target.value)}
                />
                {error && <Callout tone="crit" title="That did not happen">{error}</Callout>}
            </Dialog>
        </>
    )
}
