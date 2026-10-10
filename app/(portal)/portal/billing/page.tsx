import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { requireClient } from '@/server/clients/auth'
import { businessDetails } from '@/server/invoices/business'
import { formatDayShort, todayIn } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { autopayActive, INTERVAL_LABELS, nextBillingDay } from '@/server/invoices/plans'
import { planTotalCents } from '@/server/invoices/billing'
import { invoiceNumber, STANDING_LABELS, STANDING_TONES, standingOf } from '@/server/invoices/standing'
import { billingViewer } from '@/server/invoices/viewer'
import { invoices, paypal, paypalMode, plans } from '@/server/invoices/wiring'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import frame from '../frame.module.css'
import PortalHeader from '../header'
import styles from '../invoices/invoices.module.css'
import { AutopayButton, StopAutopayButton } from './controls'

export const metadata: Metadata = { title: 'Billing' }

const NOTES: Record<string, { tone: 'good' | 'warn' | 'crit', title: string, body: string }> = {
    on: { tone: 'good', title: 'Automatic payment is set up', body: 'PayPal will take each payment when it is due, and you will get a receipt by email each time.' },
    cancelled: { tone: 'warn', title: 'Automatic payment was not set up', body: 'Nothing was changed. Your invoices will keep arriving by email.' },
    failed: { tone: 'crit', title: 'PayPal did not confirm the automatic payment', body: 'Nothing was taken. Please try again, or reply to an invoice email and I will help.' },
}

// The client's invoices and plans. Drafts never show here: an invoice is the client's once it is sent.
const PAYMENT_PENDING = {
    tone: 'warn' as const, title: 'PayPal is still processing your payment',
    body: 'The invoice will show as paid once PayPal confirms it, and you will get a receipt by email.',
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ autopay?: string, payment?: string }> }) {
    const viewer = await billingViewer()
    if (viewer === 'admin') redirect('/portal/invoices')
    if (!viewer) {
        await requireClient()
        redirect('/portal/sign-in')
    }
    const { autopay, payment } = await searchParams
    const note = autopay ? NOTES[autopay] : payment === 'pending' ? PAYMENT_PENDING : undefined

    const today = todayIn(new Date())
    const mode = paypalMode()
    const online = !!paypal()
    const gst = businessDetails().gst
    const [list, planList] = await Promise.all([
        invoices().list({ standing: null, clientId: viewer.clientId, visibleToClient: true }, today),
        plans().list({ clientId: viewer.clientId }),
    ])

    const open = list.filter(invoice => invoice.status === 'OPEN')
    const owing = open.reduce((sum, invoice) => sum + invoice.totalCents, 0)
    const late = open.filter(invoice => standingOf(invoice, today) === 'overdue')

    const columns = [
        { key: 'number', head: 'Invoice' },
        { key: 'issued', head: 'Issued', numeric: true },
        { key: 'due', head: 'Due', numeric: true },
        { key: 'total', head: 'Total', numeric: true },
        { key: 'status', head: 'Status' },
    ]
    const rows = list.map(invoice => {
        const standing = standingOf(invoice, today)
        return {
            number: <Link href={`/portal/billing/${invoice.id}`} className={frame.plainLink}>{invoiceNumber(invoice.number)}</Link>,
            issued: invoice.issuedOn ? formatDayShort(invoice.issuedOn) : '',
            due: formatDayShort(invoice.dueOn),
            total: formatMoney(invoice.totalCents, invoice.currency),
            status: <Chip tone={STANDING_TONES[standing]}>{STANDING_LABELS[standing]}</Chip>,
        }
    })

    return (
        <>
            <PortalHeader admin={false} name={viewer.name} viewingAs={viewer.viewingAs ? viewer.name : undefined} />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Billing</h1>
                </div>

                {note && <div className={styles.strip}><Callout tone={note.tone} title={note.title}>{note.body}</Callout></div>}

                <div className={styles.strip}>
                    <StatStrip stats={[
                        { key: 'To pay', value: formatMoney(owing), note: `${open.length} invoice${open.length === 1 ? '' : 's'}` },
                        ...(late.length ? [{ key: 'Overdue', value: String(late.length), tone: 'crit' as const }] : []),
                    ]} />
                </div>

                {planList.length > 0 && (
                    <section className={frame.panel}>
                        <h2 className={frame.section}>Plans</h2>
                        <div className={styles.plans}>
                            {planList.map(plan => {
                                const automatic = autopayActive(plan, mode)
                                const price = formatMoney(planTotalCents(plan, gst))
                                return (
                                    <div key={plan.id} className={styles.plan}>
                                        <div>
                                            <p className={styles.planName}>{plan.description}{plan.site ? ` for ${plan.site.name}` : ''}</p>
                                            <p className={styles.planMeta}>
                                                {plan.amountCents === 0
                                                    ? 'Included at no charge.'
                                                    : `${price} a ${INTERVAL_LABELS[plan.interval]}${gst ? ' including GST' : ''}. `
                                                        + (automatic ? 'Paid automatically with PayPal.' : `Next invoice ${formatDayShort(nextBillingDay(plan))}.`)}
                                                {plan.subscriptionStatus === 'SUSPENDED' && ' PayPal could not take the last automatic payment, so it is invoiced instead.'}
                                            </p>
                                        </div>
                                        {plan.amountCents > 0 && online && (automatic
                                            ? <StopAutopayButton planId={plan.id} disabled={viewer.viewingAs} />
                                            : <AutopayButton planId={plan.id} price={price} disabled={viewer.viewingAs} />)}
                                    </div>
                                )
                            })}
                        </div>
                    </section>
                )}

                <section className={frame.panel}>
                    <h2 className={frame.section}>Invoices</h2>
                    <DataTable label="Invoices" columns={columns} rows={rows} empty="No invoices yet." />
                </section>
            </div>
        </>
    )
}
