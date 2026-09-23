import Link from 'next/link'

import { SITE } from '@/app/site'
import styles from './brand.module.css'

// The name set the way the home page's hero sets it (uppercase, bold, widely
// tracked), so the portal reads as the same product as the page that links to it.
export default function Brand() {
    return (
        <Link href="/portal" className={styles.brand}>
            <span className={styles.name}>{SITE.name.toUpperCase()}</span>
        </Link>
    )
}
