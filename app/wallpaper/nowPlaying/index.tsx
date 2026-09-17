'use client'

// What's playing (see media.ts), hung beneath the time, date and weather: the album art, the track and artist, and how
// far in it is, in the album art's own colour. It fades in when a track loads and out when it's gone (or, if the
// settings say so, while it's paused), and takes no room in the block above, so the time never shifts for it.

import { useRef } from 'react'
import { MusicNote, Pause } from '@mui/icons-material'

import { useNowPlaying, type NowPlaying as Track } from '../media'
import { useSettings } from '../settings'
import styles from './nowPlaying.module.css'

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export default function NowPlaying() {
    const { music, progress } = useSettings()
    const track = useNowPlaying()
    const visible = track !== null && (music === 'always' || (music === 'playing' && track.playing))

    // The last track shown, kept while it fades out
    const last = useRef<Track | null>(null)
    if (visible) last.current = track
    const shown = last.current

    if (music === 'off' || !shown) return null
    const { title, artist, art, color, playing, position, duration } = shown

    return (
        <div className={`${styles.nowPlaying} ${visible ? '' : styles.hidden} ${playing ? '' : styles.paused}`} aria-live="polite">
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
