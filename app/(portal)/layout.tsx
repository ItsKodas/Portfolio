import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'

import PortalTheme from './theme'
import styles from './layout.module.css'

export const metadata: Metadata = {
    title: { default: 'Client portal', template: '%s · Horizons' },
    robots: { index: false, follow: false },
}

// Every portal page shows one client's own data and must never be served from a cache
export const dynamic = 'force-dynamic'

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        // The MUI providers stay: the sign-in, invite, reset and account pages under this layout are MUI and
        // work, so removing them breaks those for no gain here. The conversion removes both together.
        <AppRouterCacheProvider>
            <PortalTheme>
                <div className={styles.ground}>{children}</div>
            </PortalTheme>
        </AppRouterCacheProvider>
    )
}
