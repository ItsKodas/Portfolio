// Next calls register() once when the server starts. It starts the hourly billing run (server/invoices/schedule.ts),
// only in the Node runtime: the edge runtime the middleware uses has no database to bill from. The condition is
// written exactly this way because Next replaces NEXT_RUNTIME while building, which is what keeps the import
// (and nodemailer under it) out of the edge bundle altogether.

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { startBillingSchedule } = await import('./server/invoices/schedule')
        startBillingSchedule()
    }
}
