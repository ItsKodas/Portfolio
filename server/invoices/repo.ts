// Every query the invoicing feature makes, in one place, taking the client as a parameter so the tests can point
// it at the test database. Same shape as server/quotes/repo.ts. Calendar days go in and come out as 'YYYY-MM-DD'
// (server/invoices/days.ts), so nothing above this file handles a @db.Date column's midnight-UTC Date.

import 'server-only'

import type { BillingInterval, PaymentMethod, Prisma, PrismaClient } from '../generated/prisma/client'
import { dateOf, dayOf, type Day } from './days'
import { lineAmount, totalsOf } from './money'
import type { Standing } from './standing'
import type { InvoiceInput, PlanInput } from './schema'

export type BillTo = { name: string, company: string | null, email: string }

type Tx = Prisma.TransactionClient

const invoiceInclude = {
    lines: { orderBy: { position: 'asc' } },
    payments: { orderBy: { createdAt: 'asc' } },
    client: { select: { id: true, name: true, company: true, email: true } },
    plan: { select: { id: true, description: true, interval: true, paypalMode: true, subscriptionStatus: true } },
} as const satisfies Prisma.InvoiceInclude

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>

const asView = <T extends { dueOn: Date, issuedOn: Date | null, periodStart: Date | null, periodEnd: Date | null }>(row: T) => ({
    ...row,
    dueOn: dayOf(row.dueOn),
    issuedOn: row.issuedOn ? dayOf(row.issuedOn) : null,
    periodStart: row.periodStart ? dayOf(row.periodStart) : null,
    periodEnd: row.periodEnd ? dayOf(row.periodEnd) : null,
})

export type InvoiceView = ReturnType<typeof asView<InvoiceRow>>

const listSelect = {
    id: true, number: true, status: true, billToName: true, billToCompany: true, clientId: true, issuedOn: true,
    dueOn: true, totalCents: true, currency: true, createdAt: true, paidAt: true, planId: true, periodStart: true, periodEnd: true,
} as const satisfies Prisma.InvoiceSelect

type ListRow = Prisma.InvoiceGetPayload<{ select: typeof listSelect }>
export type InvoiceListItem = ReturnType<typeof asView<ListRow>>

const planAsView = <T extends { startsOn: Date }>(row: T) => ({ ...row, startsOn: dayOf(row.startsOn) })

const planInclude = {
    client: { select: { id: true, name: true, company: true, email: true } },
    site: { select: { id: true, projectId: true, name: true } },
} as const satisfies Prisma.BillingPlanInclude

type PlanRow = Prisma.BillingPlanGetPayload<{ include: typeof planInclude }>
export type PlanView = ReturnType<typeof planAsView<PlanRow>>

// Where each standing lives in the stored columns. Due and overdue split OPEN by the due date.
function whereStanding(standing: Standing | null, today: Day): Prisma.InvoiceWhereInput {
    switch (standing) {
        case null: return {}
        case 'draft': return { status: 'DRAFT' }
        case 'paid': return { status: 'PAID' }
        case 'void': return { status: 'VOID' }
        case 'due': return { status: 'OPEN', dueOn: { gte: dateOf(today) } }
        case 'overdue': return { status: 'OPEN', dueOn: { lt: dateOf(today) } }
    }
}

const linesData = (lines: InvoiceInput['lines']) => lines.map((line, position) => ({
    position,
    description: line.description,
    quantity: line.quantity,
    unitCents: line.unitCents,
    amountCents: lineAmount(line),
}))

