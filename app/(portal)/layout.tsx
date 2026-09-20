import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'

import PortalTheme from './theme'

export const metadata: Metadata = {
    title: { default: 'Client portal', template: '%s · Horizons' },
    robots: { index: false, follow: false },
}

// Every portal page shows one client's own data and must never be served from a cache
export const dynamic = 'force-dynamic'

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <AppRouterCacheProvider>
            <PortalTheme>{children}</PortalTheme>
        </AppRouterCacheProvider>
    )
}
