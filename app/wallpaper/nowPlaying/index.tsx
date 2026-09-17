'use client'

// What's playing (see media.ts): the album art, the track and artist, and how far in it is, in the album art's own
// colour. It fades in when a track loads and out when it's gone (or, if the settings say so, while it's paused).
// Either hung beneath the time, date and weather, taking no room in their block so the time never shifts for it, or
// pinned in a corner of the screen, clear of the scene's parallax and zoom so it never slips off the edge.

import { useRef } from 'react'
import { MusicNote, Pause } from '@mui/icons-material'

import { useNowPlaying, type NowPlaying as Track } from '../media'
import { MUSIC_POSITIONS, useSettings } from '../settings'
import { useScreenScale } from '../useScreenScale'
import styles from './nowPlaying.module.css'

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

type Placement = typeof MUSIC_POSITIONS[number]

// How far in from the corners it sits, at natural size, and how much further down it goes in the top right on the site,
// clear of the links there (see siteLinks)
const CORNER_MARGIN = 64
const SITE_LINKS_CLEARANCE = 56

export default function NowPlaying({ placement }: { placement: Placement }) {
    const { music, progress, musicPosition } = useSettings()
    const track = useNowPlaying()
    const visible = track !== null && (music === 'always' || (music === 'playing' && track.playing))

    // The last track shown, kept while it fades out
    const last = useRef<Track | null>(null)
    if (visible) last.current = track
    const shown = last.current

    if (music === 'off' || musicPosition !== placement || !shown) return null
    const { title, artist, art, color, playing, position, duration } = shown

    return (
        <div className={`${styles.nowPlaying} ${placement === 'center' ? styles.center : ''} ${placement.endsWith('right') ? styles.right : ''} ${visible ? '' : styles.hidden} ${playing ? '' : styles.paused}`} aria-live="polite">
            {art
                // eslint-disable-next-line @next/next/no-img-element -- a data URL from Wallpaper Engine, nothing to optimise
                ? <img className={styles.art} src={art} alt="" />
                : <div className={`${styles.art} ${styles.noArt}`}><MusicNote className={styles.noArtIcon} /></div>}

            <div className={styles.details}>
                <div className={styles.title}>
                    {!playing && <Pause className={styles.pauseIcon} />}
                    <span className={styles.ellipsis}>{title}</span>
                </div>
                {artist && <div className={`${styles.artist} ${styles.ellipsis}`}>{artist}</div>}

                {progress && position !== undefined && duration !== undefined && (
                    <div className={styles.timeline}>
                        <span>{minutes(position)}</span>
                        <div className={styles.bar}>
                            <div key={title} className={styles.fill} style={{ width: `${(position / duration * 100).toFixed(2)}%`, ...(color && { background: color }) }} />
                        </div>
                        <span>{minutes(duration)}</span>
                    </div>
                )}
            </div>
        </div>
    )
}

// What's playing in a corner of the screen, when the settings put it in one, scaled with the screen from that corner
export function NowPlayingCorner() {
    const { musicPosition, size } = useSettings()
    const scale = useScreenScale() * size / 100
    if (musicPosition === 'center') return null

    const [vertical, horizontal] = musicPosition.split('-') as ['top' | 'bottom', 'left' | 'right']
    const clearance = musicPosition === 'top-right' && process.env.WALLPAPER_EXPORT !== '1' ? SITE_LINKS_CLEARANCE : 0
    return (
        <div className={styles.corner} style={{
            [vertical]: CORNER_MARGIN * scale + clearance,
            [horizontal]: CORNER_MARGIN * scale,
            transform: `scale(${scale})`,
            transformOrigin: `${vertical} ${horizontal}`,
        }}>
            <NowPlaying placement={musicPosition} />
        </div>
    )
}
