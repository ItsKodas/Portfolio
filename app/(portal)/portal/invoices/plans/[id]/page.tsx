import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/server/auth'
import { formatDay, formatDayShort, todayIn } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { autopayActive, INTERVAL_LABELS, nextBillingDay, periodOf } from '@/server/invoices/plans'
import { invoiceNumber, STANDING_LABELS, STANDING_TONES, standingOf } from '@/server/invoices/standing'
import { invoices, paypalMode, plans } from '@/server/invoices/wiring'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { formatWhen } from '../../../format'
import frame from '../../../frame.module.css'
import PortalHeader from '../../../header'
import { EditPlan, EndPlanButton, StopAutopayButton } from '../../controls'
import styles from '../../invoices.module.css'

export const metadata: Metadata = { title: 'Plan' }

// One recurring charge: what it bills, when it next does, how it is paid, and every invoice it has raised
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const plan = await plans().get(id)
    if (!plan) notFound()

    const today = todayIn(new Date())
    const mode = paypalMode()
    const automatic = autopayActive(plan, mode)
    const free = plan.amountCents === 0
    const [raised, sites] = await Promise.all([invoices().list({ standing: null, planId: plan.id }, today), plans().sites()])

    const state = plan.endedAt ? { label: 'Ended', tone: undefined }
        : free ? { label: 'Not charged', tone: undefined }
            : automatic ? { label: 'Paying automatically', tone: 'good' as const }
                : plan.subscriptionStatus === 'SUSPENDED' ? { label: 'Automatic payment failing', tone: 'crit' as const }
                    : { label: 'Invoiced', tone: undefined }

    const next = nextBillingDay(plan)
    const period = periodOf(plan, plan.periodsBilled)
    const facts: [string, string][] = [
        ['Price', free ? 'Not charged' : `${formatMoney(plan.amountCents)} a ${INTERVAL_LABELS[plan.interval]}`],
        ['Started', formatDay(plan.startsOn)],
        ['Periods billed', String(plan.periodsBilled)],
    ]
    if (!plan.endedAt && !free) {
        facts.push(['Next period', `${formatDayShort(period.start)} to ${formatDayShort(period.end)}`])
        facts.push(automatic ? ['Next payment', `${formatDayShort(next)}, by PayPal`] : ['Next invoice', `${formatDayShort(next)}, due ${plan.dueDays} days later`])
    }
    if (plan.endedAt) facts.push(['Ended', formatWhen(plan.endedAt)])

    const owing = raised.filter(invoice => invoice.status === 'OPEN').reduce((sum, invoice) => sum + invoice.totalCents, 0)
    const paid = raised.filter(invoice => invoice.status === 'PAID').reduce((sum, invoice) => sum + invoice.totalCents, 0)

    const columns = [
        { key: 'number', head: 'Invoice' },
        { key: 'period', head: 'Period' },
        { key: 'due', head: 'Due', numeric: true },
        { key: 'total', head: 'Total', numeric: true },
        { key: 'status', head: 'Status' },
    ]
    const rows = raised.map(invoice => {
        const standing = standingOf(invoice, today)
        return {
            number: <Link href={`/portal/invoices/${invoice.id}`} className={frame.plainLink}>{invoiceNumber(invoice.number)}</Link>,
            period: invoice.periodStart && invoice.periodEnd ? `${formatDayShort(invoice.periodStart)} to ${formatDayShort(invoice.periodEnd)}` : '',
            due: formatDayShort(invoice.dueOn),
            total: formatMoney(invoice.totalCents, invoice.currency),
            status: <Chip tone={STANDING_TONES[standing]}>{STANDING_LABELS[standing]}</Chip>,
        }
    })

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={[frame.head, frame.headCentred].join(' ')}>
                    <h1 className={frame.title}>{plan.description}</h1>
                    <Chip tone={state.tone}>{state.label}</Chip>
                </div>
                <p className={[frame.sub, frame.subBlock].join(' ')}>
                    {free ? 'Not charged' : `${formatMoney(plan.amountCents)} a ${INTERVAL_LABELS[plan.interval]}`} for{' '}
                    <Link href={`/portal/clients/${plan.client.id}`} className={frame.link}>{plan.client.name}</Link>
                    {plan.site && <> on <Link href={`/portal/sites/${plan.site.projectId}`} className={frame.link}>{plan.site.name}</Link></>}
                </p>

                {!plan.endedAt && (
                    <section className={frame.panel}>
                        <div className={frame.controls}>
                            <EditPlan
                                size="regular"
                                clientId={plan.clientId}
                                planId={plan.id}
                                sites={sites}
                                billed={plan.periodsBilled > 0}
                                initial={{
                                    description: plan.description, amountCents: plan.amountCents, interval: plan.interval,
                                    startsOn: plan.startsOn, dueDays: plan.dueDays, siteId: plan.siteId,
                                }}
                            />
                            {automatic && <StopAutopayButton planId={plan.id} />}
                            <EndPlanButton planId={plan.id} autopay={automatic} />
                        </div>
                        {plan.subscriptionStatus === 'SUSPENDED' && (
                            <p className={styles.inlineNote}>PayPal could not take the automatic payment, so this plan is invoiced instead until the client sets it up again.</p>
                        )}
                    </section>
                )}

                <section className={frame.panel}>
                    <h2 className={frame.section}>Details</h2>
                    <dl className={styles.planFacts}>
                        {facts.map(([label, value]) => (
                            <div key={label} className={styles.planFact}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Invoices</h2>
                    {raised.length > 0 && (
                        <p className={[styles.inlineNote, styles.planTotals].join(' ')}>
                            {formatMoney(paid)} paid{owing > 0 && `, ${formatMoney(owing)} owing`} across {raised.length} invoice{raised.length === 1 ? '' : 's'}.
                        </p>
                    )}
                    <DataTable label="Invoices from this plan" columns={columns} rows={rows} empty={free ? 'A plan that is not charged never raises an invoice.' : 'None yet. The first is raised on its start date.'} />
                </section>
            </div>
        </>
    )
}
