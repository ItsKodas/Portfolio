import { describe, expect, it } from 'vitest'

import { submitQuote, type SubmitDeps } from './submit'

const NOW = new Date('2026-09-20T01:00:00Z')
const valid = { name: 'Ann', email: 'ann@example.com', message: 'A new website please', turnstileToken: 'token', fax: '' }

function fakes(overrides: Partial<SubmitDeps> = {}) {
    const events: string[] = []
    const tasks: (() => Promise<void>)[] = []
    const deps: SubmitDeps = {
        verifyTurnstile: async token => { events.push(`turnstile ${token}`); return true },
        hashIp: ip => `hash(${ip})`,
        countRecent: async (ipHash, since) => { events.push(`count ${ipHash} since ${since.toISOString()}`); return 0 },
        save: async input => { events.push(`save ${input.name}`); return { id: 'q1' } },
        afterResponse: task => { events.push('scheduled'); tasks.push(task) },
        deliver: async id => { events.push(`deliver ${id}`) },
        now: () => NOW,
        log: message => { events.push(`log ${message}`) },
        ...overrides,
    }
    // Runs what would run after the response, as after() would
    const flush = async () => { for (const task of tasks) await task() }
    return { deps, events, flush }
}

describe('submitQuote', () => {
    it('checks, saves, and only then schedules the emails for after the response', async () => {
        const { deps, events, flush } = fakes()
        expect(await submitQuote(valid, '203.0.113.9', deps)).toEqual({ ok: true })
        expect(events).toEqual([
            'turnstile token',
            'count hash(203.0.113.9) since 2026-09-20T00:00:00.000Z',
            'save Ann',
            'scheduled',
        ])
        await flush()
        expect(events.at(-1)).toBe('deliver q1')
    })

    it('reports success to a bot that fills in the honeypot, and does nothing else', async () => {
        const { deps, events } = fakes()
        expect(await submitQuote({ ...valid, fax: '555 1234' }, 'ip', deps)).toEqual({ ok: true })
        expect(events).toEqual([])
    })

    it('stops at a failed or broken Turnstile check', async () => {
        const failed = fakes({ verifyTurnstile: async () => false })
        expect(await submitQuote(valid, 'ip', failed.deps)).toEqual({ ok: false, reason: 'turnstile' })
        expect(failed.events).toEqual([])

        const broken = fakes({ verifyTurnstile: async () => { throw new Error('TURNSTILE_SECRET_KEY is not set') } })
        expect(await submitQuote(valid, 'ip', broken.deps)).toEqual({ ok: false, reason: 'turnstile' })
        expect(broken.events).toEqual(['log Turnstile check failed'])
    })

    it('refuses the sixth quote from one IP within the hour', async () => {
        const { deps, events } = fakes({ countRecent: async () => 5 })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'rate-limited' })
        expect(events.some(event => event.startsWith('save'))).toBe(false)
    })

    it('allows the fifth', async () => {
        const { deps } = fakes({ countRecent: async () => 4 })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: true })
    })

    it('returns field errors for invalid input, without saving', async () => {
        const { deps, events } = fakes()
        expect(await submitQuote({ ...valid, email: 'nope' }, 'ip', deps)).toEqual({
            ok: false, reason: 'invalid', fieldErrors: { email: 'Please enter a valid email address' },
        })
        expect(events.some(event => event.startsWith('save'))).toBe(false)
    })

    it('saves the validated values, not the raw ones, with the IP hash', async () => {
        let saved: unknown
        const { deps } = fakes({ save: async (input, ipHash) => { saved = { input, ipHash }; return { id: 'q1' } } })
        await submitQuote({ ...valid, name: '  Ann  ', company: '' }, 'ip', deps)
        expect(saved).toEqual({
            ipHash: 'hash(ip)',
            input: { name: 'Ann', email: 'ann@example.com', message: 'A new website please', company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [] },
        })
    })

    it('reports a server error, and schedules nothing, when saving fails', async () => {
        const { deps, events } = fakes({ save: async () => { throw new Error('db down') } })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'server' })
        expect(events).not.toContain('scheduled')
        expect(events).toContain('log Saving a quote failed')
    })

    it('reports a server error when the rate limit cannot be checked', async () => {
        const { deps } = fakes({ countRecent: async () => { throw new Error('db down') } })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'server' })
    })

    it('logs, rather than throws, when sending the emails fails after the response', async () => {
        const { deps, events, flush } = fakes({ deliver: async () => { throw new Error('no settings') } })
        await submitQuote(valid, 'ip', deps)
        await flush()
        expect(events.at(-1)).toBe('log Quote q1: sending its emails failed')
    })

    it('copes with input that is not an object', async () => {
        const { deps } = fakes({ verifyTurnstile: async token => token !== '' })
        expect(await submitQuote(null, 'ip', deps)).toEqual({ ok: false, reason: 'turnstile' })
    })
})
