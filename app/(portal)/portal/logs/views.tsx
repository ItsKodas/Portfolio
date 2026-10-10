import Link from 'next/link'

import frame from '../frame.module.css'
import styles from './logs.module.css'

// The two halves of the Logs page: what people did, and what the site emailed
export function LogViews({ current }: { current: 'activity' | 'emails' }) {
    return (
        <nav className={styles.views} aria-label="Logs">
            <Link href="/portal/logs" className={styles.view} aria-current={current === 'activity' ? 'page' : undefined}>Activity</Link>
            <Link href="/portal/logs/emails" className={styles.view} aria-current={current === 'emails' ? 'page' : undefined}>Emails</Link>
        </nav>
    )
}

const pagerLink = [frame.action, frame.actionSmall].join(' ')

export function Pager({ page, more, href }: { page: number, more: boolean, href: (page: number) => string }) {
    if (page === 1 && !more) return null
    return (
        <div className={styles.pager}>
            <span>Page {page}</span>
            <span className={styles.pagerLinks}>
                {page > 1 && <Link href={href(page - 1)} className={pagerLink}>Newer</Link>}
                {more && <Link href={href(page + 1)} className={pagerLink}>Older</Link>}
            </span>
        </div>
    )
}
