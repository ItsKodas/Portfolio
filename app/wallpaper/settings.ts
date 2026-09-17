import { useSyncExternalStore } from 'react'

// The wallpaper's settings, as chosen in Wallpaper Engine's properties panel (see wallpaper-engine/project.json).
// Wallpaper Engine hands them over through window.wallpaperPropertyListener, once on load and again whenever one is
// changed. In a normal browser the same settings can be tried from the address bar by their names here, e.g.
// /wallpaper?hours=24&seconds=1&location=Perth, AU&units=fahrenheit&music=playing&musicPosition=bottom-left&visualizerStyle=wave&size=80&wind=0&still=1

const HOURS = ['12', '24', 'auto'] as const
const UNITS = ['auto', 'celsius', 'fahrenheit'] as const
const MUSIC = ['always', 'playing', 'off'] as const
export const MUSIC_POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
const VISUALIZER_STYLES = ['bars', 'wave'] as const
const VISUALIZER_COLORS = ['white', 'album'] as const

const DEFAULTS = {
    // The time, date and weather
    clock: true,                                // the time
    hours: '12' as typeof HOURS[number],        // 12- or 24-hour clock (auto follows the system's language)
    seconds: false,                             // seconds on the clock
    date: true,                                 // the day and date under it
    weather: true,                              // the weather under those
    location: '',                               // a place name for the weather, e.g. "Perth, AU" (blank finds it from the IP address)
    units: 'auto' as typeof UNITS[number],      // temperature units (auto follows the system's region)
    highLow: true,                              // today's high and low beside the weather
    place: true,                                // the town the weather is for
    music: 'always' as typeof MUSIC[number],    // what's playing under all that: whenever a track's loaded, only while it plays, or never
    progress: true,                             // how far into the track it is
    musicPosition: 'center' as typeof MUSIC_POSITIONS[number], // under the time, date and weather, or in a corner of the screen
    size: 100,                                  // the size of all that, as a percentage

    // The sound
    visualizer: true,                                          // the sound's levels along the bottom of the screen
    visualizerStyle: 'bars' as typeof VISUALIZER_STYLES[number], // as bars, or a smooth wave
    visualizerHeight: 20,                                      // how high the loudest reaches, as a percentage of the screen
    visualizerColor: 'white' as typeof VISUALIZER_COLORS[number], // white, or the playing album art's colour
    visualizerOpacity: 100,                                    // how solid the lines are, as a percentage

    // Motion
    parallax: true,       // layers drifting with the mouse
    strength: 50,         // how far they drift, 0 to 100
    still: false,         // every animation off (the site's lite mode), for the least GPU use
    clouds: true,         // clouds drifting across
    stars: true,          // stars twinkling and turning slowly
    shooting: true,       // the occasional shooting star
    wind: true,           // trees swaying, gusts and blowing leaves
    fireflies: true,      // fireflies wandering and glowing
    water: true,          // the lake's shimmer, fog and boat
    watchtower: true,     // the watchtower's flickering light
    intro: true,          // the time, date and weather rising in when they first appear

    paused: false,        // Wallpaper Engine has paused the wallpaper (a fullscreen app is in front, for instance)
}

export type WallpaperSettings = typeof DEFAULTS

// The parts of the scene that can be held still, as named in the stylesheets' html[data-still~="..."] rules
export const MOTION = ['clouds', 'stars', 'shooting', 'wind', 'fireflies', 'water', 'watchtower', 'intro'] as const

// Wallpaper Engine's property names (in project.json) for each setting
const PROPERTIES: Record<string, keyof WallpaperSettings> = {
    showclock: 'clock', clockformat: 'hours', showseconds: 'seconds', showdate: 'date', showweather: 'weather',
    weatherlocation: 'location', temperatureunits: 'units', showhighlow: 'highLow', showplace: 'place',
    nowplaying: 'music', musicprogress: 'progress', musicposition: 'musicPosition', textsize: 'size',
    showvisualizer: 'visualizer', visualizerstyle: 'visualizerStyle', visualizerheight: 'visualizerHeight',
    visualizercolor: 'visualizerColor', visualizeropacity: 'visualizerOpacity',
    mouseparallax: 'parallax', parallaxstrength: 'strength', stillscenery: 'still',
    animateclouds: 'clouds', animatestars: 'stars', shootingstars: 'shooting', animatewind: 'wind',
    animatefireflies: 'fireflies', animatewater: 'water', animatewatchtower: 'watchtower', animatetext: 'intro',
}

// A value from Wallpaper Engine or the address bar as the setting's own type (undefined when it doesn't fit)
function read(key: keyof WallpaperSettings, value: unknown): unknown {
    const current = DEFAULTS[key]
    if (typeof current === 'boolean') {
        if (value === true || value === 'true' || value === '1') return true
        if (value === false || value === 'false' || value === '0') return false
        return undefined
    }
    if (typeof current === 'number') return value === '' || value == null || isNaN(Number(value)) ? undefined : Number(value)
    if (key === 'hours') return HOURS.find(o => o === String(value))
    if (key === 'units') return UNITS.find(o => o === String(value))
    if (key === 'music') return MUSIC.find(o => o === String(value))
    if (key === 'musicPosition') return MUSIC_POSITIONS.find(o => o === String(value))
    if (key === 'visualizerStyle') return VISUALIZER_STYLES.find(o => o === String(value))
    if (key === 'visualizerColor') return VISUALIZER_COLORS.find(o => o === String(value))
    return String(value ?? '')
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
    const fromQuery: Record<string, unknown> = {}
    for (const key of Object.keys(DEFAULTS) as (keyof WallpaperSettings)[]) {
        const value = query.has(key) ? read(key, query.get(key)) : undefined
        if (value !== undefined) fromQuery[key] = value
    }
    settings = { ...settings, ...fromQuery }

    window.wallpaperPropertyListener = {
        applyUserProperties(properties) {
            const changes: Record<string, unknown> = {}
            for (const [name, property] of Object.entries(properties)) {
                const key = PROPERTIES[name]
                const value = key && property ? read(key, property.value) : undefined
                if (value !== undefined) changes[key] = value
            }
            update(changes)
        },
        setPaused(paused) {
            update({ paused })
        },
    }
}
