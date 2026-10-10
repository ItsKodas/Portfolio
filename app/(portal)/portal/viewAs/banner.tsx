import { Button } from '@/ui/Button/Button'
import { stopViewingAsAction } from './actions'
import styles from './banner.module.css'

// The strip under the bar on every portal page while the operator is viewing as a client. It stays for as
// long as that lasts, so a page that looks like a client's is never mistaken for the operator's own, and
// the way back is always the same button in the same place.
export function ViewingAsBanner({ name }: { name: string }) {
    return (
        <div className={styles.banner} role="status">
            <span className={styles.text}>
                Viewing as <strong>{name}</strong>. You see their sites, tabs and controls, and nothing more.
            </span>
            <form action={stopViewingAsAction}>
                <Button type="submit" size="small">Stop viewing as client</Button>
            </form>
        </div>
    )
}
