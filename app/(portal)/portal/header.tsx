import { Button } from '@/ui/Button/Button'
import { signOutAction } from './actions'
import Brand from './brand'
import styles from './header.module.css'
import PortalTabs from './tabs'

// Same shape as adminHeader.tsx: a wordmark, an identity, and a way out.
export default function PortalHeader({ name }: { name: string }) {
    return (
        <header className={styles.bar}>
            <Brand />
            <PortalTabs admin={false} />
            <div className={styles.nav}>
                <span className={styles.who}>{name}</span>
                <form action={signOutAction}>
                    <Button type="submit" variant="quiet" size="small">Sign out</Button>
                </form>
            </div>
        </header>
    )
}
