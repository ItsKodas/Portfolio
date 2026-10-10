import { describe, expect, it } from 'vitest'

import { describeKeep, describeSchedule, latestFailure, manualBlock, newestFirst, runOf, timeOfDay } from './backupView'

const snapshot = (id: string, at: string, tag: 'manual' | 'scheduled' = 'manual') => ({ id, at, tag })
const run = (over: Record<string, unknown> = {}) => ({
    run: '0123456789abcdef',
    tag: 'manual' as const,
    actor: 'client',
    startedAt: '2026-10-05T16:00:00.000Z',
    durationMs: 42_000,
    outcome: 'ok' as const,
    snapshot: '4f1c2a9be7d0aa11',
    reason: null,
    disruptive: false,
    ...over,
})

const NOW = Date.parse('2026-10-06T08:00:00.000Z')

describe('newestFirst', () => {
    it('puts the latest copy at the top, whatever order restic gave', () => {
        const sorted = newestFirst([
            snapshot('aaaaaaaa', '2026-10-01T00:00:00Z'),
            snapshot('cccccccc', '2026-10-05T00:00:00Z'),
            snapshot('bbbbbbbb', '2026-10-03T00:00:00Z'),
        ])
        expect(sorted.map(one => one.id)).toEqual(['cccccccc', 'bbbbbbbb', 'aaaaaaaa'])
    })
})

describe('runOf', () => {
    it('matches the short id the list carries to the full id the run recorded', () => {
        expect(runOf(snapshot('4f1c2a9b', '2026-10-05T16:00:42Z'), [run()])).toMatchObject({ run: '0123456789abcdef' })
    })

    it('is null for a copy whose run has fallen out of the history, and never matches a failed run', () => {
        expect(runOf(snapshot('99999999', '2026-10-05T16:00:42Z'), [run(), run({ snapshot: null, outcome: 'failed' })])).toBeNull()
    })
})

describe('manualBlock', () => {
    it('allows a copy when there are fewer than five and none in the last ten minutes', () => {
        expect(manualBlock([snapshot('aaaaaaaa', '2026-10-01T00:00:00Z')], [run()], NOW)).toBeNull()
    })

    it('says to delete one when five made by hand already exist', () => {
        const five = ['a', 'b', 'c', 'd', 'e'].map(letter => snapshot(letter.repeat(8), '2026-10-01T00:00:00Z'))
        expect(manualBlock(five, [], NOW)).toMatch(/Delete one/)
    })

    it('does not count automatic copies against the five', () => {
        const five = ['a', 'b', 'c', 'd', 'e'].map(letter => snapshot(letter.repeat(8), '2026-10-01T00:00:00Z', 'scheduled'))
        expect(manualBlock(five, [], NOW)).toBeNull()
    })

    it('says to wait when one was made less than ten minutes ago, failed or not', () => {
        const recent = run({ startedAt: new Date(NOW - 4 * 60_000).toISOString(), outcome: 'failed', snapshot: null })
        expect(manualBlock([], [recent], NOW)).toMatch(/ten minutes/)
    })
})

describe('latestFailure', () => {
    it('is the newest run when it failed', () => {
        expect(latestFailure([run({ outcome: 'failed', snapshot: null }), run()])).toMatchObject({ outcome: 'failed' })
    })

    it('is null once a later run worked', () => {
        expect(latestFailure([run(), run({ outcome: 'failed', snapshot: null })])).toBeNull()
    })
})

describe('the schedule in words', () => {
    it('says the time the way a person would', () => {
        expect(timeOfDay(0, 0)).toBe('12:00 am')
        expect(timeOfDay(2, 30)).toBe('2:30 am')
        expect(timeOfDay(12, 0)).toBe('12:00 pm')
        expect(timeOfDay(23, 30)).toBe('11:30 pm')
    })

    it('describes each mode', () => {
        const base = { hour: 2, minute: 0, weekday: 3, keep: { daily: 7, weekly: 4, monthly: 1 } }
        expect(describeSchedule({ ...base, mode: 'off' })).toBe('No automatic copies are made.')
        expect(describeSchedule({ ...base, mode: 'daily' })).toBe('A copy is made every day at 2:00 am, Brisbane time.')
        expect(describeSchedule({ ...base, mode: 'weekly' })).toBe('A copy is made every Wednesday at 2:00 am, Brisbane time.')
        expect(describeKeep({ ...base, mode: 'daily' })).toBe('Keeps the last 7 daily copies, 4 weekly copies and 1 monthly copy.')
    })
})
