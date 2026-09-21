import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { currentClient, PORTAL_HOME } from '@/server/clients/auth'
import { Callout } from '@/ui/Callout/Callout'
import { Panel, SignInForm } from '../forms'
import styles from '../forms.module.css'

export const metadata: Metadata = { title: 'Sign in' }

export default async function PortalSignInPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
    if (await currentClient()) redirect(PORTAL_HOME)
    const { reset } = await searchParams
    return (
        <Panel title="Client sign-in">
            {reset === '1' && (
                <div className={styles.done}>
                    <Callout tone="good" title="Your password has been changed.">Sign in with the new one.</Callout>
                </div>
            )}
            <SignInForm />
        </Panel>
    )
}
