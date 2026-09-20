import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import QRCode from 'qrcode'

import { CODE_PATH, requirePendingSession } from '@/server/clients/auth'
import { beginEnrolment } from '@/server/clients/setup'
import { beginEnrolmentDeps } from '@/server/clients/wiring'
import { EnrolmentForm, Panel } from '../forms'

export const metadata: Metadata = { title: 'Set up your authenticator' }

export default async function PortalSetupPage() {
    const session = await requirePendingSession()
    if (session.client.totpConfirmedAt) redirect(CODE_PATH)
    const { uri, typed } = await beginEnrolment(session.client, beginEnrolmentDeps())
    // Rendered on the server into a data URI, so no third-party script runs on the page that shows the secret
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
    return <Panel title="Set up your authenticator"><EnrolmentForm qr={qr} typed={typed} /></Panel>
}
