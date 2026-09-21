'use client'

// The tab strip is ui/Tabs. This is the thin piece that makes the selection a URL rather than client
// state: the page reads it back from searchParams, so a tab is shareable, reloadable and rendered on the
// server. ui/Tabs asks for an onSelect callback, which a server component cannot hand it, so this sits
// between the two and does nothing else.

import { useRouter } from 'next/navigation'

import { Tabs } from '@/ui/Tabs/Tabs'

type Tab = { id: string, label: string, disabled?: boolean }

type Props = {
    tabs: Tab[]
    selected: string
    basePath: string
    label: string
}

export function SiteTabs({ tabs, selected, basePath, label }: Props) {
    const router = useRouter()
    return (
        <Tabs
            tabs={tabs}
            selected={selected}
            label={label}
            // scroll: false, because moving along the strip should not throw the reader back to the top
            // of the page every time the arrow keys land on the next tab.
            onSelect={id => router.push(`${basePath}?tab=${encodeURIComponent(id)}`, { scroll: false })}
        />
    )
}
