// Calendar days, as 'YYYY-MM-DD'. An invoice is due on a day, not at an instant, and the day is Brisbane's:
// the server runs in UTC, and an invoice due "today" must not turn overdue at ten in the morning. Plain
// logic with no imports, so the pages, the PDF and the billing run all count days the same way.

export type Day = string

const ZONE = 'Australia/Brisbane'

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const isDay = (value: unknown): value is Day => {
    if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// en-CA formats as YYYY-MM-DD, which is the one locale that writes a date the way this file stores one
const brisbane = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
const brisbaneHour = new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' })

export const todayIn = (now: Date): Day => brisbane.format(now)

export const hourIn = (now: Date): number => Number(brisbaneHour.format(now))

// Prisma hands a @db.Date column back as midnight UTC on that day, and wants the same shape given to it
export const dayOf = (date: Date): Day => date.toISOString().slice(0, 10)
export const dateOf = (day: Day): Date => new Date(`${day}T00:00:00Z`)

export function addDays(day: Day, days: number): Day {
    const date = dateOf(day)
    date.setUTCDate(date.getUTCDate() + days)
    return dayOf(date)
}

// Whole months on from a day, landing on the last day of a month that is too short rather than spilling
// into the next one: a month after 31 January is 28 (or 29) February, not 3 March.
export function addMonths(day: Day, months: number): Day {
    const [year, month, date] = day.split('-').map(Number)
    const target = new Date(Date.UTC(year, month - 1 + months, 1))
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    target.setUTCDate(Math.min(date, last))
    return dayOf(target)
}

export const daysBetween = (from: Day, to: Day): number =>
    Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / 86_400_000)

const long = new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeZone: 'UTC' })
const medium = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' })

// UTC on purpose: the day is already the day, and formatting it in any other zone could move it
export const formatDay = (day: Day): string => long.format(dateOf(day))
export const formatDayShort = (day: Day): string => medium.format(dateOf(day))
