import { describe, expect, it } from 'vitest'

import { addDays, addMonths, daysBetween, formatDay, hourIn, isDay, todayIn } from './days'

describe('todayIn', () => {
    it('counts the day in Brisbane, not UTC', () => {
        // 15:00 UTC on the 9th is 01:00 on the 10th in Brisbane
        expect(todayIn(new Date('2026-10-09T15:00:00Z'))).toBe('2026-10-10')
        expect(todayIn(new Date('2026-10-09T13:59:00Z'))).toBe('2026-10-09')
        expect(hourIn(new Date('2026-10-09T15:00:00Z'))).toBe(1)
    })
})

describe('addMonths', () => {
    it('lands on the last day of a month that is too short', () => {
        expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
        expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
        expect(addMonths('2026-01-31', 2)).toBe('2026-03-31')
    })

    it('crosses years', () => {
        expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
        expect(addMonths('2026-10-10', 12)).toBe('2027-10-10')
    })
})

describe('days', () => {
    it('adds and counts days across a month', () => {
        expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
        expect(addDays('2026-10-01', -1)).toBe('2026-09-30')
        expect(daysBetween('2026-10-10', '2026-10-24')).toBe(14)
    })

    it('only accepts real days', () => {
        expect(isDay('2026-02-28')).toBe(true)
        expect(isDay('2026-02-30')).toBe(false)
        expect(isDay('26-2-1')).toBe(false)
        expect(isDay(20261010)).toBe(false)
    })

    it('writes a day the way an Australian reads it, without moving it', () => {
        expect(formatDay('2026-10-24')).toBe('24 October 2026')
    })
})
