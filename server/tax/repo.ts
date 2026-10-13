// Every query tax tracking makes. Income from invoices is read straight from the payments, so the tax page can
// never disagree with the invoices; only hand-entered money, the year's settings and which reminders have gone
// out are stored here. Same shape as server/invoices/repo.ts.

import 'server-only'

import type { PrismaClient } from '../generated/prisma/client'
import { addDays, dateOf, dayOf, todayIn, type Day } from '../invoices/days'
import { invoiceNumber } from '../invoices/standing'
import type { EntryInput, YearInput } from './schema'
import type { EntryRow, PaymentRow, YearSettings } from './summary'
import { endOf, startOf, type FinancialYear } from './year'

const METHODS: Record<string, string> = { PAYPAL: 'PayPal', PAYPAL_AUTOPAY: 'PayPal, automatic', MANUAL: 'Paid directly' }

// Brisbane is ten hours ahead of UTC all year, so a day there starts at 14:00 UTC the day before. A day's
// margin either side is read and the rows are then placed by their Brisbane day.
const rangeOf = (from: Day, to: Day) => ({ gte: dateOf(addDays(from, -1)), lt: dateOf(addDays(to, 2)) })

// GST charged on an invoice was never the business's income, so a payment on a GST invoice counts its share
// of the subtotal only
export const netOfGst = (cents: number, invoice: { gst: boolean, subtotalCents: number, totalCents: number }) =>
    invoice.gst && invoice.totalCents > 0 ? Math.round(cents * invoice.subtotalCents / invoice.totalCents) : cents

export function taxRepo(db: PrismaClient) {
    return {
        // Real money only: a refunded payment is no longer income, and a sandbox one never was
        payments: async (from: Day, to: Day): Promise<PaymentRow[]> => {
            const rows = await db.invoicePayment.findMany({
                where: {
                    createdAt: rangeOf(from, to),
                    refundedAt: null,
                    OR: [{ paypalMode: null }, { paypalMode: { not: 'sandbox' } }],
                },
                include: { invoice: { select: { id: true, number: true, billToName: true, billToCompany: true, gst: true, subtotalCents: true, totalCents: true } } },
                orderBy: { createdAt: 'asc' },
            })
            return rows
                .map(row => ({
                    id: row.id,
                    day: todayIn(row.createdAt),
                    cents: netOfGst(row.amountCents, row.invoice),
                    invoiceId: row.invoice.id,
                    invoiceNumber: invoiceNumber(row.invoice.number),
                    who: row.invoice.billToCompany || row.invoice.billToName,
                    method: METHODS[row.method] ?? row.method,
                }))
                .filter(row => row.day >= from && row.day <= to)
        },

        entries: async (from: Day, to: Day): Promise<EntryRow[]> => {
            const rows = await db.taxEntry.findMany({
                where: { occurredOn: { gte: dateOf(from), lte: dateOf(to) } },
                orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
            })
            return rows.map(row => ({
                id: row.id, kind: row.kind, day: dayOf(row.occurredOn), description: row.description,
                category: row.category, amountCents: row.amountCents, businessPercent: row.businessPercent,
            }))
        },

        settings: async (year: FinancialYear): Promise<YearSettings> => {
            const row = await db.taxYear.findUnique({ where: { year } })
            return {
                otherIncomeCents: row?.otherIncomeCents ?? 0,
                withheldCents: row?.withheldCents ?? 0,
                lodgedOn: row?.lodgedOn ? dayOf(row.lodgedOn) : null,
            }
        },

        // The years there is anything to show for, oldest first, so the page can step between them
        firstDay: async (): Promise<Day | null> => {
            const [payment, entry] = await Promise.all([
                db.invoicePayment.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
                db.taxEntry.findFirst({ orderBy: { occurredOn: 'asc' }, select: { occurredOn: true } }),
            ])
            const days = [payment && todayIn(payment.createdAt), entry && dayOf(entry.occurredOn)].filter((day): day is Day => !!day)
            return days.sort()[0] ?? null
        },

        addEntry: async (input: EntryInput) => db.taxEntry.create({
            data: {
                kind: input.kind, occurredOn: dateOf(input.occurredOn), description: input.description,
                category: input.category, amountCents: input.amountCents, businessPercent: input.businessPercent,
            },
            select: { id: true },
        }),

        deleteEntry: async (id: string) => {
            const row = await db.taxEntry.findUnique({ where: { id } })
            if (!row) return null
            await db.taxEntry.delete({ where: { id } })
            return { ...row, occurredOn: dayOf(row.occurredOn) }
        },

        saveYear: async (input: YearInput) => {
            const data = {
                otherIncomeCents: input.otherIncomeCents,
                withheldCents: input.withheldCents,
                lodgedOn: input.lodgedOn ? dateOf(input.lodgedOn) : null,
            }
            await db.taxYear.upsert({ where: { year: input.year }, create: { year: input.year, ...data }, update: data })
        },

        // Claimed before the email goes, so two runs at once send it once. False when it was already sent.
        claimReminder: async (key: string): Promise<boolean> => {
            const result = await db.taxReminder.createMany({ data: [{ key }], skipDuplicates: true })
            return result.count > 0
        },

        // Handed back when the email could not go, so the next run tries again
        releaseReminder: async (key: string) => {
            await db.taxReminder.deleteMany({ where: { key } })
        },

        // Which of these have gone already
        sentAmong: async (keys: string[]): Promise<Set<string>> =>
            new Set((await db.taxReminder.findMany({ where: { key: { in: keys } }, select: { key: true } })).map(row => row.key)),

        // The latest few, for the page to show what has gone out
        recentReminders: async (): Promise<{ key: string, sentAt: Date }[]> =>
            db.taxReminder.findMany({ orderBy: { sentAt: 'desc' }, take: 8 }),
    }
}

export type TaxRepo = ReturnType<typeof taxRepo>

// The rows one year's summary needs: the year itself, and the twelve months to today for the GST test
export function spanFor(year: FinancialYear, today: Day): { from: Day, to: Day } {
    const lookBack = addDays(today, -366)
    const from = lookBack < startOf(year) ? lookBack : startOf(year)
    const to = today > endOf(year) ? today : endOf(year)
    return { from, to }
}
