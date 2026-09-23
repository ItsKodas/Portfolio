import Link from 'next/link'

import { Button } from '@/ui/Button/Button'
import { signOutAction } from './actions'
import Brand from './brand'
import styles from './header.module.css'

// Same shape as adminHeader.tsx: a wordmark, an identity, and a way out.
export default function PortalHeader({ name }: { name: string }) {
    return (
        <header className={styles.bar}>
            <Brand />
            <div className={styles.nav}>
                <span className={styles.who}>{name}</span>
                <Link href="/portal/account" className={styles.link}>Account</Link>
                <form action={signOutAction}>
                    <Button type="submit" variant="quiet" size="small">Sign out</Button>
                </form>
            </div>
        </header>
    )
}
