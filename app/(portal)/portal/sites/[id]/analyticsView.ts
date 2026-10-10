// The arithmetic behind the analytics panel, kept out of the components so it can be tested without
// drawing anything.

import type { AnalyticsDay } from '@/server/hostd/analytics'

export type Summary = {
    // Every page view in the window
    visits: number
    // Each day's distinct visitors, added up: someone who came back on three days counts three times
    visitors: number
    today: AnalyticsDay | null
    // The day with the most visits, or null when there were none
    busiest: AnalyticsDay | null
}

export function summarise(days: AnalyticsDay[]): Summary {
    let busiest: AnalyticsDay | null = null
    for (const day of days) if (day.views > 0 && (busiest === null || day.views > busiest.views)) busiest = day
    return {
        visits: days.reduce((total, day) => total + day.views, 0),
        visitors: days.reduce((total, day) => total + day.visitors, 0),
        today: days.at(-1) ?? null,
        busiest,
    }
}

// The top of the y axis and the gridlines under it: a round step (1, 2 or 5 times a power of ten) that
// gives at most four lines, so the axis reads as 0, 50, 100, 150 rather than 0, 37, 74, 111.
export function scaleFor(max: number): { top: number, ticks: number[] } {
    if (max <= 0) return { top: 4, ticks: [0, 2, 4] }
    const rough = max / 4
    const power = 10 ** Math.floor(Math.log10(rough))
    const step = [1, 2, 5, 10].map(factor => factor * power).find(candidate => candidate >= rough) ?? 10 * power
    const whole = Math.max(1, step)
    const top = Math.ceil(max / whole) * whole
    const ticks: number[] = []
    for (let tick = 0; tick <= top; tick += whole) ticks.push(tick)
    return { top, ticks }
}

// A YYYY-MM-DD day as people say it. The date is already a calendar day in Brisbane, so it is formatted
// as the date it names, without moving it through any time zone.
const short = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const long = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })

export function dayLabel(date: string, style: 'short' | 'long' = 'short'): string {
    const at = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(at.getTime())) return date
    return (style === 'long' ? long : short).format(at)
}

const countries = new Intl.DisplayNames(['en'], { type: 'region' })

export function countryName(code: string): string {
    try {
        return countries.of(code) ?? code
    } catch {
        return code
    }
}

export const count = (value: number): string => value.toLocaleString('en-AU')
