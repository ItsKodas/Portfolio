import { useEffect, useState } from 'react'

// The current weather for the wallpaper, from Open-Meteo (free, no key). The place is looked up by name with
// Open-Meteo's geocoding (a name, optionally narrowed with a country or region after a comma: "Perth, AU",
// "Perth, Scotland"), or, when none is set, found roughly from the IP address with GeoJS. The last reading is kept in
// local storage, so a restart shows it straight away while a fresh one is fetched.

export type Unit = 'celsius' | 'fahrenheit'

export type Weather = {
    temperature: number
    high: number
    low: number
    code: number  // WMO weather code
    day: boolean
    unit: Unit
    place?: string // the town it's for
}

const REFRESH_MS = 30 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
const STORAGE_KEY = 'wallpaper-weather-2' // (renamed whenever the stored reading changes shape)

type Place = { latitude: number, longitude: number, name?: string }

async function json(url: string) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${response.status} from ${url}`)
    return response.json()
}

async function locate(location: string): Promise<Place> {
    const [name, ...rest] = location.split(',').map(s => s.trim())
    if (!name) {
        const geo = await json('https://get.geojs.io/v1/ip/geo.json')
        return { latitude: Number(geo.latitude), longitude: Number(geo.longitude), name: geo.city || geo.region || geo.country }
    }

    const { results = [] } = await json(`https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(name)}`)
    const within = rest.join(',').toLowerCase()
    type Result = Place & { country_code?: string, country?: string, admin1?: string }
    const match = within
        ? (results as Result[]).find(r => [r.country_code, r.country, r.admin1].some(v => v?.toLowerCase() === within))
        : undefined
    const place = match ?? results[0]
    if (!place) throw new Error(`No place called ${location}`)
    return place
}

async function fetchWeather(location: string, unit: Unit): Promise<Weather> {
    const { latitude, longitude, name } = await locate(location)
    const data = await json('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'temperature_2m,weather_code,is_day',
        daily: 'temperature_2m_max,temperature_2m_min',
        temperature_unit: unit,
        timezone: 'auto',
        forecast_days: '1',
    }))
    return {
        temperature: Math.round(data.current.temperature_2m),
        high: Math.round(data.daily.temperature_2m_max[0]),
        low: Math.round(data.daily.temperature_2m_min[0]),
        code: data.current.weather_code,
        day: data.current.is_day === 1,
        unit,
        place: name,
    }
}

type Stored = { key: string, at: number, weather: Weather }

function load(key: string): Stored | undefined {
    try {
        const stored: Stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
        return stored?.key === key ? stored : undefined
    } catch { return undefined }
}

function save(stored: Stored) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)) } catch {}
}

// The weather for a place, kept up to date while enabled (null until the first reading)
export function useWeather(enabled: boolean, location: string, unit: Unit) {
    const [weather, setWeather] = useState<Weather | null>(null)

    useEffect(() => {
        if (!enabled) return
        const key = `${location.trim().toLowerCase()}|${unit}`
        let timer = 0, cancelled = false

        const refresh = async () => {
            try {
                const fresh = await fetchWeather(location, unit)
                if (cancelled) return
                save({ key, at: Date.now(), weather: fresh })
                setWeather(fresh)
                timer = window.setTimeout(refresh, REFRESH_MS)
            } catch (error) {
                console.warn('Weather unavailable:', error)
                if (!cancelled) timer = window.setTimeout(refresh, RETRY_MS)
            }
        }

        const stored = load(key)
        setWeather(stored?.weather ?? null)
        const age = stored ? Date.now() - stored.at : Infinity
        if (age < REFRESH_MS) timer = window.setTimeout(refresh, REFRESH_MS - age)
        else refresh()

        return () => { cancelled = true; clearTimeout(timer) }
    }, [enabled, location, unit])

    return enabled ? weather : null
}

// What the WMO code describes, in a word or two
export function describe(code: number) {
    if (code === 0) return 'Clear'
    if (code === 1) return 'Mostly clear'
    if (code === 2) return 'Partly cloudy'
    if (code === 3) return 'Overcast'
    if (code === 45 || code === 48) return 'Fog'
    if (code >= 51 && code <= 55) return 'Drizzle'
    if (code === 56 || code === 57) return 'Freezing drizzle'
    if (code === 61) return 'Light rain'
    if (code === 63) return 'Rain'
    if (code === 65) return 'Heavy rain'
    if (code === 66 || code === 67) return 'Freezing rain'
    if (code >= 71 && code <= 77) return 'Snow'
    if (code >= 80 && code <= 82) return 'Showers'
    if (code === 85 || code === 86) return 'Snow showers'
    if (code >= 95) return 'Thunderstorms'
    return ''
}
