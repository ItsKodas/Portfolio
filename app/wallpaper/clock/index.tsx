'use client'

// The wallpaper's centrepiece: the time, with the day and date and the weather beneath, centred on the screen. Laid out
// at a natural size and scaled with the screen (to fit the smaller of its width and height), and centred as a whole, so
// whichever lines are showing stay in the middle.

import { useEffect, useRef, useState } from 'react'
import { AcUnit, Cloud, Dehaze, FilterDrama, Grain, NightsStay, Place, Thunderstorm, WaterDrop, WbSunny } from '@mui/icons-material'

import { useSettings } from '../settings'
import { describe, useWeather, type Unit, type Weather } from '../weather'
import styles from './clock.module.css'

const NATURAL_WIDTH = 960
// The screen size the block is drawn at its natural size for (a 1080p screen shows it a little smaller)
const DESIGN_WIDTH = 2000
const DESIGN_HEIGHT = 1125

// The current time, updated as the minute turns, or each second when they're showing (checked a few times a second, so
// it catches up straight after a sleep and the seconds never skip one)
function useNow(seconds: boolean) {
    const [now, setNow] = useState<Date | null>(null)
    useEffect(() => {
        const step = seconds ? 1000 : 60_000
        const tick = () => setNow(last => {
            const next = new Date()
            return last && Math.floor(last.getTime() / step) === Math.floor(next.getTime() / step) ? last : next
        })
        tick()
        const timer = setInterval(tick, 250)
        return () => clearInterval(timer)
    }, [seconds])
    return now
}

const REGIONS_IN_FAHRENHEIT = ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH']

function localUnit(): Unit {
    try {
        const region = new Intl.Locale(navigator.language).maximize().region ?? ''
        return REGIONS_IN_FAHRENHEIT.includes(region) ? 'fahrenheit' : 'celsius'
    } catch { return 'celsius' }
}

function WeatherIcon({ weather }: { weather: Weather }) {
    const { code, day } = weather
    const Icon =
        code <= 1 ? (day ? WbSunny : NightsStay) :
        code === 2 ? (day ? FilterDrama : NightsStay) :
        code === 3 ? Cloud :
        code === 45 || code === 48 ? Dehaze :
        code >= 51 && code <= 57 ? Grain :
        (code >= 71 && code <= 77) || code === 85 || code === 86 ? AcUnit :
        code >= 95 ? Thunderstorm :
        WaterDrop
    return <Icon className={styles.icon} />
}

export default function Clock() {
    const { clock, hours, seconds, date, weather: showWeather, location, units, highLow, place, size } = useSettings()
    const now = useNow(clock && seconds)
    const weather = useWeather(showWeather, location, units === 'auto' ? localUnit() : units)

    // Scaled with the screen
    const screenRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(1)
    useEffect(() => {
        const screen = screenRef.current
        if (!screen) return
        const observer = new ResizeObserver(() => setScale(Math.min(screen.offsetWidth / DESIGN_WIDTH, screen.offsetHeight / DESIGN_HEIGHT)))
        observer.observe(screen)
        return () => observer.disconnect()
    }, [])

    // (a 24-hour clock reads 09:05, a 12-hour one 9:05 am)
    const hour12 = hours === 'auto' ? new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 : hours === '12'
    const time = now && new Intl.DateTimeFormat(undefined, hour12
        ? { hour: 'numeric', minute: '2-digit', ...(seconds && { second: '2-digit' as const }), hour12: true }
        : { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' as const }), hourCycle: 'h23' }).formatToParts(now)
    const clockText = time?.filter(p => p.type !== 'dayPeriod').map(p => p.value).join('').trim()
    const period = time?.find(p => p.type === 'dayPeriod')?.value
    const dateText = now && new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now)

    return (
        <div ref={screenRef} className={styles.screen}>
            <div className={`${styles.block} select-none`} style={{ width: NATURAL_WIDTH, transform: `translate(-50%, -50%) scale(${scale * size / 100})` }}>
                {clock && clockText && (
                    <div className={`${styles.time} ${styles.rise}`}>
                        {clockText}
                        {period && <span className={styles.periodAnchor}><span className={styles.period}>{period}</span></span>}
                    </div>
                )}
                {date && dateText && <div className={`${styles.date} ${styles.rise}`} style={{ animationDelay: '0.25s' }}>{dateText}</div>}
                {/* (room kept for the weather until it arrives, so the lines above don't jump when it does) */}
                {showWeather && !weather && <div className={styles.weather} aria-hidden />}
                {weather && (
                    <div className={`${styles.weather} ${styles.rise}`} style={{ animationDelay: '0.5s' }}>
                        <WeatherIcon weather={weather} />
                        <span className={styles.temperature}>{weather.temperature}°</span>
                        <span>{describe(weather.code)}</span>
                        {highLow && <span className={styles.range}>H {weather.high}° · L {weather.low}°</span>}
                        {place && weather.place && (
                            <span className={styles.place}><Place className={styles.pin} />{weather.place}</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
