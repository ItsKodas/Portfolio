'use client'

import styles from './parallax.module.css'

// Small round button in the top right that opens the scene as a desktop wallpaper (app/wallpaper). Its icon is a thin,
// rounded viewfinder framing a mountain range and the moon. (A plain link, loading the wallpaper afresh, since it sets
// the page's performance and motion modes its own way.)

const strokes = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function ViewIcon() {
    return (
        <svg viewBox="0 0 24 24" {...strokes} aria-hidden="true">
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

export default function WallpaperLink() {
    const label = 'See the view as a desktop wallpaper'
    return (
        <a href="/wallpaper" aria-label={label} title={label} className={styles.wallpaperLink}>
            <ViewIcon />
        </a>
    )
}
