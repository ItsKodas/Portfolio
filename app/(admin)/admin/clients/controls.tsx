'use client'

// The parts of the client pages that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it), same shape as the quote controls.

import { useState } from 'react'
import {
    Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
    IconButton, Stack, TextField, Typography,
} from '@mui/material'
import { ContentCopy, DeleteOutline } from '@mui/icons-material'

import { siteSchema } from '@/server/clients/schema'
import {
    addSiteAction, clearLockAction, createClientAction, deleteClientAction, removeSiteAction,
    resendInviteAction, resetTwoFactorAction, sendResetAction, setSuspendedAction, updateClientAction,
    type AdminResult,
} from './actions'

function useAction() {
    const [pending, setPending] = useState(false)
    // The whole failed result, not just its message: createClientAction's duplicate-email error carries the
    // existing client's id along with it, so the form can offer a link instead of just an error string.
    const [failure, setFailure] = useState<(AdminResult & { ok: false }) | null>(null)
    async function run(action: () => Promise<AdminResult>, onDone?: () => void) {
        setPending(true)
        setFailure(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setFailure(result)
        } catch {
            setFailure({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }
    return { pending, error: failure?.error ?? null, failure, run }
}

const Problem = ({ error }: { error: string | null }) => (error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null)

// The id is what gets typed by hand into hostd's projects.yaml, so copying it correctly matters more than usual
export function ClientId({ id }: { id: string }) {
    const [copied, setCopied] = useState(false)

    async function copy() {
        try {
            await navigator.clipboard.writeText(id)
            setCopied(true)
        } catch {
            // Clipboard access can be refused by the browser; the id is still visible to select by hand
            setCopied(false)
        }
    }

    return (
        <Box>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                <Typography component="span" sx={{ fontFamily: 'monospace' }}>{id}</Typography>
                <IconButton size="small" aria-label="Copy client id" onClick={copy}>
                    <ContentCopy fontSize="small" />
                </IconButton>
                {copied && <Typography variant="caption" color="success.main">Copied</Typography>}
            </Stack>
            <Typography variant="caption" color="text.secondary">
                Use this as <code>client:</code> in hostd&apos;s projects.yaml
            </Typography>
        </Box>
    )
}

export function ClientForm({ fromQuoteId, initial, clientId }: {
    fromQuoteId?: string
    initial?: { name: string, company: string | null, email: string }
    clientId?: string
}) {
    const { pending, error, failure, run } = useAction()
    const [name, setName] = useState(initial?.name ?? '')
    const [company, setCompany] = useState(initial?.company ?? '')
    const [email, setEmail] = useState(initial?.email ?? '')

    function submit() {
        const input = { name, company: company || null, email }
        // createClientAction redirects the browser on success, which the framework handles on its own; an
        // ok:false result here always means the email address is a duplicate or the email failed to send
        if (clientId) run(() => updateClientAction(clientId, input))
        else run(() => createClientAction(input, fromQuoteId))
    }

    return (
        <form onSubmit={event => { event.preventDefault(); submit() }}>
            <Stack sx={{ gap: 2, maxWidth: 420 }}>
                <TextField label="Name" value={name} onChange={event => setName(event.target.value)} required />
                <TextField label="Company" value={company} onChange={event => setCompany(event.target.value)} />
                <TextField label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} required />
                <Button type="submit" variant="contained" disabled={pending}>{clientId ? 'Save' : 'Create client'}</Button>
            </Stack>
            <Problem error={error} />
            {failure?.clientId && (
                <Alert severity="info" sx={{ mt: 1 }}>
                    <a href={`/admin/clients/${failure.clientId}`} style={{ color: 'inherit' }}>Open that client&apos;s page</a>
                    {fromQuoteId ? ' to link this quote to them instead.' : ' instead of creating a duplicate.'}
                </Alert>
            )}
        </form>
    )
}

export function ResendInviteButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button variant="outlined" disabled={pending} onClick={() => run(() => resendInviteAction(clientId))}>Resend invite</Button>
            <Problem error={error} />
        </div>
    )
}

export function SendResetButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button variant="outlined" disabled={pending} onClick={() => run(() => sendResetAction(clientId))}>Send password reset</Button>
            <Problem error={error} />
        </div>
    )
}

export function SuspendButton({ clientId, suspended }: { clientId: string, suspended: boolean }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button variant="outlined" color={suspended ? 'success' : 'warning'} disabled={pending}
                onClick={() => run(() => setSuspendedAction(clientId, !suspended))}>
                {suspended ? 'Unsuspend' : 'Suspend'}
            </Button>
            <Problem error={error} />
        </div>
    )
}

export function ClearLockButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button variant="outlined" disabled={pending} onClick={() => run(() => clearLockAction(clientId))}>Clear lock</Button>
            <Problem error={error} />
        </div>
    )
}

export function ResetTwoFactorButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Button variant="outlined" color="warning" disabled={pending} onClick={() => setConfirming(true)}>Reset 2FA</Button>
            <Problem error={error} />
            <Dialog open={confirming} onClose={() => setConfirming(false)}>
                <DialogTitle>Reset two-factor authentication?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This wipes the authenticator, every recovery code and every open session. The client will
                        need to set up a new authenticator app next time they sign in.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button color="warning" disabled={pending} onClick={() => run(() => resetTwoFactorAction(clientId), () => setConfirming(false))}>
                        Reset 2FA
                    </Button>
                </DialogActions>
            </Dialog>
        </div>
    )
}

export function DeleteClientButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Button variant="outlined" color="error" disabled={pending} onClick={() => setConfirming(true)}>Delete</Button>
            <Problem error={error} />
            <Dialog open={confirming} onClose={() => setConfirming(false)}>
                <DialogTitle>Delete this client?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This removes the client, their sites, sessions and recovery codes entirely. It can&apos;t be
                        undone from here.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button color="error" disabled={pending} onClick={() => run(() => deleteClientAction(clientId))}>Delete</Button>
                </DialogActions>
            </Dialog>
        </div>
    )
}

export function AddSiteForm({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [projectId, setProjectId] = useState('')
    const [name, setName] = useState('')
    const valid = siteSchema.safeParse({ projectId, name }).success

    return (
        <form onSubmit={event => { event.preventDefault(); run(() => addSiteAction(clientId, { projectId, name }), () => { setProjectId(''); setName('') }) }}>
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <TextField size="small" label="Project id" value={projectId} onChange={event => setProjectId(event.target.value)} />
                <TextField size="small" label="Site name" value={name} onChange={event => setName(event.target.value)} />
                <Button type="submit" variant="outlined" disabled={pending || !valid}>Add site</Button>
            </Stack>
            <Problem error={error} />
        </form>
    )
}

export function RemoveSiteButton({ clientId, siteId }: { clientId: string, siteId: string }) {
    const { pending, error, run } = useAction()
    return (
        <>
            <IconButton size="small" aria-label="Remove site" disabled={pending} onClick={() => run(() => removeSiteAction(clientId, siteId))}>
                <DeleteOutline fontSize="small" />
            </IconButton>
            <Problem error={error} />
        </>
    )
}
