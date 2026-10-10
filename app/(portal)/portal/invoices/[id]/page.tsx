import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { businessDetails } from '@/server/invoices/business'
import { formatMoney } from '@/server/invoices/money'
import { invoiceNumber, STANDING_LABELS, STANDING_TONES, standingOf } from '@/server/invoices/standing'
import { todayIn } from '@/server/invoices/days'
import { invoices } from '@/server/invoices/wiring'
import { Chip } from '@/ui/Chip/Chip'
import { formatWhen } from '../../format'
import frame from '../../frame.module.css'
import PortalHeader from '../../header'
import { DraftControls, EditDraft, OpenControls, ResendButton } from '../controls'
import { InvoiceDocument } from '../document'
import styles from '../invoices.module.css'

export const metadata: Metadata = { title: 'Invoice' }

const METHODS = { PAYPAL: 'PayPal', PAYPAL_AUTOPAY: 'PayPal, automatic', MANUAL: 'Marked paid' } as const

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const invoice = await invoices().get(id)
    if (!invoice) notFound()

    const today = todayIn(new Date())
    const standing = standingOf(invoice, today)
    const business = businessDetails()
    const clients = invoice.status === 'DRAFT'
        ? (await repo().list()).map(one => ({ id: one.id, name: one.name, company: one.company }))
        : []

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={[frame.head, frame.headCentred].join(' ')}>
                    <h1 className={frame.title}>{invoice.number === null ? 'Draft invoice' : invoiceNumber(invoice.number)}</h1>
                    <Chip tone={STANDING_TONES[standing]}>{STANDING_LABELS[standing]}</Chip>
                </div>
                <p className={[frame.sub, frame.subBlock].join(' ')}>
                    {formatMoney(invoice.totalCents, invoice.currency)} for{' '}
                    {invoice.client ? <Link href={`/portal/clients/${invoice.client.id}`} className={frame.link}>{invoice.billToName}</Link> : invoice.billToName}
                    {invoice.plan && <> from the plan {invoice.plan.description}</>}
                </p>

                <section className={frame.panel}>
                    <div className={frame.controls}>
                        {invoice.status === 'DRAFT' && (
                            <>
                                <EditDraft
                                    clients={clients}
                                    gst={business.gst}
                                    invoiceId={invoice.id}
                                    initial={{ clientId: invoice.clientId ?? '', dueOn: invoice.dueOn, notes: invoice.notes, lines: invoice.lines }}
                                />
                                <DraftControls invoiceId={invoice.id} clientEmail={invoice.client?.email ?? null} total={formatMoney(invoice.totalCents)} />
                            </>
                        )}
                        {invoice.status === 'OPEN' && <OpenControls invoiceId={invoice.id} overdue={standing === 'overdue'} />}
                        {(invoice.status === 'PAID' || invoice.status === 'VOID') && <ResendButton invoiceId={invoice.id} />}
                        <a href={`/api/invoices/${invoice.id}/pdf`} className={frame.action}>Download PDF</a>
                    </div>
                    {invoice.status !== 'DRAFT' && (
                        <>
                            <hr className={frame.rule} />
                            <div className={styles.payments}>
                                <p className={styles.payment}>
                                    Sent {invoice.sentAt ? formatWhen(invoice.sentAt) : 'never'} to {invoice.billToEmail}
                                    {invoice.reminderSentAt && `, reminded ${formatWhen(invoice.reminderSentAt)}`}
                                    {invoice.overdueNotices > 0 && `, ${invoice.overdueNotices} overdue notice${invoice.overdueNotices === 1 ? '' : 's'}`}
                                    {invoice.voidedAt && `, voided ${formatWhen(invoice.voidedAt)}`}
                                </p>
                                {invoice.payments.map(payment => (
                                    <p key={payment.id} className={styles.payment}>
                                        {formatMoney(payment.amountCents, invoice.currency)} {formatWhen(payment.createdAt)} by {METHODS[payment.method]}
                                        {payment.paypalMode === 'sandbox' && ' (sandbox, not real money)'}
                                        {payment.paypalId && <span className={frame.mono}> {payment.paypalId}</span>}
                                        {payment.note && `: ${payment.note}`}
                                        {payment.refundedAt && `, refunded ${formatWhen(payment.refundedAt)}`}
                                    </p>
                                ))}
                            </div>
                        </>
                    )}
                </section>

                <InvoiceDocument invoice={invoice} business={business} today={today} />
            </div>
        </>
    )
}
