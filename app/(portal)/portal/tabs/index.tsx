'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { tabsFor } from './tabs'
import styles from './tabs.module.css'

// The row of places beside the wordmark. The same component in both bars, ui/Shell's and the one the operator
// pages draw for themselves, so moving between the dashboard and the quotes inbox keeps the tabs where they were.
export default function PortalTabs({ admin }: { admin: boolean }) {
    const pathname = usePathname() ?? ''

    return (
        <nav className={styles.tabs} aria-label="Portal">
            {tabsFor(admin, pathname).map(tab => (
                <Link
                    key={tab.href}
                    href={tab.href}
                    className={styles.tab}
                    aria-current={tab.active ? 'page' : undefined}
                >
                    {tab.label}
                </Link>
            ))}
        </nav>
    )
}
