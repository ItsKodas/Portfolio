'use client'

import type { KeyboardEvent } from 'react'

import styles from './Tabs.module.css'

// disabled means "designed, not built yet": the tab is shown, marked, and still works as a tab, because
// its panel is where the explanation lives. It is never the `disabled` attribute, which would take the
// button out of the focus order and put that explanation out of a keyboard's reach.
type Tab = { id: string, label: string, disabled?: boolean }

type Props = {
    tabs: Tab[]
    selected: string
    onSelect: (id: string) => void
    label: string
}

export function Tabs({ tabs, selected, onSelect, label }: Props) {
    // Roving tabindex: the set is one stop in the tab order and the arrows move within it, which is what
    // the tab pattern asks for and what a row of plain buttons gets wrong.
    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const index = tabs.findIndex(tab => tab.id === selected)
        const next = tabs[(index + step + tabs.length) % tabs.length]
        onSelect(next.id)
    }

    return (
        <div className={styles.tablist} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-selected={tab.id === selected}
                    aria-disabled={tab.disabled ? true : undefined}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={tab.id === selected ? 0 : -1}
                    className={[styles.tab, tab.id === selected && styles.selected, tab.disabled && styles.waiting]
                        .filter(Boolean)
                        .join(' ')}
                    onClick={() => onSelect(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    )
}
