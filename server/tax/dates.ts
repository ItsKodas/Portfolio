// The dates in a sole trader's tax year, and which reminder emails each one sends and when. Plain logic, so
// the Dates tab and the hourly run read the same calendar.

import { addDays, daysBetween, type Day } from '../invoices/days'
import { endOf, startOf, yearLabel, yearOf, type FinancialYear } from './year'

export const returnDueOf = (year: FinancialYear): Day => `${year}-10-31`
export const paymentDueOf = (year: FinancialYear): Day => `${year}-11-21`

export type DateState = 'done' | 'soon' | 'upcoming' | 'late' | 'past'

export type KeyDate = { day: Day, year: FinancialYear, title: string, detail: string, state: DateState }

// How close a date has to be to be called soon
const SOON_DAYS = 30

function stateOf(day: Day, today: Day, done = false, mustAct = false): DateState {
    if (done) return 'done'
    if (today > day) return mustAct ? 'late' : 'past'
    return daysBetween(today, day) <= SOON_DAYS ? 'soon' : 'upcoming'
}

export function keyDates(year: FinancialYear, today: Day, lodgedOn: Day | null): KeyDate[] {
    const label = yearLabel(year)
    const dates: Omit<KeyDate, 'year'>[] = [
        {
            day: startOf(year), title: `${label} starts`,
            detail: 'Income received and expenses paid from today count in this year.',
            state: stateOf(startOf(year), today),
        },
        {
            day: endOf(year), title: 'End of financial year',
            detail: 'The last day for an expense to count this year. Paying a deductible bill before it brings the deduction forward.',
            state: stateOf(endOf(year), today),
        },
        {
            day: returnDueOf(year), title: 'Tax return due',
            detail: lodgedOn
                ? 'Lodged. Nothing more to do for this year.'
                : 'If you lodge it yourself through myGov. A registered tax agent can lodge later, if they have you on their books before this date.',
            state: stateOf(returnDueOf(year), today, !!lodgedOn, true),
        },
        {
            day: paymentDueOf(year), title: 'Tax owing is due',
            detail: 'For a return you lodged yourself on time, or 21 days after the assessment if that is later.',
            state: stateOf(paymentDueOf(year), today),
        },
    ]
    return dates.map(date => ({ ...date, year }))
}

// A reminder email, named by a key that includes its year so each goes once. Within a group only the latest
// one due is sent: a server that was down for the 30-day reminder sends the 7-day one, not both.
export type ReminderKind = 'eofy-30' | 'eofy-7' | 'year-closed' | 'return-30' | 'return-7' | 'return-due' | 'return-late'

export type Reminder = { key: string, kind: ReminderKind, group: string, year: FinancialYear, from: Day, until: Day }

function remindersOf(year: FinancialYear): Reminder[] {
    const end = endOf(year)
    const due = returnDueOf(year)
    const item = (kind: ReminderKind, group: string, from: Day, until: Day): Reminder =>
        ({ key: `${kind}:${year}`, kind, group: `${group}:${year}`, year, from, until })
    return [
        item('eofy-30', 'eofy', addDays(end, -30), addDays(end, -8)),
        item('eofy-7', 'eofy', addDays(end, -7), end),
        item('year-closed', 'closed', addDays(end, 1), addDays(end, 30)),
        item('return-30', 'return', addDays(due, -30), addDays(due, -8)),
        item('return-7', 'return', addDays(due, -7), addDays(due, -1)),
        item('return-due', 'return', due, due),
        item('return-late', 'return', addDays(due, 1), addDays(due, 30)),
    ]
}

const RETURN_KINDS: ReminderKind[] = ['return-30', 'return-7', 'return-due', 'return-late']

// The reminders due today that have not gone yet. A return reminder stops once that year is marked lodged.
export function dueReminders(today: Day, sent: Set<string>, lodged: (year: FinancialYear) => boolean): Reminder[] {
    const current = yearOf(today)
    const candidates = [current - 1, current]
        .flatMap(remindersOf)
        .filter(reminder => today >= reminder.from && today <= reminder.until)
        .filter(reminder => !(RETURN_KINDS.includes(reminder.kind) && lodged(reminder.year)))

    const latest = new Map<string, Reminder>()
    for (const reminder of candidates) latest.set(reminder.group, reminder)
    return [...latest.values()].filter(reminder => !sent.has(reminder.key))
}

// The GST warnings go once each per financial year, when the turnover first reaches each level
export const gstKey = (level: 'near' | 'over', year: FinancialYear) => `gst-${level}:${year}`
