// Starts the hourly tax reminder run inside the site's own process, from instrumentation.ts, the same way as the
// billing run (server/invoices/schedule.ts). Safe to start twice: each reminder is claimed before it is sent.

import 'server-only'

const HOUR_MS = 60 * 60 * 1000
const FIRST_RUN_MS = 3 * 60 * 1000

const state = globalThis as unknown as { horizonsTax?: NodeJS.Timeout }

export function startTaxSchedule(): void {
    if (state.horizonsTax || !process.env.DATABASE_URL) return
    if (/^(0|off|false)$/i.test(process.env.TAX_REMINDERS ?? '')) {
        console.log('[tax] the hourly reminder run is switched off by TAX_REMINDERS')
        return
    }
    const tick = async () => {
        try {
            const { taxReminders } = await import('./wiring')
            const result = await taxReminders().run()
            if (result.sent) console.log(`[tax] sent ${result.sent} tax reminders`)
        } catch (error) {
            console.error('[tax] the hourly reminder run failed', error)
        }
    }
    setTimeout(tick, FIRST_RUN_MS).unref()
    state.horizonsTax = setInterval(tick, HOUR_MS)
    state.horizonsTax.unref()
}
