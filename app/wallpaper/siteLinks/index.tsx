'use client'

import { ArrowBack, NorthEast } from '@mui/icons-material'

import styles from './siteLinks.module.css'

// For the wallpaper as a page on the site: a way back to the site, and the wallpaper's Steam Workshop page, quietly in
// the top right until hovered. Left out of the Wallpaper Engine build (see next.config.ts), where they'd only get in the
// way on the desktop. (The way back is a plain link, loading the site afresh, since the wallpaper sets the page's
// performance and motion modes its own way.)

const WORKSHOP = 'https://steamcommunity.com/sharedfiles/filedetails/?id=3803371065'

export default function SiteLinks() {
    if (process.env.WALLPAPER_EXPORT === '1') return null

    return (
        <nav className={styles.links}>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a fresh load is the point (see above) */}
            <a href="/" className={styles.link}>
                <ArrowBack className={styles.icon} /> Horizons
            </a>
            <a href={WORKSHOP} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.primary}`}>
                Get it on Steam Workshop <NorthEast className={styles.icon} />
            </a>
        </nav>
    )
}
