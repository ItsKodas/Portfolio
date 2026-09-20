import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Alert } from '@mui/material'

import { currentClient, PORTAL_HOME } from '@/server/clients/auth'
import { Panel, SignInForm } from '../forms'

export const metadata: Metadata = { title: 'Sign in' }

export default async function PortalSignInPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
    if (await currentClient()) redirect(PORTAL_HOME)
    const { reset } = await searchParams
    return (
        <Panel title="Client sign-in">
            {reset === '1' && <Alert severity="success" sx={{ mb: 2 }}>Your password has been changed. Sign in with the new one.</Alert>}
            <SignInForm />
        </Panel>
    )
}
