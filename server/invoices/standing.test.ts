import { describe, expect, it } from 'vitest'

import { invoiceNumber, isStanding, standingOf } from './standing'

describe('standingOf', () => {
    it('is overdue the day after the due date, not on it', () => {
        expect(standingOf({ status: 'OPEN', dueOn: '2026-10-10' }, '2026-10-10')).toBe('due')
        expect(standingOf({ status: 'OPEN', dueOn: '2026-10-10' }, '2026-10-11')).toBe('overdue')
    })

    it('takes the stored status for everything else', () => {
        expect(standingOf({ status: 'PAID', dueOn: '2020-01-01' }, '2026-10-10')).toBe('paid')
        expect(standingOf({ status: 'VOID', dueOn: '2020-01-01' }, '2026-10-10')).toBe('void')
        expect(standingOf({ status: 'DRAFT', dueOn: '2020-01-01' }, '2026-10-10')).toBe('draft')
    })
})

describe('invoiceNumber', () => {
    it('pads to four places, and names a draft as one', () => {
        expect(invoiceNumber(42)).toBe('INV-0042')
        expect(invoiceNumber(12_345)).toBe('INV-12345')
        expect(invoiceNumber(null)).toBe('Draft')
    })
})

describe('isStanding', () => {
    it('only accepts the five', () => {
        expect(isStanding('overdue')).toBe(true)
        expect(isStanding('OPEN')).toBe(false)
        expect(isStanding(undefined)).toBe(false)
    })
})
