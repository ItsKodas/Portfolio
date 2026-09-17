import { useSyncExternalStore } from 'react'

// The wallpaper's settings, as chosen in Wallpaper Engine's properties panel (see wallpaper-engine/project.json).
// Wallpaper Engine hands them over through window.wallpaperPropertyListener, once on load and again whenever one is
// changed. In a normal browser the same settings can be tried from the address bar, e.g.
// /wallpaper?hours=24&location=Perth, AU&units=fahrenheit&strength=80&still=1

export type WallpaperSettings = {
    clock: boolean    // the time
    date: boolean     // the day and date under it
    weather: boolean  // the weather under those
    hours: 'auto' | '12' | '24'                 // clock format (auto follows the system's language)
    location: string                            // a place name for the weather, e.g. "Perth, AU" (blank finds it from the IP address)
    units: 'auto' | 'celsius' | 'fahrenheit'    // temperature units (auto follows the system's region)
    parallax: boolean // layers drifting with the mouse
    strength: number  // how far they drift, 0 to 100
    still: boolean    // the scenery's own animations off (the lite mode), for the least GPU use
    paused: boolean   // Wallpaper Engine has paused the wallpaper (a fullscreen app is in front, for instance)
}

const DEFAULTS: WallpaperSettings = {
    clock: true, date: true, weather: true, hours: '12', location: '', units: 'auto',
    parallax: true, strength: 50, still: false, paused: false,
}

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

const oneOf = <T extends string>(options: readonly T[], value: unknown) => options.find(o => o === String(value))

const HOURS = ['auto', '12', '24'] as const
const UNITS = ['auto', 'celsius', 'fahrenheit'] as const

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
    const flag = (name: string) => query.has(name) ? { [name]: query.get(name) !== '0' } : {}
    const strength = Number(query.get('strength') ?? NaN)
    const hours = oneOf(HOURS, query.get('hours'))
    const units = oneOf(UNITS, query.get('units'))
    settings = {
        ...settings,
        ...flag('clock'), ...flag('date'), ...flag('weather'), ...flag('parallax'), ...flag('still'),
        ...(hours && { hours }),
        ...(units && { units }),
        ...(query.has('location') && { location: query.get('location') ?? '' }),
        ...(!isNaN(strength) && { strength }),
    }

    window.wallpaperPropertyListener = {
        applyUserProperties(p) {
            const changes: Partial<WallpaperSettings> = {}
            if (p.showclock) changes.clock = Boolean(p.showclock.value)
            if (p.showdate) changes.date = Boolean(p.showdate.value)
            if (p.showweather) changes.weather = Boolean(p.showweather.value)
            if (p.clockformat) changes.hours = oneOf(HOURS, p.clockformat.value) ?? '12'
            if (p.weatherlocation) changes.location = String(p.weatherlocation.value ?? '')
            if (p.temperatureunits) changes.units = oneOf(UNITS, p.temperatureunits.value) ?? 'auto'
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
