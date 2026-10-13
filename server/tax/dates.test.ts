import { describe, expect, it } from 'vitest'

import { dueReminders, keyDates } from './dates'

const kinds = (today: string, sent: string[] = [], lodged: number[] = []) =>
    dueReminders(today, new Set(sent), year => lodged.includes(year)).map(reminder => reminder.key)

describe('key dates', () => {
    it('has the year\'s start and end, the return and the payment', () => {
        const dates = keyDates(2026, '2026-10-13', null)
        expect(dates.map(date => date.day)).toEqual(['2025-07-01', '2026-06-30', '2026-10-31', '2026-11-21'])
        expect(dates.map(date => date.state)).toEqual(['past', 'past', 'soon', 'upcoming'])
        expect(dates.every(date => date.year === 2026)).toBe(true)
    })

    it('calls a return late once it is past due, and done once lodged', () => {
        expect(keyDates(2026, '2026-11-02', null)[2].state).toBe('late')
        expect(keyDates(2026, '2026-11-02', '2026-10-20')[2].state).toBe('done')
    })
})

describe('reminders', () => {
    it('sends nothing on a quiet day', () => {
        expect(kinds('2026-08-15')).toEqual([])
    })

    it('reminds 30 days before the year ends, then 7, then once it has closed', () => {
        expect(kinds('2027-05-31')).toEqual(['eofy-30:2027'])
        expect(kinds('2027-06-23')).toEqual(['eofy-7:2027'])
        expect(kinds('2027-06-30')).toEqual(['eofy-7:2027'])
        expect(kinds('2027-07-01')).toEqual(['year-closed:2027'])
    })

    it('reminds about the return through October, and after it is late', () => {
        expect(kinds('2026-10-13')).toEqual(['return-30:2026'])
        expect(kinds('2026-10-25')).toEqual(['return-7:2026'])
        expect(kinds('2026-10-31')).toEqual(['return-due:2026'])
        expect(kinds('2026-11-05')).toEqual(['return-late:2026'])
        expect(kinds('2026-12-15')).toEqual([])
    })

    it('stops reminding about a return marked lodged', () => {
        expect(kinds('2026-10-25', [], [2026])).toEqual([])
    })

    it('sends only the latest of a group, and nothing already sent', () => {
        expect(kinds('2026-10-25', ['return-7:2026'])).toEqual([])
        expect(kinds('2026-10-25', ['return-30:2026'])).toEqual(['return-7:2026'])
    })
})
