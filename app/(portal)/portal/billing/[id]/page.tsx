import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { requireClient } from '@/server/clients/auth'
import { paidCentsOf } from '@/server/invoices/billing'
import { businessDetails } from '@/server/invoices/business'
import { todayIn } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { autopayActive } from '@/server/invoices/plans'
import { invoiceNumber, standingOf } from '@/server/invoices/standing'
import { billingViewer } from '@/server/invoices/viewer'
import { invoices, paypal, paypalMode } from '@/server/invoices/wiring'
import { Callout } from '@/ui/Callout/Callout'
import frame from '../../frame.module.css'
import PortalHeader from '../../header'
import { InvoiceDocument } from '../../invoices/document'
import styles from '../../invoices/invoices.module.css'
import { PayButton } from '../controls'

export const metadata: Metadata = { title: 'Invoice' }

// What PayPal's return said, in words. Whatever the address bar claims, the invoice below shows what is true.
const NOTES: Record<string, { tone: 'good' | 'warn' | 'crit', title: string, body: string }> = {
    paid: { tone: 'good', title: 'Payment received, thank you', body: 'A receipt is on its way to your email.' },
    pending: { tone: 'warn', title: 'PayPal is still processing your payment', body: 'This invoice will show as paid once PayPal confirms it, and you will get a receipt by email.' },
    failed: { tone: 'crit', title: 'PayPal did not take that payment', body: 'Nothing was charged. Please try again, perhaps with a different card or account.' },
    cancelled: { tone: 'warn', title: 'Payment cancelled', body: 'Nothing was charged. The invoice is still waiting whenever you are ready.' },
}

export default async function ClientInvoicePage({ params, searchParams }: {
    params: Promise<{ id: string }>, searchParams: Promise<{ payment?: string }>
}) {
    const viewer = await billingViewer()
    const { id } = await params
    if (viewer === 'admin') redirect(`/portal/invoices/${id}`)
    if (!viewer) {
        await requireClient()
        redirect('/portal/sign-in')
    }
    const invoice = await invoices().get(id)
    // Somebody else's invoice, or a draft, is simply not there
    if (!invoice || invoice.clientId !== viewer.clientId || invoice.status === 'DRAFT') notFound()

    const { payment } = await searchParams
    const today = todayIn(new Date())
    const standing = standingOf(invoice, today)
    const owing = invoice.totalCents - paidCentsOf(invoice)
    const note = payment ? NOTES[payment] : undefined
    const online = !!paypal()
    const automatic = invoice.plan ? autopayActive(invoice.plan, paypalMode()) : false

    return (
        <>
            <PortalHeader admin={false} name={viewer.name} viewingAs={viewer.viewingAs ? viewer.name : undefined} />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Invoice {invoiceNumber(invoice.number)}</h1>
                    <Link href="/portal/billing" className={frame.link}>All invoices</Link>
                </div>

                {note && <div className={styles.strip}><Callout tone={note.tone} title={note.title}>{note.body}</Callout></div>}

                <section className={frame.panel}>
                    <div className={frame.controls}>
                        {(standing === 'due' || standing === 'overdue') && online && owing > 0 && !automatic && (
                            <PayButton invoiceId={invoice.id} amount={formatMoney(owing, invoice.currency)} disabled={viewer.viewingAs} />
                        )}
                        <a href={`/api/invoices/${invoice.id}/pdf`} className={frame.action}>Download PDF</a>
                    </div>
                    {(standing === 'due' || standing === 'overdue') && (
                        <p className={styles.inlineNote}>
                            {automatic
                                ? 'This plan pays automatically, so PayPal will settle this invoice for you.'
                                : online
                                    ? 'Pay with your PayPal account, or with a debit or credit card through PayPal without an account.'
                                    : 'Online payment is not available right now. Reply to the invoice email and I will help.'}
                            {invoice.plan && !automatic && online && ' This plan can also pay itself each time, from the Billing page.'}
                        </p>
                    )}
                    {viewer.viewingAs && <p className={styles.inlineNote}>You are viewing as {viewer.name}, so paying is switched off.</p>}
                </section>

                <InvoiceDocument invoice={invoice} business={businessDetails()} today={today} />
            </div>
        </>
    )
}
