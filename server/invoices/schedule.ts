// Starts the hourly billing run inside the site's own process, from instrumentation.ts, so deploying stays
// `docker compose up` with no cron to set up beside it. Safe to start twice: every write the run makes is a
// claim on a row (server/invoices/repo.ts), so two runs at once share the work rather than doubling it.

import 'server-only'

const HOUR_MS = 60 * 60 * 1000
// Long enough after a start that migrations have run and the site is answering
const FIRST_RUN_MS = 2 * 60 * 1000

const state = globalThis as unknown as { horizonsBilling?: NodeJS.Timeout }

export function startBillingSchedule(): void {
    if (state.horizonsBilling || !process.env.DATABASE_URL) return
    if (/^(0|off|false)$/i.test(process.env.BILLING_SCHEDULE ?? '')) {
        console.log('[billing] the hourly run is switched off by BILLING_SCHEDULE')
        return
    }
    const tick = async () => {
        try {
            const { billing } = await import('./wiring')
            const result = await billing().run()
            if (result.raised || result.reminders || result.notices) {
                console.log(`[billing] raised ${result.raised} plan invoices, sent ${result.reminders} reminders and ${result.notices} overdue notices`)
            }
        } catch (error) {
            console.error('[billing] the hourly run failed', error)
        }
    }
    setTimeout(tick, FIRST_RUN_MS).unref()
    state.horizonsBilling = setInterval(tick, HOUR_MS)
    state.horizonsBilling.unref()
}
