import type { Status } from '@/server/quotes/labels'

// The server runs in UTC; Koda reads times in Queensland
const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })

export const formatWhen = (date: Date) => when.format(date)

// The day alone, for a list a client reads. The minute a deploy landed is an operator's detail, and
// "21 September 2026" is how somebody says when their site was updated.
const day = new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeZone: 'Australia/Brisbane' })

export const formatDay = (date: Date) => day.format(date)

// ui/Chip has three tones and a neutral. NEW was MUI's `info` and REPLIED its `default`, and neither is a
// problem, so both take the neutral chip: warn would say something is wrong when nothing is. The word in
// the chip is what carries the status either way.
export const STATUS_TONES: Record<Status, 'good' | 'warn' | 'crit' | undefined> = {
    NEW: undefined,
    REPLIED: undefined,
    WON: 'good',
    LOST: 'crit',
}
