import type { Metadata } from 'next'

// The plan had this file deleted with the theme it wrapped. It is kept, minus the MUI providers: the root
// layout says index: true, so deleting this would have made the operator sign-in page indexable, and the
// force-dynamic below is not MUI's either.
export const metadata: Metadata = {
    title: { default: 'Admin', template: '%s · Admin' },
    robots: { index: false, follow: false },
}

// Admin pages show another visitor's data and must never be served from a cache, however a later change to this
// tree might otherwise make it eligible for one
export const dynamic = 'force-dynamic'

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return <>{children}</>
}
