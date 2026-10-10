type Place = { label: string, href: string, owns: string[] }

// The site pages live under /portal/sites/ and belong to the dashboard's tab: they are what it lists.
const SITES = ['/portal', '/portal/sites']

const ADMIN: Place[] = [
    { label: 'Sites', href: '/portal', owns: SITES },
    { label: 'Quotes', href: '/portal/quotes', owns: ['/portal/quotes'] },
    { label: 'Clients', href: '/portal/clients', owns: ['/portal/clients'] },
    { label: 'Invoices', href: '/portal/invoices', owns: ['/portal/invoices'] },
    { label: 'Logs', href: '/portal/logs', owns: ['/portal/logs'] },
]

// A client has their sites, their invoices and their own account, and nothing else in the portal is theirs to open
const CLIENT: Place[] = [
    { label: 'Overview', href: '/portal', owns: SITES },
    { label: 'Billing', href: '/portal/billing', owns: ['/portal/billing'] },
    { label: 'Account', href: '/portal/account', owns: ['/portal/account'] },
]

// '/portal' owns only itself, or every page in the portal would light the first tab
function within(pathname: string, prefix: string): boolean {
    if (prefix === '/portal') return pathname === '/portal' || pathname === '/portal/'
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function tabsFor(admin: boolean, pathname: string): { label: string, href: string, active: boolean }[] {
    return (admin ? ADMIN : CLIENT).map(({ label, href, owns }) => ({
        label,
        href,
        active: owns.some(prefix => within(pathname, prefix)),
    }))
}
