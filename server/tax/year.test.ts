import { describe, expect, it } from 'vitest'

import { endOf, monthsOf, shareElapsed, startOf, within, yearLabel, yearOf } from './year'

describe('the financial year', () => {
    it('runs from 1 July to 30 June and is named by the year it ends', () => {
        expect(yearOf('2026-06-30')).toBe(2026)
        expect(yearOf('2026-07-01')).toBe(2027)
        expect(startOf(2027)).toBe('2026-07-01')
        expect(endOf(2027)).toBe('2027-06-30')
        expect(yearLabel(2027)).toBe('2026-27')
        expect(yearLabel(2100)).toBe('2099-00')
    })

    it('lists its months from July', () => {
        const months = monthsOf(2027)
        expect(months).toHaveLength(12)
        expect(months[0]).toBe('2026-07')
        expect(months[5]).toBe('2026-12')
        expect(months[6]).toBe('2027-01')
        expect(months[11]).toBe('2027-06')
    })

    it('knows which days are inside it', () => {
        expect(within('2026-07-01', 2027)).toBe(true)
        expect(within('2027-06-30', 2027)).toBe(true)
        expect(within('2026-06-30', 2027)).toBe(false)
    })

    it('says how much of it has gone, counting today', () => {
        expect(shareElapsed('2026-06-01', 2027)).toBe(0)
        expect(shareElapsed('2027-06-30', 2027)).toBe(1)
        expect(shareElapsed('2026-07-01', 2027)).toBeCloseTo(1 / 365)
        expect(shareElapsed('2026-12-31', 2027)).toBeCloseTo(184 / 365)
    })
})
