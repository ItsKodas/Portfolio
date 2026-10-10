import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SETUP_PATH, SIGN_IN_PATH, requirePendingSession } from '@/server/clients/auth'
import { CodeForm, Panel } from '../../forms'

export const metadata: Metadata = { title: 'Verify your code' }

export default async function PortalCodePage() {
    const session = await requirePendingSession()
    // Begun before the operator turned two-step sign-in off, so there is no step here any more: signing in
    // again with the password finishes it
    if (!session.client.totpRequired) redirect(SIGN_IN_PATH)
    if (!session.client.totpConfirmedAt) redirect(SETUP_PATH)
    return <Panel title="One more step"><CodeForm /></Panel>
}
