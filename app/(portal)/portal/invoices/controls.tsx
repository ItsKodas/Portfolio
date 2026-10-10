'use client'

// The parts of the invoice pages that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it), the same shape as the client controls.

import { useState } from 'react'

import { totalsOf, formatMoney, lineAmount, parseDollars, dollarsText } from '@/server/invoices/money'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { DeleteOutline } from '@/ui/icons'
import {
    chaseInvoiceAction, createInvoiceAction, createPlanAction, deleteDraftAction, endPlanAction, markPaidAction, resendInvoiceAction,
    sendInvoiceAction, stopAutopayAction, updateInvoiceAction, updatePlanAction, voidInvoiceAction, type InvoiceResult,
} from './actions'
import styles from './invoices.module.css'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    async function run(action: () => Promise<InvoiceResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        setNotice(null)
        try {
            const result = await action()
            if (result.ok) {
                setNotice(result.notice ?? null)
                onDone?.()
            } else setError(result.error)
        } catch (thrown) {
            // A redirect() inside the action arrives here as a thrown digest, and the framework follows it on its own
            if ((thrown as { digest?: string })?.digest?.startsWith('NEXT_REDIRECT')) throw thrown
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, notice, run }
}

const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

const Notice = ({ notice }: { notice: string | null }) => (
    notice ? <div className={styles.problem}><Callout tone="good" title={notice}>{null}</Callout></div> : null
)

type LineDraft = { description: string, quantity: string, price: string }

const emptyLine = (): LineDraft => ({ description: '', quantity: '1', price: '' })

export type ClientOption = { id: string, name: string, company: string | null }

export function InvoiceForm({ clients, gst, invoiceId, initial, onSaved }: {
    clients: ClientOption[]
    gst: boolean
    invoiceId?: string
    initial: { clientId: string, dueOn: string, notes: string | null, lines: { description: string, quantity: number, unitCents: number }[] }
    onSaved?: () => void
}) {
    const { pending, error, run } = useAction()
    const [clientId, setClientId] = useState(initial.clientId)
    const [dueOn, setDueOn] = useState(initial.dueOn)
    const [notes, setNotes] = useState(initial.notes ?? '')
    const [lines, setLines] = useState<LineDraft[]>(initial.lines.length
        ? initial.lines.map(line => ({ description: line.description, quantity: String(line.quantity), price: dollarsText(line.unitCents) }))
        : [emptyLine()])

    const change = (index: number, patch: Partial<LineDraft>) =>
        setLines(current => current.map((line, at) => (at === index ? { ...line, ...patch } : line)))

    // The running total, from whatever lines read as numbers so far. The server adds them up again for real.
    const readable = lines.map(line => ({ quantity: Number(line.quantity), unitCents: parseDollars(line.price) ?? 0 }))
        .map(line => (Number.isFinite(line.quantity) && line.quantity > 0 ? line : { quantity: 0, unitCents: 0 }))
    const totals = totalsOf(readable, gst)

    function submit() {
        const input = {
            clientId, dueOn, notes,
            lines: lines.map(line => ({ description: line.description, quantity: line.quantity, unitCents: line.price })),
        }
        if (invoiceId) run(() => updateInvoiceAction(invoiceId, input), onSaved)
        else run(() => createInvoiceAction(input))
    }

    return (
        <form onSubmit={event => { event.preventDefault(); submit() }} className={styles.editor}>
            <div className={styles.formRow}>
                <Field as="select" label="Client" value={clientId} onChange={event => setClientId(event.target.value)} required>
                    <option value="">Choose a client</option>
                    {clients.map(client => (
                        <option key={client.id} value={client.id}>{client.company ? `${client.name} (${client.company})` : client.name}</option>
                    ))}
                </Field>
                <Field label="Due" type="date" value={dueOn} onChange={event => setDueOn(event.target.value)} required />
            </div>

            {lines.map((line, index) => (
                <div key={index} className={styles.lineRow}>
                    <Field label={index === 0 ? 'Description' : `Line ${index + 1}`} value={line.description}
                        onChange={event => change(index, { description: event.target.value })} required />
                    <Field label="Qty" inputMode="decimal" value={line.quantity} onChange={event => change(index, { quantity: event.target.value })} required />
                    <Field label="Unit price ($)" inputMode="decimal" placeholder="0.00" value={line.price}
                        onChange={event => change(index, { price: event.target.value })} required />
                    <span className={styles.lineAmount}>{formatMoney(lineAmount(readable[index]))}</span>
                    <Button variant="quiet" size="small" aria-label={`Remove line ${index + 1}`} disabled={lines.length === 1}
                        onClick={() => setLines(current => current.filter((_, at) => at !== index))}>
                        <DeleteOutline size={16} />
                    </Button>
                </div>
            ))}
            <div>
                <Button size="small" onClick={() => setLines(current => [...current, emptyLine()])}>Add a line</Button>
            </div>

            <Field as="textarea" label="Notes" hint="Shown on the invoice, such as what the work covered or other ways to pay." rows={3}
                value={notes} onChange={event => setNotes(event.target.value)} />

            <p className={styles.formTotals}>
                {gst && <>Subtotal {formatMoney(totals.subtotalCents)}, GST {formatMoney(totals.gstCents)}. </>}
                Total <strong>{formatMoney(totals.totalCents)} AUD</strong>
            </p>

            <div>
                <Button type="submit" variant="primary" disabled={pending}>{invoiceId ? 'Save draft' : 'Save as draft'}</Button>
            </div>
            <Problem error={error} />
        </form>
    )
}

