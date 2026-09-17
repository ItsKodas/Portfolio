import { useEffect, useState, useSyncExternalStore } from 'react'

// What's playing on the computer, from Wallpaper Engine's media integration: whatever Windows sees as playing (Spotify,
// a browser, most music apps) with its title, artist, album art and, where the player reports it, its position.
// Read-only: Wallpaper Engine gives no way to control playback. The user switches it on in Wallpaper Engine's own
// settings; elsewhere (a normal browser) none of it is there and nothing shows.

// The events come in through an inline script at the top of the page (see mediaScript.ts), which keeps the latest of
// each kind for here.

type Received = { receivedAt: number }

type Events = {
    status?: Received & { enabled: boolean }
    properties?: Received & { trackAt: number, title: string, artist: string, albumTitle?: string, contentType?: string }
    thumbnail?: Received & { thumbnail: string, primaryColor?: string, textColor?: string }
    playback?: Received & { state: number, previousState?: number }
    timeline?: Received & { position: number, duration: number }
}

declare global {
    interface Window {
        __wallpaperMedia?: { events: Events, listeners: (() => void)[], audioSupported?: boolean, audio?: number[] }
        wallpaperMediaIntegration?: { PLAYBACK_PLAYING: number, PLAYBACK_PAUSED: number, PLAYBACK_STOPPED: number }
    }
}

export type NowPlaying = {
    title: string
    artist: string
    art?: string       // the album art, as an image URL
    color?: string     // the album art's main colour
    playing: boolean
    position?: number  // seconds in, when the player reports it
    duration?: number  // seconds long, likewise
}

// Album art and positions that arrive this soon before a new track's details still count for the new track (the events
// for a change of track don't come in a set order)
const SAME_TRACK_MS = 1500

let version = 0
const subscribe = (listener: () => void) => {
    const media = window.__wallpaperMedia
    if (!media) return () => {}
    const bump = () => { version++; listener() }
    media.listeners.push(bump)
    return () => { media.listeners = media.listeners.filter(l => l !== bump) }
}

// The latest events, re-read whenever one comes in
function useEvents() {
    useSyncExternalStore(subscribe, () => version, () => 0)
    return typeof window === 'undefined' ? {} : window.__wallpaperMedia?.events ?? {}
}

// The track currently loaded in a player, or null when there's none (or media integration is off), with its position
// moving on each second while it plays
export function useNowPlaying(): NowPlaying | null {
    const { status, properties, thumbnail, playback, timeline } = useEvents()

    const constants = typeof window === 'undefined' ? undefined : window.wallpaperMediaIntegration
    const playing = playback !== undefined && playback.state === (constants?.PLAYBACK_PLAYING ?? 1)
    const stopped = playback !== undefined && playback.state === (constants?.PLAYBACK_STOPPED ?? 0)

    // (nothing until the page has hydrated, as the prerendered page has nothing playing)
    const [hydrated, setHydrated] = useState(false)
    useEffect(() => setHydrated(true), [])

    // A clock for the position, ticking only while something's playing
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!playing) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [playing])

    if (!hydrated || status?.enabled === false || !properties?.title || stopped) return null

    const current = <T extends Received>(event: T | undefined) =>
        event && event.receivedAt >= properties.trackAt - SAME_TRACK_MS ? event : undefined
    const art = current(thumbnail)
    const time = current(timeline)

    // Moves on from the last report while playing (or from when playback started, if that was later), and once paused
    // stays where it was when it paused
    let position = time?.position
    if (time && playback) {
        const PLAYING = constants?.PLAYBACK_PLAYING ?? 1
        if (playing) position = time.position + (now - Math.max(time.receivedAt, playback.receivedAt)) / 1000
        else if (playback.previousState === PLAYING && playback.receivedAt > time.receivedAt)
            position = time.position + (playback.receivedAt - time.receivedAt) / 1000
    }

    return {
        title: properties.title,
        artist: properties.artist,
        art: art?.thumbnail && (art.thumbnail.startsWith('data:') ? art.thumbnail : `data:image/png;base64,${art.thumbnail}`),
        color: art?.primaryColor,
        playing,
        position: time && position !== undefined ? Math.min(Math.max(position, 0), time.duration) : undefined,
        duration: time?.duration || undefined,
    }
}
