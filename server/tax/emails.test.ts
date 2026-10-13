import { describe, expect, it } from 'vitest'

import type { ReminderKind } from './dates'
import { gstEmail, reminderEmail } from './emails'
import { NO_SETTINGS, summarise } from './summary'

const options = { from: 'Horizons <hello@horizons.gg>', to: 'koda@horizons.gg', siteUrl: 'https://www.horizons.gg' }

const summary = summarise({
    year: 2027, today: '2027-06-20', entries: [], settings: NO_SETTINGS,
    payments: [{ id: 'p', day: '2026-08-01', cents: 40_000_00, invoiceId: 'i', invoiceNumber: 'INV-0001', who: 'Ann', method: 'PayPal' }],
})

const KINDS: ReminderKind[] = ['eofy-30', 'eofy-7', 'year-closed', 'return-30', 'return-7', 'return-due', 'return-late']

describe('tax emails', () => {
    it('goes to the operator, links to the year and carries the figures', () => {
        for (const kind of KINDS) {
            const email = reminderEmail(kind, summary, '2027-06-20', options)
            expect(email.to).toBe('koda@horizons.gg')
            expect(email.text).toContain('https://www.horizons.gg/portal/tax?year=2027')
            expect(email.text).toContain('$40,000.00')
            expect(email.text).toContain('not tax advice')
        }
    })

    it('counts the days left to the end of the year', () => {
        expect(reminderEmail('eofy-7', summary, '2027-06-20', options).subject).toBe('10 days until the end of the 2026-27 financial year')
        expect(reminderEmail('eofy-7', summary, '2027-06-29', options).subject).toBe('1 day until the end of the 2026-27 financial year')
    })

    it('words the GST warnings for nearing and reaching the threshold', () => {
        expect(gstEmail('near', summary, options).subject).toBe('Turnover is nearing the $75,000 GST threshold')
        expect(gstEmail('over', summary, options).text).toContain('within 21 days')
    })
})
