// The Australian financial year, 1 July to 30 June, named by the year it ends: 2027 is 1 July 2026 to 30 June
// 2027, written "2026-27". Plain logic on calendar days (server/invoices/days.ts), so the page, the reminders and
// the tests all draw the same lines.

import type { Day } from '../invoices/days'

export type FinancialYear = number

export const yearOf = (day: Day): FinancialYear => {
    const [year, month] = day.split('-').map(Number)
    return month >= 7 ? year + 1 : year
}

export const startOf = (year: FinancialYear): Day => `${year - 1}-07-01`
export const endOf = (year: FinancialYear): Day => `${year}-06-30`

export const yearLabel = (year: FinancialYear): string => `${year - 1}-${String(year % 100).padStart(2, '0')}`

export const within = (day: Day, year: FinancialYear): boolean => day >= startOf(year) && day <= endOf(year)

// 'YYYY-MM' for each month of the year, July first
export function monthsOf(year: FinancialYear): string[] {
    return Array.from({ length: 12 }, (_, index) => {
        const month = ((index + 6) % 12) + 1
        return `${month >= 7 ? year - 1 : year}-${String(month).padStart(2, '0')}`
    })
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const monthLabel = (month: string): string => MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month

// How far through the year a day is, from 0 on 1 July to 1 on 30 June, for projecting a year from part of it
export function shareElapsed(day: Day, year: FinancialYear): number {
    if (day < startOf(year)) return 0
    if (day > endOf(year)) return 1
    const start = Date.parse(`${startOf(year)}T00:00:00Z`)
    const end = Date.parse(`${endOf(year)}T00:00:00Z`)
    return (Date.parse(`${day}T00:00:00Z`) - start + 86_400_000) / (end - start + 86_400_000)
}
