'use client'

import type { KeyboardEvent } from 'react'

import styles from './Tabs.module.css'

type Tab = { id: string, label: string }

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
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={tab.id === selected ? 0 : -1}
                    className={[styles.tab, tab.id === selected && styles.selected].filter(Boolean).join(' ')}
                    onClick={() => onSelect(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    )
}
