import Link from 'next/link'

import { signOut } from '@/server/auth'
import { Button } from '@/ui/Button/Button'
import Brand from './brand'
import styles from './header.module.css'

// Kept, rather than dropped for ui/Shell's bar: only the portal home renders inside a Shell, so for the
// quotes, clients and gallery pages this is the whole of their navigation. No page shows both.
export default function AdminHeader() {
    async function signOutAction() {
        'use server'
        await signOut({ redirectTo: '/admin/sign-in' })
    }

    return (
        <header className={styles.bar}>
            <Brand href="/admin" label="admin" />
            <nav className={styles.nav}>
                <Link href="/admin" className={styles.link}>Quotes</Link>
                <Link href="/admin/clients" className={styles.link}>Clients</Link>
            </nav>
            <form action={signOutAction}>
                <Button type="submit" variant="quiet" size="small">Sign out</Button>
            </form>
        </header>
    )
}
