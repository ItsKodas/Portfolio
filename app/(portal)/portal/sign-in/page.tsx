import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { currentClient, PORTAL_HOME } from '@/server/clients/auth'
import { Panel, SignInForm } from '../forms'

export const metadata: Metadata = { title: 'Sign in' }

export default async function PortalSignInPage() {
    if (await currentClient()) redirect(PORTAL_HOME)
    return <Panel title="Client sign-in"><SignInForm /></Panel>
}
