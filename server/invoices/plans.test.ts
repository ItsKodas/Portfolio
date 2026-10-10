import { describe, expect, it } from 'vitest'

import { autopayActive, nextBillingDay, periodOf, planDue } from './plans'

const plan = {
    startsOn: '2026-01-31', interval: 'MONTHLY' as const, periodsBilled: 0, amountCents: 4_900, endedAt: null,
    paypalMode: null, subscriptionStatus: null,
}

describe('periodOf', () => {
    it('counts every period from the start, so a short month does not drag the rest', () => {
        expect(periodOf(plan, 0)).toEqual({ start: '2026-01-31', end: '2026-02-27' })
        expect(periodOf(plan, 1)).toEqual({ start: '2026-02-28', end: '2026-03-30' })
        expect(periodOf(plan, 2)).toEqual({ start: '2026-03-31', end: '2026-04-29' })
    })

    it('runs a year at a time for a yearly plan', () => {
        expect(periodOf({ startsOn: '2026-10-10', interval: 'YEARLY' }, 1)).toEqual({ start: '2027-10-10', end: '2028-10-09' })
    })
})

describe('planDue', () => {
    it('is due on the day its next period starts, and not before', () => {
        expect(planDue(plan, '2026-01-30', 'sandbox')).toBe(false)
        expect(planDue(plan, '2026-01-31', 'sandbox')).toBe(true)
        expect(nextBillingDay({ ...plan, periodsBilled: 1 })).toBe('2026-02-28')
        expect(planDue({ ...plan, periodsBilled: 1 }, '2026-02-01', 'sandbox')).toBe(false)
    })

    it('never invoices a free plan or an ended one', () => {
        expect(planDue({ ...plan, amountCents: 0 }, '2026-06-01', 'sandbox')).toBe(false)
        expect(planDue({ ...plan, endedAt: new Date() }, '2026-06-01', 'sandbox')).toBe(false)
    })

    it('leaves a plan that pays itself to PayPal, but only in the mode it was set up in', () => {
        const paying = { ...plan, paypalMode: 'sandbox', subscriptionStatus: 'ACTIVE' }
        expect(planDue(paying, '2026-06-01', 'sandbox')).toBe(false)
        expect(planDue(paying, '2026-06-01', 'live')).toBe(true)
        expect(planDue({ ...paying, subscriptionStatus: 'SUSPENDED' }, '2026-06-01', 'sandbox')).toBe(true)
        expect(autopayActive(paying, null)).toBe(false)
    })
})
