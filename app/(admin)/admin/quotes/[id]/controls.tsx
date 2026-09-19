'use client'

// The parts of the quote page that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it).

import { useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, MenuItem, Stack, TextField } from '@mui/material'
import { DeleteOutline } from '@mui/icons-material'

import { STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { addNoteAction, deleteNoteAction, deleteQuoteAction, resendEmailsAction, setArchivedAction, setStatusAction, type ActionResult } from '../../actions'

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

const Problem = ({ error }: { error: string | null }) => (error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null)

export function StatusPicker({ quoteId, status }: { quoteId: string, status: Status }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <TextField select size="small" label="Status" value={status} disabled={pending} sx={{ minWidth: 160 }}
                onChange={event => run(() => setStatusAction(quoteId, event.target.value))}>
                {STATUSES.map(value => <MenuItem key={value} value={value}>{STATUS_LABELS[value]}</MenuItem>)}
            </TextField>
            <Problem error={error} />
        </div>
    )
}

export function QuoteActions({ quoteId, archived, emailsMissing }: { quoteId: string, archived: boolean, emailsMissing: boolean }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                <Button variant="outlined" disabled={pending} onClick={() => run(() => setArchivedAction(quoteId, !archived))}>
                    {archived ? 'Unarchive' : 'Archive'}
                </Button>
                {emailsMissing && (
                    <Button variant="outlined" color="warning" disabled={pending} onClick={() => run(() => resendEmailsAction(quoteId))}>
                        Resend emails
                    </Button>
                )}
                <Button variant="outlined" color="error" disabled={pending} onClick={() => setConfirming(true)}>Delete</Button>
            </Stack>
            <Problem error={error} />
            <Dialog open={confirming} onClose={() => setConfirming(false)}>
                <DialogTitle>Delete this quote?</DialogTitle>
                <DialogContent>
                    <DialogContentText>This removes the quote and its notes. It can&apos;t be undone from here.</DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button color="error" disabled={pending} onClick={() => run(() => deleteQuoteAction(quoteId), () => setConfirming(false))}>Delete</Button>
                </DialogActions>
            </Dialog>
        </div>
    )
}

export function NoteForm({ quoteId }: { quoteId: string }) {
    const { pending, error, run } = useAction()
    const [body, setBody] = useState('')
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => addNoteAction(quoteId, body), () => setBody('')) }}>
            <TextField label="Add a note" multiline minRows={2} fullWidth value={body} onChange={event => setBody(event.target.value)} />
            <Button type="submit" variant="contained" disabled={pending || !body.trim()} sx={{ mt: 1 }}>Save note</Button>
            <Problem error={error} />
        </form>
    )
}

export function DeleteNoteButton({ quoteId, noteId }: { quoteId: string, noteId: string }) {
    const { pending, error, run } = useAction()
    return (
        <>
            <IconButton size="small" aria-label="Delete note" disabled={pending} onClick={() => run(() => deleteNoteAction(quoteId, noteId))}>
                <DeleteOutline fontSize="small" />
            </IconButton>
            <Problem error={error} />
        </>
    )
}
