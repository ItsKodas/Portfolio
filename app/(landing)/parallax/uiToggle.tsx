'use client'

import styles from './parallax.module.css'

// Small round button in the top right that hides the hero's title, buttons and note, for an unobstructed view of the
// scenery (and brings them back); the content below is left as it is. While the view is clear it fades back until you
// hover it.
//
// Icons are thin, rounded strokes: a viewfinder framing a mountain range ("see the view"), and a page layout ("show the
// page"), which cross-fade with a slight turn when toggled.

const strokes = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function ViewIcon() {
    return (
        <svg viewBox="0 0 24 24" {...strokes}>
            {/* viewfinder corners */}
            <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8" />
            <path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8" />
            <path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16" />
            <path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
            {/* mountains, with the moon */}
            <path d="m7 16 3.5-4.5 2.5 3 1.5-1.8L17 16" />
            <circle cx="15.5" cy="8.5" r="1" />
        </svg>
    )
}

function PageIcon() {
    return (
        <svg viewBox="0 0 24 24" {...strokes}>
            <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
            <path d="M8 9h8" />
            <path d="M8 12.5h5" />
            <path d="M8 16h6.5" />
        </svg>
    )
}

export default function UiToggle({ hidden, onToggle }: { hidden: boolean, onToggle: () => void }) {
    const label = hidden ? 'Show the page' : 'Hide the page to see the view'
    return (
        <button type="button" onClick={onToggle} aria-pressed={hidden} aria-label={label} title={label}
            className={`${styles.uiToggle} ${hidden ? styles.uiToggleQuiet : ''}`}>
            <span className={`${styles.uiIcon} ${hidden ? styles.uiIconOut : ''}`}><ViewIcon /></span>
            <span className={`${styles.uiIcon} ${hidden ? '' : styles.uiIconOut}`}><PageIcon /></span>
        </button>
    )
}
