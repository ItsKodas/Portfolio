import Link from 'next/link'

import { SITE } from '@/app/site'
import styles from './brand.module.css'

// The name set the way the home page's hero sets it (uppercase, bold, widely
// tracked), so the portal reads as the same product as the page that links to it.
// `label` names the area under the wordmark's link, e.g. the admin pages, set quieter so the name still leads.
export default function Brand({ href = '/portal', label }: { href?: string, label?: string }) {
    return (
        <Link href={href} className={styles.brand}>
            <span className={styles.name}>{SITE.name.toUpperCase()}</span>
            {label && <span className={styles.label}>{label}</span>}
        </Link>
    )
}
