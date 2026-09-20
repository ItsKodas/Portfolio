import type { Metadata } from 'next'
import { Alert } from '@mui/material'

import { hashSessionToken } from '@/server/clients/session'
import { tokenProblem } from '@/server/clients/setup'
import { repo } from '@/server/clients/wiring'
import { InviteForm, Panel } from '../../forms'

export const metadata: Metadata = { title: 'Set your password' }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params
    const record = await repo().tokenByHash(hashSessionToken(token))
    // Checked here as well as in the action: an expired link should never show a form at all
    const problem = tokenProblem(record, 'INVITE', new Date())
    if (problem) return <Panel title="This link has expired"><Alert severity="warning">{problem}</Alert></Panel>
    return <Panel title="Set your password"><InviteForm token={token} /></Panel>
}
