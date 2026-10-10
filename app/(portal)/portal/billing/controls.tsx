'use client'

// The client's buttons. Paying sends the browser to PayPal, which sends it back to the invoice when it is done.

import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { payInvoiceAction, startAutopayAction, stopAutopayAction, type PayResult } from './actions'
import styles from '../invoices/invoices.module.css'

function useGo() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function go(action: () => Promise<PayResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (!result.ok) {
                setError(result.error)
                setPending(false)
            } else if (result.url) {
                // Left pending: the page is on its way to PayPal
                window.location.assign(result.url)
            } else {
                setPending(false)
                onDone?.()
            }
        } catch {
            setError('That did not work. Try reloading the page.')
            setPending(false)
        }
    }
    return { pending, error, go }
}

const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

export function PayButton({ invoiceId, amount, disabled }: { invoiceId: string, amount: string, disabled?: boolean }) {
    const { pending, error, go } = useGo()
    return (
        <div>
            <Button variant="primary" disabled={pending || disabled} onClick={() => go(() => payInvoiceAction(invoiceId))}>
                {pending ? 'Opening PayPal...' : `Pay ${amount} with PayPal or card`}
            </Button>
            <Problem error={error} />
        </div>
    )
}

export function AutopayButton({ planId, price, disabled }: { planId: string, price: string, disabled?: boolean }) {
    const { pending, error, go } = useGo()
    const [open, setOpen] = useState(false)
    return (
        <div>
            <Button disabled={pending || disabled} onClick={() => setOpen(true)}>Pay automatically</Button>
            <Problem error={error} />
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title="Pay this plan automatically?"
                footer={
                    <>
                        <Button onClick={() => setOpen(false)}>Cancel</Button>
                        <Button variant="primary" disabled={pending} onClick={() => go(() => startAutopayAction(planId))}>
                            {pending ? 'Opening PayPal...' : 'Continue to PayPal'}
                        </Button>
                    </>
                }
            >
                <p className={styles.dialogText}>
                    PayPal takes {price} now, which settles any invoice from this plan that is waiting, and again each period after
                    that. You get a receipt each time, and you can stop it here or in your PayPal account whenever you like.
                </p>
            </Dialog>
        </div>
    )
}

export function StopAutopayButton({ planId, disabled }: { planId: string, disabled?: boolean }) {
    const { pending, error, go } = useGo()
    const [open, setOpen] = useState(false)
    return (
        <div>
            <Button disabled={pending || disabled} onClick={() => setOpen(true)}>Stop automatic payment</Button>
            <Problem error={error} />
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title="Stop paying automatically?"
                footer={
                    <>
                        <Button onClick={() => setOpen(false)}>Keep it</Button>
                        <Button variant="primary" disabled={pending} onClick={() => go(() => stopAutopayAction(planId), () => setOpen(false))}>Stop it</Button>
                    </>
                }
            >
                <p className={styles.dialogText}>
                    PayPal stops taking payments for this plan. From the next period you get an invoice by email to pay instead.
                </p>
            </Dialog>
        </div>
    )
}
