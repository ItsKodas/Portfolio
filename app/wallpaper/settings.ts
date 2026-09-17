import { useSyncExternalStore } from 'react'

// The wallpaper's settings, as chosen in Wallpaper Engine's properties panel (see wallpaper/project.json). Wallpaper
// Engine hands them over through window.wallpaperPropertyListener, once on load and again whenever one is changed.
// In a normal browser the same settings can be tried from the address bar, e.g. /wallpaper?logo=0&strength=80&still=1

export type WallpaperSettings = {
    logo: boolean     // the Horizons title
    parallax: boolean // layers drifting with the mouse
    strength: number  // how far they drift, 0 to 100
    still: boolean    // the scenery's own animations off (the lite mode), for the least GPU use
    paused: boolean   // Wallpaper Engine has paused the wallpaper (a fullscreen app is in front, for instance)
}

const DEFAULTS: WallpaperSettings = { logo: true, parallax: true, strength: 50, still: false, paused: false }

let settings = DEFAULTS
const listeners = new Set<() => void>()

function update(changes: Partial<WallpaperSettings>) {
    settings = { ...settings, ...changes }
    listeners.forEach(l => l())
}

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export function useSettings() {
    return useSyncExternalStore(subscribe, () => settings, () => DEFAULTS)
}

type Property = { value: unknown }

declare global {
    interface Window {
        wallpaperPropertyListener?: {
            applyUserProperties?: (properties: Record<string, Property | undefined>) => void
            setPaused?: (paused: boolean) => void
        }
    }
}

// Installed as soon as the page's script loads, so it's in place before Wallpaper Engine sends the settings
if (typeof window !== 'undefined') {
    const query = new URLSearchParams(location.search)
    const flag = (name: string) => query.has(name) ? query.get(name) !== '0' : undefined
    const strength = query.has('strength') ? Number(query.get('strength')) : NaN
    settings = {
        ...settings,
        ...(flag('logo') !== undefined && { logo: flag('logo') }),
        ...(flag('parallax') !== undefined && { parallax: flag('parallax') }),
        ...(flag('still') !== undefined && { still: flag('still') }),
        ...(!isNaN(strength) && { strength }),
    }

    window.wallpaperPropertyListener = {
        applyUserProperties(p) {
            const changes: Partial<WallpaperSettings> = {}
            if (p.showlogo) changes.logo = Boolean(p.showlogo.value)
            if (p.mouseparallax) changes.parallax = Boolean(p.mouseparallax.value)
            if (p.parallaxstrength) changes.strength = Number(p.parallaxstrength.value)
            if (p.stillscenery) changes.still = Boolean(p.stillscenery.value)
            update(changes)
        },
        setPaused(paused) {
            update({ paused })
        },
    }
}
