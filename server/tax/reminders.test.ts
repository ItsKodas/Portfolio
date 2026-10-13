import { describe, expect, it, vi } from 'vitest'

import type { Email } from '../emails/layout'
import { createTaxReminders, type TaxReminderDeps } from './reminders'
import { NO_SETTINGS, summarise } from './summary'

// 10am in Brisbane on the given day
const at = (day: string, hour = 10) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+10:00`)

function setup(today: string, options: { hour?: number, sent?: string[], lodged?: number[], incomeCents?: number, failSend?: boolean } = {}) {
    const claimed = new Set(options.sent ?? [])
    const emails: Email[] = []
    const deps: TaxReminderDeps = {
        claim: async key => (claimed.has(key) ? false : (claimed.add(key), true)),
        release: async key => { claimed.delete(key) },
        sentAmong: async keys => new Set(keys.filter(key => claimed.has(key))),
        lodged: async year => (options.lodged ?? []).includes(year),
        summary: async (year, day) => summarise({
            year, today: day, entries: [], settings: NO_SETTINGS,
            payments: options.incomeCents ? [{ id: 'p', day: '2026-08-01', cents: options.incomeCents, invoiceId: 'i', invoiceNumber: 'INV-0001', who: 'Ann', method: 'PayPal' }] : [],
        }),
        send: async build => {
            if (options.failSend) throw new Error('relay down')
            emails.push(build({ from: 'Horizons <hello@horizons.gg>', to: 'koda@horizons.gg', siteUrl: 'https://www.horizons.gg' }))
        },
        record: vi.fn(async () => {}),
        now: () => at(today, options.hour ?? 10),
        log: vi.fn(),
    }
    return { run: createTaxReminders(deps).run, emails, claimed, deps }
}

describe('the tax reminder run', () => {
    it('emails the return reminder once, with a link to that year', async () => {
        const { run, emails } = setup('2026-10-13')
        expect(await run()).toEqual({ sent: 1 })
        expect(emails[0].to).toBe('koda@horizons.gg')
        expect(emails[0].subject).toBe('Your 2025-26 tax return is due in 18 days')
        expect(emails[0].html).toContain('/portal/tax?year=2026')
        expect(await run()).toEqual({ sent: 0 })
    })

    it('waits for business hours in Brisbane', async () => {
        const { run, emails } = setup('2026-10-13', { hour: 7 })
        expect(await run()).toEqual({ sent: 0 })
        expect(emails).toHaveLength(0)
    })

    it('says nothing about a return already lodged', async () => {
        const { run, emails } = setup('2026-10-13', { lodged: [2026] })
        await run()
        expect(emails).toHaveLength(0)
    })

    it('tries again next time when the email fails', async () => {
        const { run, claimed } = setup('2026-10-13', { failSend: true })
        expect(await run()).toEqual({ sent: 0 })
        expect(claimed.has('return-30:2026')).toBe(false)
    })

    it('warns once when turnover passes the GST threshold, and skips the nearing email', async () => {
        const { run, emails, claimed } = setup('2026-08-15', { incomeCents: 76_000_00 })
        expect(await run()).toEqual({ sent: 1 })
        expect(emails[0].subject).toContain('GST threshold')
        expect(claimed.has('gst-near:2027')).toBe(true)
        expect(await run()).toEqual({ sent: 0 })
    })

    it('does nothing without an address to send to', async () => {
        const { deps } = setup('2026-10-13')
        expect(await createTaxReminders({ ...deps, send: null }).run()).toEqual({ sent: 0 })
    })
})
