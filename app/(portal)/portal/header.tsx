import { signOut } from '@/server/auth'
import { clearImpersonationCookie } from '@/server/clients/impersonating'
import { Button } from '@/ui/Button/Button'
import { ShellBar } from '@/ui/Shell/Shell'
import { signOutAction } from './actions'
import Brand from './brand'
import styles from './header.module.css'
import PortalTabs from './tabs'
import { ViewingAsBanner } from './viewAs/banner'

// The far end of the bar: who is signed in, and a way out. The same on every portal page, the Shell ones
// included, so the way out never moves. An operator signs out of Auth.js and a client out of their own
// session, which is the only thing that differs. An operator viewing as a client is still the operator
// here: signing out ends their own session, and the view with it.
export function SignOut({ admin, name }: { admin: boolean, name?: string }) {
    async function signOutAdmin() {
        'use server'
        await clearImpersonationCookie(null)
        await signOut({ redirectTo: '/admin/sign-in' })
    }

    return (
        <span className={styles.nav}>
            {name && <span className={styles.who}>{name}</span>}
            <form action={admin ? signOutAdmin : signOutAction}>
                <Button type="submit" variant="quiet" size="small">Sign out</Button>
            </form>
        </span>
    )
}

// ui/Shell's own bar, for the pages that have no site list under it. Drawing the same element rather than
// a lookalike is what keeps the bar from shifting between the dashboard and the quotes inbox. viewingAs is
// the client's name while the operator is viewing as them, which only the client's own pages (Account) can
// be: the operator's pages are theirs alone and look it, so they carry no banner.
export default function PortalHeader({ admin, name, viewingAs }: { admin: boolean, name?: string, viewingAs?: string }) {
    return (
        <ShellBar
            brand={<Brand />}
            tabs={<PortalTabs admin={admin} />}
            bar={<SignOut admin={admin || !!viewingAs} name={name} />}
            notice={viewingAs ? <ViewingAsBanner name={viewingAs} /> : undefined}
        />
    )
}
