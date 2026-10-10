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

// Two ways through PayPal: a card on PayPal's own page, which needs no PayPal account, or signing in to PayPal
export function PayButton({ invoiceId, amount, disabled }: { invoiceId: string, amount: string, disabled?: boolean }) {
    const { pending, error, go } = useGo()
    const [chosen, setChosen] = useState<'card' | 'paypal' | null>(null)
    const pay = (how: 'card' | 'paypal') => {
        setChosen(how)
        go(() => payInvoiceAction(invoiceId, how))
    }
    return (
        <div>
            <div className={styles.payChoices}>
                <Button variant="primary" disabled={pending || disabled} onClick={() => pay('card')}>
                    {pending && chosen === 'card' ? 'Opening the card form...' : `Pay ${amount} by card`}
                </Button>
                <Button disabled={pending || disabled} onClick={() => pay('paypal')}>
                    {pending && chosen === 'paypal' ? 'Opening PayPal...' : 'Pay with PayPal'}
                </Button>
            </div>
            <Problem error={error} />
        </div>
    )
}

export function AutopayButton({ planId, price, disabled }: { planId: string, price: string, disabled?: boolean }) {
    const { pending, error, go } = useGo()
    const [open, setOpen] = useState(false)
    const [chosen, setChosen] = useState<'card' | 'paypal' | null>(null)
    const start = (how: 'card' | 'paypal') => {
        setChosen(how)
        go(() => startAutopayAction(planId, how))
    }
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
                        <Button disabled={pending} onClick={() => start('paypal')}>
                            {pending && chosen === 'paypal' ? 'Opening PayPal...' : 'Use PayPal'}
                        </Button>
                        <Button variant="primary" disabled={pending} onClick={() => start('card')}>
                            {pending && chosen === 'card' ? 'Opening the card form...' : 'Use a card'}
                        </Button>
                    </>
                }
            >
                <p className={styles.dialogText}>
                    PayPal takes {price} now, which settles any invoice from this plan that is waiting, and again each period after
                    that. You get a receipt each time, and you can stop it here whenever you like.
                </p>
                <p className={styles.dialogText}>
                    With a card, PayPal holds it to charge each period, and may ask you to save it to a free PayPal account.
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