// The draft's own form behind a button, so the invoice reads as an invoice until it is being changed
export function EditDraft(props: Omit<Parameters<typeof InvoiceForm>[0], 'onSaved'>) {
    const [editing, setEditing] = useState(false)
    if (!editing) return <Button onClick={() => setEditing(true)}>Edit draft</Button>
    return (
        <section className={styles.document}>
            <InvoiceForm {...props} onSaved={() => setEditing(false)} />
            <div className={styles.problem}><Button variant="quiet" onClick={() => setEditing(false)}>Cancel</Button></div>
        </section>
    )
}

function Confirm({ label, title, text, confirm, tone, action, children }: {
    label: string, title: string, text: string, confirm: string, tone?: 'warn' | 'crit'
    action: (extra: string) => Promise<InvoiceResult>, children?: (value: string, set: (value: string) => void) => React.ReactNode
}) {
    const { pending, error, notice, run } = useAction()
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState('')
    const toneClass = tone ? styles[tone] : undefined
    return (
        <div>
            <Button className={toneClass} disabled={pending} onClick={() => setOpen(true)}>{label}</Button>
            <Problem error={error} />
            <Notice notice={notice} />
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title={title}
                footer={
                    <>
                        <Button onClick={() => setOpen(false)}>Cancel</Button>
                        <Button className={toneClass} variant={tone ? undefined : 'primary'} disabled={pending}
                            onClick={() => run(() => action(value), () => setOpen(false))}>
                            {confirm}
                        </Button>
                    </>
                }
            >
                <p className={styles.dialogText}>{text}</p>
                {children?.(value, setValue)}
            </Dialog>
        </div>
    )
}

function Plain({ label, action, primary }: { label: string, action: () => Promise<InvoiceResult>, primary?: boolean }) {
    const { pending, error, notice, run } = useAction()
    return (
        <div>
            <Button variant={primary ? 'primary' : undefined} disabled={pending} onClick={() => run(action)}>{label}</Button>
            <Problem error={error} />
            <Notice notice={notice} />
        </div>
    )
}

export function DraftControls({ invoiceId, clientEmail, total }: { invoiceId: string, clientEmail: string | null, total: string }) {
    return (
        <>
            <Confirm
                label="Send"
                title="Send this invoice?"
                text={clientEmail
                    ? `It gets the next invoice number and is emailed to ${clientEmail} with the PDF attached, for ${total}. Once sent it can't be edited, only voided.`
                    : 'It gets the next invoice number and is emailed to the client with the PDF attached. Once sent it can\'t be edited, only voided.'}
                confirm="Send invoice"
                action={() => sendInvoiceAction(invoiceId)}
            />
            <Confirm
                label="Delete draft"
                title="Delete this draft?"
                text="The draft is removed for good. It was never sent, so the client never saw it."
                confirm="Delete"
                tone="crit"
                action={() => deleteDraftAction(invoiceId)}
            />
        </>
    )
}

export function OpenControls({ invoiceId, overdue }: { invoiceId: string, overdue: boolean }) {
    return (
        <>
            <Confirm
                label="Mark paid"
                title="Mark this invoice paid?"
                text="For a payment that came some other way, such as a bank transfer. The client is not emailed."
                confirm="Mark paid"
                action={note => markPaidAction(invoiceId, note)}
            >
                {(value, set) => <Field label="Note" hint="Optional, such as the transfer's reference." value={value} onChange={event => set(event.target.value)} />}
            </Confirm>
            <Plain label={overdue ? 'Send overdue notice' : 'Send reminder'} action={() => chaseInvoiceAction(invoiceId)} />
            <Plain label="Email again" action={() => resendInvoiceAction(invoiceId)} />
            <Confirm
                label="Void"
                title="Void this invoice?"
                text="It stays on record with its number, marked void, and can no longer be paid. To charge differently, write a new invoice."
                confirm="Void invoice"
                tone="crit"
                action={() => voidInvoiceAction(invoiceId)}
            />
        </>
    )
}

