'use client'

// The parts of the quote page that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it).

import { useState } from 'react'

import { STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { DeleteOutline } from '@/ui/icons'
import { addNoteAction, deleteNoteAction, deleteQuoteAction, resendEmailsAction, setArchivedAction, setStatusAction, type ActionResult } from '../actions'
import styles from './controls.module.css'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function run(action: () => Promise<ActionResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, run }
}

// The error is the whole message, as it was in the Alert this replaces, so it goes in the title rather than
// being split into a heading and a body that nobody wrote. Callout's crit tone announces it either way.
const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

export function StatusPicker({ quoteId, status }: { quoteId: string, status: Status }) {
    const { pending, error, run } = useAction()
    return (
        <div className={styles.picker}>
            <Field as="select" label="Status" value={status} disabled={pending}
                onChange={event => run(() => setStatusAction(quoteId, event.target.value))}>
                {STATUSES.map(value => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </Field>
            <Problem error={error} />
        </div>
    )
}

export function QuoteActions({ quoteId, archived, emailsMissing }: { quoteId: string, archived: boolean, emailsMissing: boolean }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <div className={styles.buttons}>
                <Button disabled={pending} onClick={() => run(() => setArchivedAction(quoteId, !archived))}>
                    {archived ? 'Unarchive' : 'Archive'}
                </Button>
                {emailsMissing && (
                    <Button className={styles.warn} disabled={pending} onClick={() => run(() => resendEmailsAction(quoteId))}>
                        Resend emails
                    </Button>
                )}
                <Button className={styles.crit} disabled={pending} onClick={() => setConfirming(true)}>Delete</Button>
            </div>
            <Problem error={error} />
            <Dialog
                open={confirming}
                onClose={() => setConfirming(false)}
                title="Delete this quote?"
                footer={
                    <>
                        <Button onClick={() => setConfirming(false)}>Cancel</Button>
                        <Button className={styles.crit} disabled={pending} onClick={() => run(() => deleteQuoteAction(quoteId), () => setConfirming(false))}>Delete</Button>
                    </>
                }
            >
                <p className={styles.dialogText}>This removes the quote and its notes. It can&apos;t be undone from here.</p>
            </Dialog>
        </div>
    )
}

export function NoteForm({ quoteId }: { quoteId: string }) {
    const { pending, error, run } = useAction()
    const [body, setBody] = useState('')
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => addNoteAction(quoteId, body), () => setBody('')) }}>
            <Field as="textarea" label="Add a note" rows={2} value={body} onChange={event => setBody(event.target.value)} />
            <div className={styles.noteSubmit}>
                <Button type="submit" variant="primary" disabled={pending || !body.trim()}>Save note</Button>
            </div>
            <Problem error={error} />
        </form>
    )
}

export function DeleteNoteButton({ quoteId, noteId }: { quoteId: string, noteId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button variant="quiet" size="small" aria-label="Delete note" disabled={pending} onClick={() => run(() => deleteNoteAction(quoteId, noteId))}>
                <DeleteOutline size={15} />
            </Button>
            <Problem error={error} />
        </div>
    )
}
