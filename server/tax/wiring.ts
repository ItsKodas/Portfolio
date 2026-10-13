// Connects tax tracking to the real database, relay and clock. The only file that does, so everything else can
// be tested with stand-ins. Same role as server/invoices/wiring.ts.

import 'server-only'

import { record } from '../audit/record'
import { getDb } from '../db'
import { smtpConfig } from '../env'
import type { Day } from '../invoices/days'
import { createMailer } from '../mailer'
import { createTaxReminders } from './reminders'
import { spanFor, taxRepo } from './repo'
import { summarise, type YearSummary } from './summary'
import type { FinancialYear } from './year'

export function log(message: string, error?: unknown) {
    console.error(`[tax] ${message}`, error ?? '')
}

export const tax = () => taxRepo(getDb())

// Where the reminders go: TAX_NOTIFY_TO, else the operator's own sign-in address, else where new quotes go
export function reminderAddress(env: Record<string, string | undefined> = process.env): string | null {
    for (const name of ['TAX_NOTIFY_TO', 'ADMIN_EMAIL', 'QUOTE_NOTIFY_TO']) {
        const value = env[name]?.trim()
        if (value) return value
    }
    return null
}

export async function yearSummary(year: FinancialYear, today: Day): Promise<YearSummary> {
    const repo = tax()
    const { from, to } = spanFor(year, today)
    const [payments, entries, settings] = await Promise.all([repo.payments(from, to), repo.entries(from, to), repo.settings(year)])
    return summarise({ year, today, payments, entries, settings })
}

export function taxReminders() {
    const repo = tax()
    const to = reminderAddress()
    return createTaxReminders({
        claim: repo.claimReminder,
        release: repo.releaseReminder,
        sentAmong: repo.sentAmong,
        lodged: async year => !!(await repo.settings(year)).lodgedOn,
        summary: yearSummary,
        send: to
            ? async build => {
                const config = smtpConfig()
                await createMailer(config)(build({ from: config.from, to, siteUrl: config.siteUrl }))
            }
            : null,
        record,
        now: () => new Date(),
        log,
    })
}
