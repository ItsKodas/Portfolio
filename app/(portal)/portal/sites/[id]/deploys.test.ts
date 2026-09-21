import { describe, expect, it } from 'vitest'

import type { DeployHistory, DeployOutcome, DeployRecord } from '@/server/hostd/deploys'
import { formatDuration, outcomeTone, outcomeWord, rollbackTarget, shortCommit, updatesFor } from './deploys'

const record = (over: Partial<DeployRecord> = {}): DeployRecord => ({
    commit: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
    subject: 'Fix the booking form',
    actor: 'hostd',
    trigger: 'poll',
    startedAt: '2026-09-21T11:06:00.000Z',
    durationMs: 74_000,
    outcome: 'ok',
    reason: null,
    output: null,
    ...over,
})

const history = (over: Partial<DeployHistory> = {}): DeployHistory => ({
    environment: 'live',
    branch: 'main',
    deployed: null,
    paused: false,
    consecutiveFailures: 0,
    deploys: [],
    ...over,
})

describe('the commit a rollback would go back to', () => {
    it('is the newest healthy one that is not the one serving now', () => {
        // The same rule hostd applies in lastHealthyCommit. It is mirrored here only so the button can
        // name the commit before it is pressed: hostd still decides, and is asked for no particular one.
        const view = history({
            deployed: 'ccc',
            deploys: [record({ commit: 'ccc' }), record({ commit: 'bbb' }), record({ commit: 'aaa' })],
        })
        expect(rollbackTarget(view)).toBe('bbb')
    })

    it('skips the ones that did not stay up', () => {
        const view = history({
            deployed: 'ddd',
            deploys: [
                record({ commit: 'ddd' }),
                record({ commit: 'ccc', outcome: 'failed' }),
                record({ commit: 'bbb', outcome: 'rolled-back' }),
                record({ commit: 'aaa' }),
            ],
        })
        expect(rollbackTarget(view)).toBe('aaa')
    })

    it('is nothing at all when this is the only deploy that ever worked', () => {
        expect(rollbackTarget(history({ deployed: 'aaa', deploys: [record({ commit: 'aaa' })] }))).toBeNull()
        expect(rollbackTarget(history())).toBeNull()
    })

    it('does not count a healthy deploy of the commit already serving, however many there are', () => {
        // Deploying the same commit twice is ordinary: neither of them is somewhere to go back to.
        const view = history({ deployed: 'aaa', deploys: [record({ commit: 'aaa' }), record({ commit: 'aaa' })] })
        expect(rollbackTarget(view)).toBeNull()
    })
})

describe('how long it took', () => {
    it('reads in minutes and seconds', () => {
        expect(formatDuration(74_000)).toBe('1m 14s')
        expect(formatDuration(12_000)).toBe('12s')
        expect(formatDuration(60_000)).toBe('1m 0s')
    })

    it('grows an hour when a build takes one', () => {
        expect(formatDuration(3_845_000)).toBe('1h 4m')
    })

    it('says something rather than 0s for a deploy that barely started', () => {
        // A deploy that fell over immediately reports a duration under a second, and "0s" reads as a
        // missing figure rather than a fast one. It has to fit ui/Row's 58px meta column beside 1m 14s,
        // so it is this and not a sentence.
        expect(formatDuration(0)).toBe('<1s')
        expect(formatDuration(940)).toBe('<1s')
    })
})

describe('how an outcome reads', () => {
    it('gives each one a word and a tone of its own', () => {
        const outcomes: DeployOutcome[] = ['ok', 'failed', 'rolled-back']
        expect(outcomes.map(outcomeWord)).toEqual(['deployed', 'failed', 'rolled back'])
        expect(outcomes.map(outcomeTone)).toEqual(['good', 'crit', 'warn'])
    })

    it('shows a commit at the length everyone reads one at', () => {
        expect(shortCommit('5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3')).toBe('5f0ac31')
        expect(shortCommit('5f0ac')).toBe('5f0ac')
        expect(shortCommit('')).toBe('')
    })
})

describe('what a client is shown', () => {
    it('is only the deploys that reached their site and stayed there', () => {
        // A build that failed and one that was put back are not updates: from outside, neither happened.
        const view = history({
            deploys: [
                record({ commit: 'ddd', outcome: 'failed' }),
                record({ commit: 'ccc', outcome: 'rolled-back' }),
                record({ commit: 'bbb' }),
            ],
        })
        expect(updatesFor(view).map(update => update.commit)).toEqual(['bbb'])
    })

    it('has nothing to show for a site that has never had a good deploy', () => {
        expect(updatesFor(history({ deploys: [record({ outcome: 'failed' })] }))).toEqual([])
    })
})
