import type { Metadata } from 'next'

import styles from './layout.module.css'

export const metadata: Metadata = {
    title: { default: 'Client portal', template: '%s · Horizons' },
    robots: { index: false, follow: false },
}

// Every portal page shows one client's own data and must never be served from a cache
export const dynamic = 'force-dynamic'

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return <div className={styles.ground}>{children}</div>
}
