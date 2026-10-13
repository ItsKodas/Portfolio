// The hourly look at the calendar: sends the operator whichever tax reminders are due, each once. Every effect
// is a dependency (server/tax/wiring.ts supplies the real ones), so the whole run is a test.

import 'server-only'

import { TAX_RUN, type AuditEntry } from '../audit/record'
import type { Email } from '../emails/layout'
import { hourIn, todayIn, type Day } from '../invoices/days'
import { dueReminders, gstKey, type Reminder } from './dates'
import { gstEmail, reminderEmail, type TaxMailOptions } from './emails'
import type { YearSummary } from './summary'
import { yearOf, type FinancialYear } from './year'

// Business hours in Brisbane, like the billing run's emails
const SEND_FROM_HOUR = 9
const SEND_UNTIL_HOUR = 18

export type TaxReminderDeps = {
    claim: (key: string) => Promise<boolean>
    release: (key: string) => Promise<void>
    sentAmong: (keys: string[]) => Promise<Set<string>>
    lodged: (year: FinancialYear) => Promise<boolean>
    summary: (year: FinancialYear, today: Day) => Promise<YearSummary>
    // Null when there is nowhere to send them, which stops the run and nothing else
    send: ((build: (options: TaxMailOptions) => Email) => Promise<void>) | null
    record: (entry: AuditEntry) => Promise<void>
    now: () => Date
    log: (message: string, error?: unknown) => void
}

export function createTaxReminders(deps: TaxReminderDeps) {
    // Claimed first and handed back if the email fails, so two runs never both send it and a failure is retried
    async function deliver(key: string, subject: string, build: (options: TaxMailOptions) => Email): Promise<boolean> {
        const send = deps.send
        if (!send || !(await deps.claim(key))) return false
        try {
            await send(build)
        } catch (error) {
            deps.log(`Sending the ${key} tax reminder failed`, error)
            await deps.release(key)
            return false
        }
        await deps.record({ kind: 'tax.reminder', actor: TAX_RUN, target: { type: 'tax', id: key, name: subject }, summary: `Emailed a tax reminder: ${subject}` })
        return true
    }

    async function run(): Promise<{ sent: number }> {
        if (!deps.send) return { sent: 0 }
        const now = deps.now()
        const hour = hourIn(now)
        if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return { sent: 0 }
        const today = todayIn(now)
        const current = yearOf(today)

        const lodged = new Map<FinancialYear, boolean>()
        for (const year of [current - 1, current]) lodged.set(year, await deps.lodged(year))

        const gstKeys = [gstKey('near', current), gstKey('over', current)]
        const reminders = dueReminders(today, new Set(), year => lodged.get(year) ?? false)
        const sent = await deps.sentAmong([...reminders.map(reminder => reminder.key), ...gstKeys])
        let count = 0

        const summaries = new Map<FinancialYear, YearSummary>()
        const summaryOf = async (year: FinancialYear) => {
            if (!summaries.has(year)) summaries.set(year, await deps.summary(year, today))
            return summaries.get(year)!
        }

        for (const reminder of reminders.filter((item: Reminder) => !sent.has(item.key))) {
            const summary = await summaryOf(reminder.year)
            const sample = reminderEmail(reminder.kind, summary, today, { from: '', to: '', siteUrl: '' })
            if (await deliver(reminder.key, sample.subject, options => reminderEmail(reminder.kind, summary, today, options))) count++
        }

        // GST once per level per year: reaching the threshold outright skips the nearing email
        const summary = await summaryOf(current)
        const level = summary.gst.level
        if (level !== 'clear' && !sent.has(gstKey('over', current)) && !(level === 'near' && sent.has(gstKey('near', current)))) {
            const sample = gstEmail(level, summary, { from: '', to: '', siteUrl: '' })
            if (await deliver(gstKey(level, current), sample.subject, options => gstEmail(level, summary, options))) {
                count++
                if (level === 'over') await deps.claim(gstKey('near', current))
            }
        }

        return { sent: count }
    }

    return { run }
}
