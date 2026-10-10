// A plan's periods. Plain logic: period n of a plan runs from startsOn plus n intervals to the start of the
// next, always counted from startsOn rather than from the period before, so a plan that starts on the 31st
// bills on the last day of February and is back on the 31st in March.

import { addDays, addMonths, type Day } from './days'

export type Interval = 'MONTHLY' | 'YEARLY'

export const INTERVAL_MONTHS: Record<Interval, number> = { MONTHLY: 1, YEARLY: 12 }

export const INTERVAL_LABELS: Record<Interval, string> = { MONTHLY: 'month', YEARLY: 'year' }

export const isInterval = (value: unknown): value is Interval => value === 'MONTHLY' || value === 'YEARLY'

export type Period = { start: Day, end: Day }

// end is the last day inside the period, which is what a person means by "1 March to 31 March"
export function periodOf(plan: { startsOn: Day, interval: Interval }, index: number): Period {
    const months = INTERVAL_MONTHS[plan.interval]
    const start = addMonths(plan.startsOn, index * months)
    const next = addMonths(plan.startsOn, (index + 1) * months)
    return { start, end: addDays(next, -1) }
}

export const nextBillingDay = (plan: { startsOn: Day, interval: Interval, periodsBilled: number }): Day =>
    periodOf(plan, plan.periodsBilled).start

export type AutopayState = { paypalMode: string | null, subscriptionStatus: string | null }

// Paying automatically only counts in the PayPal mode the site is running: a subscription made in the
// sandbox moves no money, and must not stop a live invoice going out.
export function autopayActive(plan: AutopayState, mode: string | null): boolean {
    return !!mode && plan.paypalMode === mode && (plan.subscriptionStatus === 'ACTIVE' || plan.subscriptionStatus === 'APPROVED')
}

// A plan the billing run should raise an invoice for today
export function planDue(
    plan: { startsOn: Day, interval: Interval, periodsBilled: number, amountCents: number, endedAt: Date | null } & AutopayState,
    today: Day,
    mode: string | null,
): boolean {
    if (plan.endedAt || plan.amountCents <= 0) return false
    if (autopayActive(plan, mode)) return false
    return nextBillingDay(plan) <= today
}
