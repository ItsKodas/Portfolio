import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { auth, signIn } from '@/server/auth'
import { isAdminSession } from '@/server/auth/allow'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import styles from './signIn.module.css'

export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
    if (isAdminSession(await auth(), process.env.ADMIN_EMAIL)) redirect('/admin')
    const { error } = await searchParams

    async function signInWithGoogle() {
        'use server'
        await signIn('google', { redirectTo: '/admin' })
    }

    return (
        <div className={styles.ground}>
            <div className={styles.panel}>
                <h1 className={styles.title}>Horizons admin</h1>
                {error && (
                    <div className={styles.problem}>
                        <Callout
                            tone="crit"
                            title={error === 'AccessDenied' ? 'That Google account is not authorised.' : 'Sign-in failed. Please try again.'}
                        >
                            {null}
                        </Callout>
                    </div>
                )}
                <form action={signInWithGoogle}>
                    <Button type="submit" variant="primary" className={styles.submit}>Sign in with Google</Button>
                </form>
            </div>
        </div>
    )
}
