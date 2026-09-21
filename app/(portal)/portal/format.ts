import type { Status } from '@/server/quotes/labels'

// The server runs in UTC; Koda reads times in Queensland
const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })

export const formatWhen = (date: Date) => when.format(date)

export const STATUS_COLOURS: Record<Status, 'info' | 'default' | 'success' | 'error'> = {
    NEW: 'info',
    REPLIED: 'default',
    WON: 'success',
    LOST: 'error',
}
