import { describe, expect, it } from 'vitest'

import { deliverQuoteEmails, type DeliverDeps, type DeliverableQuote } from './deliver'
import type { Email } from './emails'

const NOW = new Date('2026-09-20T01:00:00Z')

const quote: DeliverableQuote = {
    id: 'q1', createdAt: new Date('2026-09-20T00:00:00Z'), name: 'Ann', email: 'ann@example.com', company: null,
    website: null, projectType: null, budget: null, timeline: null, message: 'A new website please', referenceSites: [],
    notifiedAt: null, confirmedAt: null,
}

function fakes(options: { failTo?: string[], failMark?: boolean } = {}) {
    const sent: Email[] = []
    const marked: string[] = []
    const logged: string[] = []
    const deps: DeliverDeps = {
        send: async email => {
            if (options.failTo?.includes(email.to)) throw new Error('relay down')
            sent.push(email)
        },
        markNotified: async (id, at) => {
            if (options.failMark) throw new Error('db down')
            marked.push(`notified ${id} ${at.toISOString()}`)
        },
        markConfirmed: async (id, at) => {
            if (options.failMark) throw new Error('db down')
            marked.push(`confirmed ${id} ${at.toISOString()}`)
        },
        now: () => NOW,
        log: message => { logged.push(message) },
        mail: { from: 'Horizons <quotes@dev.horizons.gg>', notifyTo: 'koda@horizons.gg', replyTo: 'info@dev.horizons.gg', siteUrl: 'https://www.horizons.gg' },
    }
    return { deps, sent, marked, logged }
}

describe('deliverQuoteEmails', () => {
    it('sends both emails and records each one', async () => {
        const { deps, sent, marked } = fakes()
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: true, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['koda@horizons.gg', 'ann@example.com'])
        expect(marked).toEqual([`notified q1 ${NOW.toISOString()}`, `confirmed q1 ${NOW.toISOString()}`])
    })

    it('still sends the confirmation when the notification fails, and records only what was sent', async () => {
        const { deps, sent, marked, logged } = fakes({ failTo: ['koda@horizons.gg'] })
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: false, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['ann@example.com'])
        expect(marked).toEqual([`confirmed q1 ${NOW.toISOString()}`])
        expect(logged).toEqual(['Quote q1: the notification email was not sent'])
    })

    it('skips an email that was already sent, which is how a resend only sends the missing one', async () => {
        const { deps, sent } = fakes()
        const result = await deliverQuoteEmails({ ...quote, notifiedAt: NOW }, deps)
        expect(result).toEqual({ notified: true, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['ann@example.com'])
    })

    it('counts an email as sent even when recording it fails, and logs that', async () => {
        const { deps, logged } = fakes({ failMark: true })
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: true, confirmed: true })
        expect(logged).toEqual([
            'Quote q1: the notification email was sent but could not be recorded',
            'Quote q1: the confirmation email was sent but could not be recorded',
        ])
    })
})
