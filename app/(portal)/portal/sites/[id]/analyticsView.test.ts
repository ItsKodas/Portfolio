import { describe, expect, it } from 'vitest'

import { countryName, dayLabel, scaleFor, summarise } from './analyticsView'

describe('summarise', () => {
    it('adds the window up and finds its busiest day', () => {
        const summary = summarise([
            { date: '2026-10-08', views: 4, visitors: 2 },
            { date: '2026-10-09', views: 9, visitors: 5 },
            { date: '2026-10-10', views: 1, visitors: 1 },
        ])
        expect(summary).toEqual({
            visits: 14,
            visitors: 8,
            today: { date: '2026-10-10', views: 1, visitors: 1 },
            busiest: { date: '2026-10-09', views: 9, visitors: 5 },
        })
    })

    it('has no busiest day when nobody came', () => {
        expect(summarise([{ date: '2026-10-10', views: 0, visitors: 0 }]).busiest).toBeNull()
    })
})

describe('scaleFor', () => {
    it('rounds the top of the axis to a step people read easily', () => {
        expect(scaleFor(137)).toEqual({ top: 150, ticks: [0, 50, 100, 150] })
        expect(scaleFor(3)).toEqual({ top: 3, ticks: [0, 1, 2, 3] })
    })

    it('still draws an axis over a window with no visits', () => {
        expect(scaleFor(0).ticks.length).toBeGreaterThan(1)
    })
})

describe('labels', () => {
    it('says a day as the date it names, whatever zone the server is in', () => {
        expect(dayLabel('2026-10-10')).toBe('10 Oct')
        expect(dayLabel('2026-10-10', 'long')).toBe('Sat 10 October')
    })

    it('names a country from its code', () => {
        expect(countryName('AU')).toBe('Australia')
    })
})
