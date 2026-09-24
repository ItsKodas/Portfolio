import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { formatWhen } from '../format'
import PortalHeader from '../header'
import frame from '../frame.module.css'
import { STATE_TONES, clientState } from './state'

export const metadata: Metadata = { title: 'Clients' }

export default async function ClientsPage() {
    await requireAdmin()
    const clients = await repo().list()
    const now = new Date()

    const columns = [
        { key: 'name', head: 'Name' },
        { key: 'company', head: 'Company' },
        { key: 'email', head: 'Email' },
        { key: 'status', head: 'Status' },
        { key: 'sites', head: 'Sites', numeric: true },
        { key: 'signedIn', head: 'Last sign-in', numeric: true },
    ]

    const rows = clients.map(client => {
        const state = clientState(client, now)
        return {
            name: <Link href={`/admin/clients/${client.id}`} className={frame.plainLink}>{client.name}</Link>,
            company: client.company,
            email: client.email,
            status: <Chip tone={STATE_TONES[state]}>{state}</Chip>,
            sites: client._count.sites,
            signedIn: client.lastSignInAt ? formatWhen(client.lastSignInAt) : 'Never',
        }
    })

    return (
        <>
            <PortalHeader admin />
            <div className={frame.page}>
                <div className={[frame.head, frame.headSpread].join(' ')}>
                    <h1 className={frame.title}>Clients</h1>
                    <Link href="/admin/clients/new" className={[frame.action, frame.actionPrimary].join(' ')}>New client</Link>
                </div>

                {/* DataTable prints its own line rather than headings over nothing, so the page has no empty state of its own */}
                <DataTable label="Clients" columns={columns} rows={rows} empty="No clients yet." />
            </div>
        </>
    )
}
