import type { Metadata } from 'next'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { businessDetails } from '@/server/invoices/business'
import { addDays, todayIn } from '@/server/invoices/days'
import frame from '../../frame.module.css'
import PortalHeader from '../../header'
import { InvoiceForm } from '../controls'

export const metadata: Metadata = { title: 'New invoice' }

const DEFAULT_DAYS_TO_PAY = 14

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
    await requireAdmin()
    const { client } = await searchParams
    const clients = (await repo().list()).map(one => ({ id: one.id, name: one.name, company: one.company }))
    const preset = clients.some(one => one.id === client) ? client! : ''

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={frame.head}>
                    <h1 className={frame.title}>New invoice</h1>
                    <p className={frame.sub}>Saved as a draft first, so it can be checked before it is sent</p>
                </div>
                <section className={frame.panel}>
                    {clients.length === 0
                        ? <p className={frame.empty}>Create a client first: an invoice is always for one.</p>
                        : (
                            <InvoiceForm
                                clients={clients}
                                gst={businessDetails().gst}
                                initial={{ clientId: preset, dueOn: addDays(todayIn(new Date()), DEFAULT_DAYS_TO_PAY), notes: null, lines: [] }}
                            />
                        )}
                </section>
            </div>
        </>
    )
}
