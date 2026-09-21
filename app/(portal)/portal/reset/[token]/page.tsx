import type { Metadata } from 'next'

import { hashSessionToken } from '@/server/clients/session'
import { tokenProblem } from '@/server/clients/setup'
import { repo } from '@/server/clients/wiring'
import { Callout } from '@/ui/Callout/Callout'
import { Panel, ResetForm } from '../../forms'

export const metadata: Metadata = { title: 'Reset your password' }

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params
    const record = await repo().tokenByHash(hashSessionToken(token))
    // Checked here as well as in the action: an expired link should never show a form at all
    const problem = tokenProblem(record, 'PASSWORD_RESET', new Date())
    if (problem) return <Panel title="This link has expired"><Callout tone="warn" title={problem}>{null}</Callout></Panel>
    // A client who never finished enrolment has no authenticator to ask them for
    return <Panel title="Reset your password"><ResetForm token={token} needsCode={!!record?.client.totpConfirmedAt} /></Panel>
}
