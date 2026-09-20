import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SETUP_PATH, requirePendingSession } from '@/server/clients/auth'
import { CodeForm, Panel } from '../../forms'

export const metadata: Metadata = { title: 'Verify your code' }

export default async function PortalCodePage() {
    const session = await requirePendingSession()
    if (!session.client.totpConfirmedAt) redirect(SETUP_PATH)
    return <Panel title="One more step"><CodeForm /></Panel>
}
