import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { autopayActive, INTERVAL_LABELS, nextBillingDay } from '@/server/invoices/plans'
import { formatDayShort } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { paypalMode, plans } from '@/server/invoices/wiring'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import frame from '../../frame.module.css'
import PortalHeader from '../../header'

export const metadata: Metadata = { title: 'Plans' }

// Every recurring charge, across every client. Plans are made and changed on each client's own page.
export default async function PlansPage() {
    await requireAdmin()
    const list = await plans().list({ includeEnded: true })
    const mode = paypalMode()

    const columns = [
        { key: 'client', head: 'Client' },
        { key: 'plan', head: 'Plan' },
        { key: 'price', head: 'Price', numeric: true },
        { key: 'next', head: 'Next invoice', numeric: true },
        { key: 'payment', head: 'Paid by' },
    ]

    const rows = list.map(plan => {
        const automatic = autopayActive(plan, mode)
        return {
            client: <Link href={`/portal/clients/${plan.client.id}`} className={frame.plainLink}>{plan.client.name}</Link>,
            plan: <>{plan.description}{plan.site && <span className={frame.mono}> {plan.site.projectId}</span>}</>,
            price: plan.amountCents === 0 ? 'Free' : `${formatMoney(plan.amountCents)} / ${INTERVAL_LABELS[plan.interval]}`,
            next: plan.endedAt ? 'Ended' : plan.amountCents === 0 ? '' : automatic ? 'Automatic' : formatDayShort(nextBillingDay(plan)),
            payment: plan.endedAt
                ? <Chip>Ended</Chip>
                : plan.amountCents === 0 ? <Chip>Not charged</Chip>
                    : automatic ? <Chip tone="good">PayPal, automatic</Chip>
                        : plan.subscriptionStatus === 'SUSPENDED' ? <Chip tone="crit">Automatic payment failing</Chip>
                            : <Chip>Invoice</Chip>,
        }
    })

    return (
        <>
            <PortalHeader admin />
            <div className={frame.page}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Plans</h1>
                    <p className={frame.sub}>Recurring charges. Add or change one from the client&apos;s page.</p>
                </div>
                <DataTable label="Plans" columns={columns} rows={rows} empty="No plans yet. Add one from a client's page." />
            </div>
        </>
    )
}