export function ResendButton({ invoiceId }: { invoiceId: string }) {
    return <Plain label="Email again" action={() => resendInvoiceAction(invoiceId)} />
}

// Plans

export type SiteOption = { id: string, projectId: string, name: string }

export function PlanForm({ clientId, planId, sites, initial, onSaved, billed }: {
    clientId: string
    planId?: string
    sites: SiteOption[]
    billed?: boolean
    initial: { description: string, amountCents: number | null, interval: 'MONTHLY' | 'YEARLY', startsOn: string, dueDays: number, siteId: string | null }
    onSaved?: () => void
}) {
    const { pending, error, notice, run } = useAction()
    const [description, setDescription] = useState(initial.description)
    const [price, setPrice] = useState(initial.amountCents === null ? '' : dollarsText(initial.amountCents))
    const [interval, setPlanInterval] = useState(initial.interval)
    const [startsOn, setStartsOn] = useState(initial.startsOn)
    const [dueDays, setDueDays] = useState(String(initial.dueDays))
    const [siteId, setSiteId] = useState(initial.siteId ?? '')

    function submit() {
        const input = { description, amountCents: price, interval, startsOn, dueDays, siteId }
        if (planId) run(() => updatePlanAction(planId, input), onSaved)
        else run(() => createPlanAction(clientId, input), () => { setDescription(''); setPrice('') })
    }

    return (
        <form onSubmit={event => { event.preventDefault(); submit() }} className={styles.editor}>
            <div className={styles.formRow}>
                <Field label="Description" placeholder="Website hosting" value={description} onChange={event => setDescription(event.target.value)} required />
                <Field label="Price ($)" inputMode="decimal" hint="Before any GST. 0 for a plan you don't charge for." placeholder="0.00"
                    value={price} onChange={event => setPrice(event.target.value)} required />
            </div>
            <div className={styles.formRow}>
                <Field as="select" label="Every" value={interval} onChange={event => setPlanInterval(event.target.value as 'MONTHLY' | 'YEARLY')}>
                    <option value="MONTHLY">Month</option>
                    <option value="YEARLY">Year</option>
                </Field>
                <Field label="First period starts" type="date" value={startsOn} onChange={event => setStartsOn(event.target.value)} required
                    disabled={billed} hint={billed ? 'Fixed, since periods have been billed from it.' : 'Each invoice goes out on this day of the month.'} />
                <Field label="Days to pay" inputMode="numeric" value={dueDays} onChange={event => setDueDays(event.target.value)} required />
                <Field as="select" label="Site" value={siteId} onChange={event => setSiteId(event.target.value)}>
                    <option value="">None</option>
                    {sites.map(site => <option key={site.id} value={site.id}>{site.name} ({site.projectId})</option>)}
                </Field>
            </div>
            <div>
                <Button type="submit" variant="primary" disabled={pending}>{planId ? 'Save plan' : 'Add plan'}</Button>
            </div>
            <Problem error={error} />
            <Notice notice={notice} />
        </form>
    )
}

export function EditPlan(props: Omit<Parameters<typeof PlanForm>[0], 'onSaved'>) {
    const [editing, setEditing] = useState(false)
    if (!editing) return <Button size="small" onClick={() => setEditing(true)}>Edit</Button>
    return (
        <div className={styles.document}>
            <PlanForm {...props} onSaved={() => setEditing(false)} />
            <div className={styles.problem}><Button variant="quiet" onClick={() => setEditing(false)}>Cancel</Button></div>
        </div>
    )
}

export function EndPlanButton({ planId, autopay }: { planId: string, autopay: boolean }) {
    return (
        <Confirm
            label="End plan"
            title="End this plan?"
            text={autopay
                ? 'No more invoices are raised for it, and its automatic PayPal payment is cancelled. Invoices already sent stay as they are.'
                : 'No more invoices are raised for it. Invoices already sent stay as they are.'}
            confirm="End plan"
            tone="crit"
            action={() => endPlanAction(planId)}
        />
    )
}

export function StopAutopayButton({ planId }: { planId: string }) {
    return (
        <Confirm
            label="Stop automatic payment"
            title="Stop automatic payment?"
            text="The PayPal subscription is cancelled, and from the next period the plan raises an invoice for the client to pay instead."
            confirm="Stop it"
            tone="warn"
            action={() => stopAutopayAction(planId)}
        />
    )
}
