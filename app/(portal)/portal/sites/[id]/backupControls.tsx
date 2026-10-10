'use client'

// Making a copy, and deleting or downloading one. Each button calls its server action, which re-derives
// who is asking from the session and checks ownership itself, so nothing here decides anything: it names a
// site and a copy, and that is all it is trusted with. The download is a plain link to the relay route,
// which makes the same checks.

import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { backupNowAction, deleteBackupAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

// hostd answers a run as soon as it has started and records it when it ends, so the page watches for a
// run newer than the newest one it had, or for hostd to stop saying one is running, and refreshes until
// then. Per browser, like the deploy watch.
const POLL_MS = 5000
// Longer than any of these sites' copies take. Past it the page stops refreshing itself and says so
// rather than spinning for ever.
const GIVE_UP_MS = 15 * 60 * 1000

type Props = {
    id: string
    // Why a manual copy would be refused right now, or null. Worked out from hostd's own rule.
    block: string | null
    // hostd is making a copy of this site right now, whoever asked for it
    running: boolean
    // The newest run in hostd's history. The watch below ends when this changes.
    latest: string | null
}

export function BackupControls({ id, block, running, latest }: Props) {
    const router = useRouter()
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [watch, setWatch] = useState<{ from: string | null } | null>(null)
    const [gaveUp, setGaveUp] = useState(false)

    // Also refreshes while hostd says a copy is running that this browser did not start (a scheduled one,
    // or one from another tab), so the list fills in by itself either way.
    const waiting = watch !== null || running

    useEffect(() => {
        if (watch && latest !== watch.from && !running) {
            setWatch(null)
            return
        }
        if (!waiting) return
        const timer = setInterval(() => router.refresh(), POLL_MS)
        const stop = setTimeout(() => { setWatch(null); setGaveUp(true) }, GIVE_UP_MS)
        return () => { clearInterval(timer); clearTimeout(stop) }
    }, [watch, latest, running, waiting, router])

    async function backUp() {
        setPending(true)
        setSaid(null)
        setGaveUp(false)
        try {
            const result = await backupNowAction(id)
            setSaid(result)
            if (result.ok) {
                setWatch({ from: latest })
                router.refresh()
            }
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    return (
        <>
            <div className={styles.controls}>
                <Button variant="primary" disabled={pending || waiting || block !== null} onClick={backUp}>
                    {pending ? 'Starting...' : 'Back up now'}
                </Button>
                {block && !waiting && <span className={styles.state}>{block}</span>}
            </div>

            {waiting && !gaveUp && (
                <div className={styles.said}>
                    <Callout title="Making a copy">
                        It takes a few minutes. This page is checking every few seconds and will show the copy
                        when it is done.
                    </Callout>
                </div>
            )}

            {gaveUp && (
                <div className={styles.said}>
                    <Callout tone="warn" title="Still nothing">
                        Fifteen minutes and the copy has not finished. Reload the page to see where it is.
                    </Callout>
                </div>
            )}

            {said && !said.ok && (
                <div className={styles.said}>
                    <Callout tone="crit" title="That did not happen">{said.error}</Callout>
                </div>
            )}
        </>
    )
}

type RowProps = {
    id: string
    snapshot: string
    // When the copy was made, as the list shows it, so the confirmation names the same thing
    label: string
    // The operator's Restore button (restoreControls.tsx), which a client never gets
    children?: ReactNode
}

export function BackupRowActions({ id, snapshot, label, children }: RowProps) {
    const router = useRouter()
    const [asking, setAsking] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function remove() {
        setPending(true)
        setError(null)
        try {
            const result = await deleteBackupAction(id, snapshot)
            if (result.ok) {
                setAsking(false)
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
        <span className={styles.rowActions}>
            {/* A link rather than a button: the browser downloads it as it streams, and nothing is held
                in this page while it does. */}
            <a className={styles.download} href={`/api/sites/${id}/backups/${snapshot}`} download>
                Download
            </a>
            {children}
            <Button size="small" variant="quiet" onClick={() => { setError(null); setAsking(true) }}>
                Delete
            </Button>

            <Dialog
                open={asking}
                onClose={() => setAsking(false)}
                title="Delete this copy"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(false)}>Keep it</Button>
                        <Button variant="danger" disabled={pending} onClick={remove}>
                            {pending ? 'Deleting...' : 'Delete'}
                        </Button>
                    </>
                }
            >
                <p>The copy from {label} is deleted for good. There is no other copy of it to fall back on.</p>
                {error && <Callout tone="crit" title="That did not happen">{error}</Callout>}
            </Dialog>
        </span>
    )
}