// Takes the next number and moves the counter on, in one statement, so two invoices sent at once can never
// share one. The first ever starts at `start`, for a business that has numbered invoices somewhere else before.
async function takeNumber(tx: Tx, start: number): Promise<number> {
    const rows = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO "InvoiceCounter" ("id", "next") VALUES (1, ${start + 1})
        ON CONFLICT ("id") DO UPDATE SET "next" = "InvoiceCounter"."next" + 1
        RETURNING "next" - 1 AS "number"`
    return Number(rows[0].number)
}

export type RecordedPayment =
    | { kind: 'recorded', invoice: InvoiceView, paidNow: boolean }
    | { kind: 'duplicate' }
    | { kind: 'missing' }

export function invoiceRepo(db: PrismaClient, options: { firstNumber?: number } = {}) {
    const firstNumber = options.firstNumber ?? 1

    const get = async (id: string): Promise<InvoiceView | null> => {
        const row = await db.invoice.findUnique({ where: { id }, include: invoiceInclude })
        return row ? asView(row) : null
    }

    return {
        get,

        createDraft: async (input: InvoiceInput, billTo: BillTo, gst: boolean): Promise<{ id: string }> => {
            const totals = totalsOf(input.lines, gst)
            return db.invoice.create({
                data: {
                    clientId: input.clientId,
                    billToName: billTo.name, billToCompany: billTo.company, billToEmail: billTo.email,
                    dueOn: dateOf(input.dueOn), notes: input.notes, gst, ...totals,
                    lines: { create: linesData(input.lines) },
                },
                select: { id: true },
            })
        },

        // Only a draft can change. A sent invoice is voided and written again, never edited under the client.
        updateDraft: async (id: string, input: InvoiceInput, billTo: BillTo, gst: boolean): Promise<boolean> => {
            const totals = totalsOf(input.lines, gst)
            return db.$transaction(async tx => {
                const updated = await tx.invoice.updateMany({
                    where: { id, status: 'DRAFT' },
                    data: {
                        clientId: input.clientId,
                        billToName: billTo.name, billToCompany: billTo.company, billToEmail: billTo.email,
                        dueOn: dateOf(input.dueOn), notes: input.notes, gst, ...totals,
                    },
                })
                if (updated.count === 0) return false
                await tx.invoiceLine.deleteMany({ where: { invoiceId: id } })
                await tx.invoiceLine.createMany({ data: linesData(input.lines).map(line => ({ ...line, invoiceId: id })) })
                return true
            })
        },

        deleteDraft: async (id: string): Promise<boolean> =>
            (await db.invoice.deleteMany({ where: { id, status: 'DRAFT' } })).count > 0,

        // Draft to open: numbered, dated and addressed to whoever the client is now
        issue: async (id: string, billTo: BillTo, today: Day, now: Date): Promise<InvoiceView | null> => {
            const issued = await db.$transaction(async tx => {
                const current = await tx.invoice.findUnique({ where: { id }, select: { status: true } })
                if (current?.status !== 'DRAFT') return false
                const number = await takeNumber(tx, firstNumber)
                await tx.invoice.update({
                    where: { id },
                    data: {
                        status: 'OPEN', number, issuedOn: dateOf(today), sentAt: now,
                        billToName: billTo.name, billToCompany: billTo.company, billToEmail: billTo.email,
                    },
                })
                return true
            })
            // Read after the transaction rather than inside it: an include runs its queries side by side, which
            // one transaction's single connection should not be asked to do
            return issued ? get(id) : null
        },

        // A plan's invoice, numbered and open from the start. The period is claimed in the same transaction, so
        // two billing runs at once can only ever raise one invoice for it.
        createForPlan: async (plan: {
            id: string, clientId: string, description: string, amountCents: number, periodsBilled: number, dueDays: number
        }, billTo: BillTo, period: { start: Day, end: Day }, gst: boolean, today: Day, dueOn: Day, now: Date, paid?: {
            method: PaymentMethod, paypalId: string, paypalMode: string, amountCents: number,
        }): Promise<InvoiceView | null> => {
            const createdId = await db.$transaction(async tx => {
                const claimed = await tx.billingPlan.updateMany({
                    where: { id: plan.id, periodsBilled: plan.periodsBilled },
                    data: { periodsBilled: plan.periodsBilled + 1 },
                })
                if (claimed.count === 0) return null
                const lines = [{ description: plan.description, quantity: 1, unitCents: plan.amountCents }]
                const number = await takeNumber(tx, firstNumber)
                const created = await tx.invoice.create({
                    data: {
                        number, status: paid ? 'PAID' : 'OPEN', clientId: plan.clientId, planId: plan.id,
                        billToName: billTo.name, billToCompany: billTo.company, billToEmail: billTo.email,
                        issuedOn: dateOf(today), dueOn: dateOf(dueOn), sentAt: now, paidAt: paid ? now : null,
                        periodStart: dateOf(period.start), periodEnd: dateOf(period.end),
                        gst, ...totalsOf(lines, gst),
                        lines: { create: linesData(lines) },
                        ...(paid && {
                            payments: {
                                create: {
                                    method: paid.method, amountCents: paid.amountCents, paypalId: paid.paypalId, paypalMode: paid.paypalMode,
                                },
                            },
                        }),
                    },
                    select: { id: true },
                })
                return created.id
            })
            return createdId ? get(createdId) : null
        },

        // A payment, kept once however many times PayPal reports it. An open invoice it covers becomes paid; one
        // that was voided or already paid keeps its status, and the caller says so in the log.
        recordPayment: async (invoiceId: string, payment: {
            method: PaymentMethod, amountCents: number, paypalId?: string | null, paypalMode?: string | null, note?: string | null,
        }, now: Date): Promise<RecordedPayment> => {
            let paidNow: boolean
            try {
                const outcome = await db.$transaction(async tx => {
                    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, totalCents: true } })
                    if (!invoice) return null
                    await tx.invoicePayment.create({
                        data: {
                            invoiceId, method: payment.method, amountCents: payment.amountCents,
                            paypalId: payment.paypalId ?? null, paypalMode: payment.paypalMode ?? null, note: payment.note ?? null,
                        },
                    })
                    const paid = await tx.invoicePayment.aggregate({ where: { invoiceId, refundedAt: null }, _sum: { amountCents: true } })
                    const covered = (paid._sum.amountCents ?? 0) >= invoice.totalCents
                    if (invoice.status === 'OPEN' && covered) {
                        await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID', paidAt: now } })
                        return { paidNow: true }
                    }
                    return { paidNow: false }
                })
                if (!outcome) return { kind: 'missing' }
                paidNow = outcome.paidNow
            } catch (error) {
                if ((error as { code?: string }).code === 'P2002') return { kind: 'duplicate' }
                throw error
            }
            const invoice = await get(invoiceId)
            return invoice ? { kind: 'recorded', invoice, paidNow } : { kind: 'missing' }
        },

        hasPayment: async (paypalId: string) => (await db.invoicePayment.count({ where: { paypalId } })) > 0,

        markRefunded: async (paypalId: string, now: Date) => {
            const payment = await db.invoicePayment.findUnique({ where: { paypalId }, select: { id: true, invoiceId: true, refundedAt: true } })
            if (!payment || payment.refundedAt) return null
            await db.invoicePayment.update({ where: { id: payment.id }, data: { refundedAt: now } })
            return get(payment.invoiceId)
        },

        voidInvoice: async (id: string, now: Date): Promise<boolean> =>
            (await db.invoice.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'VOID', voidedAt: now } })).count > 0,

        list: async (filter: { standing: Standing | null, clientId?: string, visibleToClient?: boolean }, today: Day): Promise<InvoiceListItem[]> => {
            const rows = await db.invoice.findMany({
                where: {
                    ...whereStanding(filter.standing, today),
                    ...(filter.clientId && { clientId: filter.clientId }),
                    // A client never sees a draft: it is not theirs until it is sent
                    ...(filter.visibleToClient && { status: { not: 'DRAFT' as const } }),
                },
                orderBy: [{ createdAt: 'desc' }],
                select: listSelect,
            })
            return rows.map(asView)
        },

        // The figures over the admin list. Outstanding counts every open invoice; overdue is the part of it past due.
        summary: async (today: Day, since: Date) => {
            const [outstanding, overdue, paid, drafts] = await Promise.all([
                db.invoice.aggregate({ where: { status: 'OPEN' }, _sum: { totalCents: true }, _count: true }),
                db.invoice.aggregate({ where: { status: 'OPEN', dueOn: { lt: dateOf(today) } }, _sum: { totalCents: true }, _count: true }),
                db.invoice.aggregate({ where: { status: 'PAID', paidAt: { gte: since } }, _sum: { totalCents: true }, _count: true }),
                db.invoice.count({ where: { status: 'DRAFT' } }),
            ])
            return {
                outstanding: { cents: outstanding._sum.totalCents ?? 0, count: outstanding._count },
                overdue: { cents: overdue._sum.totalCents ?? 0, count: overdue._count },
                paid: { cents: paid._sum.totalCents ?? 0, count: paid._count },
                drafts,
            }
        },

        // Open invoices the billing run may need to write to, with what it needs to decide
        openInvoices: async () => (await db.invoice.findMany({
            where: { status: 'OPEN', sentAt: { not: null } },
            include: invoiceInclude,
        })).map(asView),

        // Claimed before the email goes, so two runs at once send one reminder between them
        claimReminder: async (id: string, now: Date): Promise<boolean> =>
            (await db.invoice.updateMany({ where: { id, status: 'OPEN', reminderSentAt: null }, data: { reminderSentAt: now } })).count > 0,

        claimOverdueNotice: async (id: string, sentSoFar: number, now: Date): Promise<boolean> =>
            (await db.invoice.updateMany({
                where: { id, status: 'OPEN', overdueNotices: sentSoFar },
                data: { overdueNotices: sentSoFar + 1, lastOverdueNoticeAt: now },
            })).count > 0,

        // The oldest open invoice a plan raised for this amount, which an automatic payment settles first
        oldestOpenForPlan: async (planId: string, totalCents: number) => {
            const row = await db.invoice.findFirst({
                where: { planId, status: 'OPEN', totalCents },
                orderBy: [{ issuedOn: 'asc' }, { createdAt: 'asc' }],
                select: { id: true },
            })
            return row?.id ?? null
        },
    }
}

export type InvoiceRepo = ReturnType<typeof invoiceRepo>

export function planRepo(db: PrismaClient) {
    const get = async (id: string): Promise<PlanView | null> => {
        const row = await db.billingPlan.findUnique({ where: { id }, include: planInclude })
        return row ? planAsView(row) : null
    }

    return {
        get,

        bySubscription: async (subscriptionId: string): Promise<PlanView | null> => {
            const row = await db.billingPlan.findUnique({ where: { subscriptionId }, include: planInclude })
            return row ? planAsView(row) : null
        },

        list: async (filter: { clientId?: string, includeEnded?: boolean } = {}): Promise<PlanView[]> =>
            (await db.billingPlan.findMany({
                where: {
                    ...(filter.clientId && { clientId: filter.clientId }),
                    ...(!filter.includeEnded && { endedAt: null }),
                },
                orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
                include: planInclude,
            })).map(planAsView),

        create: async (clientId: string, input: PlanInput): Promise<{ id: string }> =>
            db.billingPlan.create({
                data: {
                    clientId, siteId: input.siteId, description: input.description, amountCents: input.amountCents,
                    interval: input.interval as BillingInterval, startsOn: dateOf(input.startsOn), dueDays: input.dueDays,
                },
                select: { id: true },
            }),

        // The start date only moves while nothing has been billed, since every period is counted from it
        update: async (id: string, input: PlanInput, billed: boolean) => {
            await db.billingPlan.update({
                where: { id },
                data: {
                    siteId: input.siteId, description: input.description, amountCents: input.amountCents,
                    interval: input.interval as BillingInterval, dueDays: input.dueDays,
                    ...(!billed && { startsOn: dateOf(input.startsOn) }),
                },
            })
        },

        end: async (id: string, now: Date) => {
            await db.billingPlan.update({ where: { id }, data: { endedAt: now } })
        },

        // Plans the billing run looks at: running, and charged for
        running: async (): Promise<PlanView[]> =>
            (await db.billingPlan.findMany({ where: { endedAt: null, amountCents: { gt: 0 } }, include: planInclude })).map(planAsView),

        // A plan made in a new PayPal mode takes the subscription with it: one from the sandbox is nothing in live
        setPaypalPlan: async (id: string, values: { paypalMode: string, paypalProductId: string, paypalPlanId: string, paypalPlanCents: number }, modeChanged: boolean) => {
            await db.billingPlan.update({
                where: { id },
                data: { ...values, ...(modeChanged && { subscriptionId: null, subscriptionStatus: null }) },
            })
        },

        setPaypalPlanCents: async (id: string, paypalPlanCents: number) => {
            await db.billingPlan.update({ where: { id }, data: { paypalPlanCents } })
        },

        setSubscription: async (id: string, subscriptionId: string | null, subscriptionStatus: string | null, paypalMode: string | null) => {
            // A subscription id is unique across plans, so a stale one elsewhere is let go first
            if (subscriptionId) {
                await db.billingPlan.updateMany({ where: { subscriptionId, NOT: { id } }, data: { subscriptionId: null, subscriptionStatus: null } })
            }
            await db.billingPlan.update({ where: { id }, data: { subscriptionId, subscriptionStatus, ...(paypalMode && { paypalMode }) } })
        },

        setSubscriptionStatus: async (subscriptionId: string, subscriptionStatus: string) => {
            await db.billingPlan.updateMany({ where: { subscriptionId }, data: { subscriptionStatus } })
        },

        // Sites to offer in the plan form
        sites: () => db.site.findMany({ orderBy: { name: 'asc' }, select: { id: true, projectId: true, name: true } }),
    }
}

export type PlanRepo = ReturnType<typeof planRepo>
