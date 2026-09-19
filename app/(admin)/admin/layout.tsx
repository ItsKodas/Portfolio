import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'

import AdminTheme from './theme'

// MUI's providers live here rather than in the root layout, so the landing page and the wallpaper build don't get them
export const metadata: Metadata = {
    title: { default: 'Admin', template: '%s · Admin' },
    robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <AppRouterCacheProvider>
            <AdminTheme>{children}</AdminTheme>
        </AppRouterCacheProvider>
    )
}
