'use client'

// The parts of the client pages that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it), same shape as the quote controls.

import { useState } from 'react'

import { siteSchema } from '@/server/clients/schema'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { ContentCopy, DeleteOutline } from '@/ui/icons'
import {
    addSiteAction, clearLockAction, createClientAction, deleteClientAction, removeSiteAction,
    resendInviteAction, resetTwoFactorAction, sendResetAction, setSuspendedAction, updateClientAction,
    type AdminResult,
} from './actions'
import styles from './controls.module.css'

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

// The error is the whole message, as it was in the Alert this replaces, so it goes in the title rather than
// being split into a heading and a body that nobody wrote. Callout's crit tone announces it either way.
const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

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
        <div>
            <div className={styles.idLine}>
                <span className={styles.id}>{id}</span>
                <Button variant="quiet" size="small" aria-label="Copy client id" onClick={copy}>
                    <ContentCopy size={15} />
                </Button>
                {copied && <span className={styles.copied}>Copied</span>}
            </div>
            <p className={styles.note}>
                Use this as <code>client:</code> in hostd&apos;s projects.yaml
            </p>
        </div>
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
            <div className={styles.fields}>
                <Field label="Name" value={name} onChange={event => setName(event.target.value)} required />
                <Field label="Company" value={company} onChange={event => setCompany(event.target.value)} />
                <Field label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} required />
                <div>
                    <Button type="submit" variant="primary" disabled={pending}>{clientId ? 'Save' : 'Create client'}</Button>
                </div>
            </div>
            <Problem error={error} />
            {failure?.clientId && (
                <div className={styles.problem}>
                    {/* Callout's title is a string and this one is a sentence with a link in it, so the
                        sentence stays in the body word for word and the title names what it is about. */}
                    <Callout title="That client already exists">
                        <a href={`/admin/clients/${failure.clientId}`} className={styles.link}>Open that client&apos;s page</a>
                        {fromQuoteId ? ' to link this quote to them instead.' : ' instead of creating a duplicate.'}
                    </Callout>
                </div>
            )}
        </form>
    )
}

export function ResendInviteButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button disabled={pending} onClick={() => run(() => resendInviteAction(clientId))}>Resend invite</Button>
            <Problem error={error} />
        </div>
    )
}

export function SendResetButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button disabled={pending} onClick={() => run(() => sendResetAction(clientId))}>Send password reset</Button>
            <Problem error={error} />
        </div>
    )
}

export function SuspendButton({ clientId, suspended }: { clientId: string, suspended: boolean }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <Button className={suspended ? styles.good : styles.warn} disabled={pending}
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
            <Button disabled={pending} onClick={() => run(() => clearLockAction(clientId))}>Clear lock</Button>
            <Problem error={error} />
        </div>
    )
}

export function ResetTwoFactorButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Button className={styles.warn} disabled={pending} onClick={() => setConfirming(true)}>Reset 2FA</Button>
            <Problem error={error} />
            <Dialog
                open={confirming}
                onClose={() => setConfirming(false)}
                title="Reset two-factor authentication?"
                footer={
                    <>
                        <Button onClick={() => setConfirming(false)}>Cancel</Button>
                        <Button className={styles.warn} disabled={pending} onClick={() => run(() => resetTwoFactorAction(clientId), () => setConfirming(false))}>
                            Reset 2FA
                        </Button>
                    </>
                }
            >
                <p className={styles.dialogText}>
                    This wipes the authenticator, every recovery code and every open session. The client will
                    need to set up a new authenticator app next time they sign in.
                </p>
            </Dialog>
        </div>
    )
}

export function DeleteClientButton({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Button className={styles.crit} disabled={pending} onClick={() => setConfirming(true)}>Delete</Button>
            <Problem error={error} />
            <Dialog
                open={confirming}
                onClose={() => setConfirming(false)}
                title="Delete this client?"
                footer={
                    <>
                        <Button onClick={() => setConfirming(false)}>Cancel</Button>
                        <Button className={styles.crit} disabled={pending} onClick={() => run(() => deleteClientAction(clientId))}>Delete</Button>
                    </>
                }
            >
                <p className={styles.dialogText}>
                    This removes the client, their sites, sessions and recovery codes entirely. It can&apos;t be
                    undone from here.
                </p>
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
            <div className={styles.addSite}>
                <Field label="Project id" value={projectId} onChange={event => setProjectId(event.target.value)} />
                <Field label="Site name" value={name} onChange={event => setName(event.target.value)} />
                <Button type="submit" className={styles.addSiteButton} disabled={pending || !valid}>Add site</Button>
            </div>
            <Problem error={error} />
        </form>
    )
}

export function RemoveSiteButton({ clientId, siteId }: { clientId: string, siteId: string }) {
    const { pending, error, run } = useAction()
    return (
        <>
            <Button variant="quiet" size="small" aria-label="Remove site" disabled={pending} onClick={() => run(() => removeSiteAction(clientId, siteId))}>
                <DeleteOutline size={15} />
            </Button>
            <Problem error={error} />
        </>
    )
}
