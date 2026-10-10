// Runs invoicing end to end against a real Postgres (the horizons_test database, named by TEST_DATABASE_URL), with
// PayPal, the relay and the clock stood in for. Skipped when that isn't set, so npm test still works without Docker.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AuditEntry } from '../audit/record'
import { createDb } from '../db'
import type { Email } from '../emails/layout'
import type { PrismaClient } from '../generated/prisma/client'
import { PaypalError, type Order, type Paypal, type Subscription } from '../paypal/api'
import { createBilling, type Billing } from './billing'
import type { Business } from './business'
import { invoicePdf } from './pdf'
import { invoiceRepo, planRepo, type InvoiceRepo, type PlanRepo } from './repo'

const url = process.env.TEST_DATABASE_URL

const business: Business = { name: 'Horizons', abn: '23 545 335 026', email: 'info@horizons.gg', address: [], website: 'https://www.horizons.gg', gst: false }
const ADMIN = { type: 'ADMIN', id: 'koda@horizons.gg' } as const
const billTo = { name: 'Ann Lee', company: null, email: 'ann@example.com' }

// Brisbane is UTC+10 all year: 00:00Z is 10am there, inside the hours chasing emails go out
const at = (day: string, hourUtc = 0) => new Date(`${day}T${String(hourUtc).padStart(2, '0')}:00:00Z`)

// PayPal, as far as invoicing uses it: orders that are approved and captured, plans and subscriptions
function fakePaypal() {
    const orders = new Map<string, Order>()
    const subscriptions = new Map<string, Subscription>()
    const calls: string[] = []
    let next = 1
    let decline = false
    const paypal: Paypal = {
        mode: 'sandbox',
        createOrder: async input => {
            const id = `ORDER-${next++}`
            orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: [{ custom_id: input.invoiceId, amount: { currency_code: input.currency, value: input.value } }] })
            calls.push(`createOrder ${input.value}${input.method === 'card' ? ' by card' : ''}`)
            return { id, approveUrl: `https://paypal.example/approve/${id}` }
        },
        getOrder: async id => structuredClone(orders.get(id)!),
        captureOrder: async id => {
            const order = orders.get(id)!
            if (order.status === 'COMPLETED') throw new PaypalError('Already captured.', 422, 'ORDER_ALREADY_CAPTURED', null)
            if (decline) throw new PaypalError('Declined.', 422, 'INSTRUMENT_DECLINED', null)
            order.status = 'COMPLETED'
            order.purchase_units![0].payments = { captures: [{ id: `CAPTURE-${id}`, status: 'COMPLETED', amount: order.purchase_units![0].amount! }] }
            calls.push(`capture ${id}`)
            return structuredClone(order)
        },
        createProduct: async () => { calls.push('createProduct'); return `PROD-${next++}` },
        createPlan: async input => { calls.push(`createPlan ${input.value}`); return `P-${next++}` },
        updatePlanPrice: async (planId, value) => { calls.push(`updatePlanPrice ${planId} ${value}`) },
        createSubscription: async input => {
            const id = `I-${next++}`
            subscriptions.set(id, { id, status: 'APPROVAL_PENDING', plan_id: input.planId, custom_id: input.customId })
            calls.push(`createSubscription ${input.planId}`)
            return { id, approveUrl: `https://paypal.example/subscribe/${id}` }
        },
        getSubscription: async id => structuredClone(subscriptions.get(id)!),
        cancelSubscription: async id => { calls.push(`cancel ${id}`); subscriptions.get(id)!.status = 'CANCELLED' },
        verifyWebhook: async () => true,
    }
    return {
        paypal, calls,
        approve: (id: string) => { orders.get(id)!.status = 'APPROVED' },
        activate: (id: string) => { subscriptions.get(id)!.status = 'ACTIVE' },
        declineNext: () => { decline = true },
    }
}

describe.skipIf(!url)('billing', () => {
    let db: PrismaClient
    let invoices: InvoiceRepo
    let plans: PlanRepo
    let billing: Billing
    let fake: ReturnType<typeof fakePaypal>
    let sent: Email[]
    let recorded: AuditEntry[]
    let now: Date

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE "Invoice", "InvoiceLine", "InvoicePayment", "InvoiceCounter", "BillingPlan", "Client", "Site" CASCADE')
        await db.client.create({ data: { id: 'cl_ANN00001', name: 'Ann Lee', email: 'ann@example.com' } })
        await db.client.create({ data: { id: 'cl_BOB00001', name: 'Bob', email: 'bob@example.com' } })
        invoices = invoiceRepo(db, { firstNumber: 100 })
        plans = planRepo(db)
        fake = fakePaypal()
        sent = []
        recorded = []
        now = at('2026-10-10')
        billing = createBilling({
            invoices, plans,
            business: () => business,
            paypal: () => fake.paypal,
            mode: () => 'sandbox',
            siteUrl: () => 'https://www.horizons.gg',
            send: async build => { sent.push(build({ from: 'from@example.com', replyTo: 'reply@example.com', siteUrl: 'https://www.horizons.gg' })) },
            pdf: invoice => invoicePdf(invoice, business, { payUrl: 'www.horizons.gg/portal/billing' }),
            record: async entry => { recorded.push(entry) },
            now: () => now,
            log: () => {},
        })
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    const draft = (dueOn = '2026-10-24', clientId = 'cl_ANN00001') => invoices.createDraft({
        clientId, dueOn, notes: null, lines: [{ description: 'Landing page', quantity: 1, unitCents: 120_000 }, { description: 'Hours', quantity: 2.5, unitCents: 10_000 }],
    }, billTo, false)

    const kinds = () => recorded.map(entry => entry.kind)

    describe('sending', () => {
        it('numbers a draft, emails it with its PDF, and leaves no gap for a deleted draft', async () => {
            const thrown = await draft()
            expect(await invoices.deleteDraft(thrown.id)).toBe(true)
            const { id } = await draft()
            expect(await billing.send(id, billTo, ADMIN)).toEqual({ ok: true, emailed: true })

            const invoice = (await invoices.get(id))!
            expect(invoice).toMatchObject({ number: 100, status: 'OPEN', issuedOn: '2026-10-10', totalCents: 145_000 })
            expect(sent[0].attachments?.[0].filename).toBe('INV-0100.pdf')
            expect(kinds()).toEqual(['billing.invoiceSend'])

            const second = await draft()
            await billing.send(second.id, billTo, ADMIN)
            expect((await invoices.get(second.id))!.number).toBe(101)
        })

        it('will not send twice, or with a due date already gone', async () => {
            const { id } = await draft()
            await billing.send(id, billTo, ADMIN)
            expect((await billing.send(id, billTo, ADMIN)).ok).toBe(false)
            const late = await draft('2026-10-09')
            expect(await billing.send(late.id, billTo, ADMIN)).toMatchObject({ ok: false, error: expect.stringMatching(/due date has passed/) })
        })

        it('lets only a draft be edited or deleted', async () => {
            const { id } = await draft()
            await billing.send(id, billTo, ADMIN)
            expect(await invoices.deleteDraft(id)).toBe(false)
            expect(await invoices.updateDraft(id, { clientId: 'cl_ANN00001', dueOn: '2026-11-01', notes: null, lines: [{ description: 'x', quantity: 1, unitCents: 1 }] }, billTo, false)).toBe(false)
        })
    })

    describe('paying once with PayPal', () => {
        it('captures on the return, and the webhook telling it again changes nothing', async () => {
            const { id } = await draft()
            await billing.send(id, billTo, ADMIN)

            expect(await billing.startCheckout(id, 'cl_BOB00001')).toMatchObject({ ok: false })
            const started = await billing.startCheckout(id, 'cl_ANN00001')
            expect(started).toEqual({ ok: true, url: 'https://paypal.example/approve/ORDER-1' })
            expect(fake.calls).toContain('createOrder 1450.00')

            fake.approve('ORDER-1')
            expect(await billing.settleOrder('ORDER-1')).toEqual({ kind: 'paid', invoiceId: id })
            expect(await billing.settleOrder('ORDER-1')).toEqual({ kind: 'paid', invoiceId: id })

            const invoice = (await invoices.get(id))!
            expect(invoice.status).toBe('PAID')
            expect(invoice.payments).toHaveLength(1)
            expect(invoice.payments[0]).toMatchObject({ method: 'PAYPAL', amountCents: 145_000, paypalId: 'CAPTURE-ORDER-1', paypalMode: 'sandbox' })
            expect(kinds().filter(kind => kind === 'billing.paid')).toHaveLength(1)
            expect(sent.filter(email => email.subject.startsWith('Payment received'))).toHaveLength(1)
        })

        it('leaves the invoice owing when PayPal declines', async () => {
            const { id } = await draft()
            await billing.send(id, billTo, ADMIN)
            await billing.startCheckout(id, 'cl_ANN00001', 'card')
            expect(fake.calls).toContain('createOrder 1450.00 by card')
            fake.approve('ORDER-1')
            fake.declineNext()
            expect(await billing.settleOrder('ORDER-1')).toMatchObject({ kind: 'failed', invoiceId: id, error: 'INSTRUMENT_DECLINED' })
            expect((await invoices.get(id))!.status).toBe('OPEN')
            expect(kinds()).toContain('billing.paymentFailed')
        })

        it('will not take money for a voided or paid invoice', async () => {
            const { id } = await draft()
            await billing.send(id, billTo, ADMIN)
            expect(await billing.void(id, ADMIN)).toEqual({ ok: true })
            expect(await billing.startCheckout(id, 'cl_ANN00001')).toMatchObject({ ok: false })
            expect((await billing.markPaid(id, null, ADMIN)).ok).toBe(false)
        })
    })

    it('marks an invoice paid by hand for whatever is owing', async () => {
        const { id } = await draft()
        await billing.send(id, billTo, ADMIN)
        expect(await billing.markPaid(id, 'Bank transfer', ADMIN)).toEqual({ ok: true })
        const invoice = (await invoices.get(id))!
        expect(invoice.status).toBe('PAID')
        expect(invoice.payments[0]).toMatchObject({ method: 'MANUAL', amountCents: 145_000, note: 'Bank transfer' })
    })

    describe('the hourly run', () => {
        const plan = async (amount = 4_900, startsOn = '2026-10-10') => {
            const { id } = await plans.create('cl_ANN00001', { description: 'Website hosting', amountCents: amount, interval: 'MONTHLY', startsOn, dueDays: 14, siteId: null })
            return id
        }

        it('raises each period once, on the day it starts', async () => {
            const planId = await plan()
            expect((await billing.run()).raised).toBe(1)
            expect((await billing.run()).raised).toBe(0)

            const [first] = await invoices.list({ standing: null }, '2026-10-10')
            expect(first).toMatchObject({ number: 100, status: 'OPEN', planId, periodStart: '2026-10-10', periodEnd: '2026-11-09', dueOn: '2026-10-24', totalCents: 4_900 })
            expect(sent[0].text).toContain('Website hosting, 10 October 2026 to 9 November 2026')

            now = at('2026-11-09')
            expect((await billing.run()).raised).toBe(0)
            now = at('2026-11-10')
            expect((await billing.run()).raised).toBe(1)
        })

        it('never invoices a plan that is not charged, or one that has ended', async () => {
            await plan(0)
            const ended = await plan()
            await billing.endPlan(ended, ADMIN)
            expect((await billing.run()).raised).toBe(0)
        })

        it('reminds once, three days out, and only in business hours', async () => {
            const { id } = await draft('2026-10-24')
            await billing.send(id, billTo, ADMIN)
            now = at('2026-10-20')
            expect((await billing.run()).reminders).toBe(0)
            now = at('2026-10-21', 12)
            expect((await billing.run()).reminders).toBe(0)
            now = at('2026-10-21')
            expect((await billing.run()).reminders).toBe(1)
            expect((await billing.run()).reminders).toBe(0)
            expect(sent.at(-1)?.subject).toBe('Reminder: invoice INV-0100 is due 24 October 2026')
        })

        it('sends three overdue notices at most, spaced out even after a long silence', async () => {
            const { id } = await draft('2026-10-24')
            await billing.send(id, billTo, ADMIN)
            now = at('2026-10-24')
            expect((await billing.run()).notices).toBe(0)
            now = at('2026-10-25')
            expect((await billing.run()).notices).toBe(1)
            expect((await billing.run()).notices).toBe(0)
            // Twenty days on, notices two and three are both overdue, and still only one goes
            now = at('2026-11-14')
            expect((await billing.run()).notices).toBe(1)
            now = at('2026-11-19')
            expect((await billing.run()).notices).toBe(1)
            now = at('2026-12-30')
            expect((await billing.run()).notices).toBe(0)
            expect((await invoices.get(id))!.overdueNotices).toBe(3)
        })

        it('does not chase a paid invoice', async () => {
            const { id } = await draft('2026-10-24')
            await billing.send(id, billTo, ADMIN)
            await billing.markPaid(id, null, ADMIN)
            now = at('2026-11-01')
            expect(await billing.run()).toEqual({ raised: 0, reminders: 0, notices: 0 })
        })
    })

    describe('paying a plan automatically', () => {
        it('subscribes, settles the waiting invoice, then raises each period already paid', async () => {
            const { id: planId } = await plans.create('cl_ANN00001', { description: 'Website hosting', amountCents: 4_900, interval: 'MONTHLY', startsOn: '2026-10-10', dueDays: 14, siteId: null })
            await billing.run()
            const [waiting] = await invoices.list({ standing: null }, '2026-10-10')

            expect(await billing.startAutopay(planId, 'cl_BOB00001')).toMatchObject({ ok: false })
            const started = await billing.startAutopay(planId, 'cl_ANN00001')
            expect(started).toMatchObject({ ok: true, url: expect.stringContaining('subscribe') })
            expect(fake.calls).toEqual(expect.arrayContaining(['createProduct', 'createPlan 49.00']))
            const subscriptionId = (await plans.get(planId))!.subscriptionId!

            // Back from PayPal before approving: nothing is on
            expect(await billing.confirmSubscription(subscriptionId, planId)).toEqual({ ok: true })
            expect((await plans.get(planId))!.subscriptionStatus).toBe('APPROVAL_PENDING')
            fake.activate(subscriptionId)
            expect(await billing.confirmSubscription(subscriptionId, 'someone-elses-plan')).toEqual({ ok: false })
            expect(await billing.confirmSubscription(subscriptionId, planId)).toEqual({ ok: true })
            await billing.subscriptionChanged(subscriptionId, 'ACTIVE')
            expect(kinds().filter(kind => kind === 'billing.autopayStart')).toHaveLength(1)

            await billing.subscriptionPayment('SALE-1', subscriptionId, { total: '49.00', currency: 'AUD' })
            await billing.subscriptionPayment('SALE-1', subscriptionId, { total: '49.00', currency: 'AUD' })
            expect((await invoices.get(waiting.id))!).toMatchObject({ status: 'PAID', payments: [expect.objectContaining({ method: 'PAYPAL_AUTOPAY', paypalId: 'SALE-1' })] })

            // A month on, the run leaves it to PayPal, and PayPal's payment raises the period already paid
            now = at('2026-11-10')
            expect((await billing.run()).raised).toBe(0)
            await billing.subscriptionPayment('SALE-2', subscriptionId, { total: '49.00', currency: 'AUD' })
            const list = await invoices.list({ standing: 'paid' }, '2026-11-10')
            expect(list).toHaveLength(2)
            expect(list[0]).toMatchObject({ number: 101, periodStart: '2026-11-10', periodEnd: '2026-12-09' })
            expect(sent.filter(email => email.subject.startsWith('Payment received'))).toHaveLength(2)

            // PayPal giving up on a payment puts the plan back on invoices
            await billing.subscriptionChanged(subscriptionId, 'SUSPENDED')
            now = at('2026-12-10')
            expect((await billing.run()).raised).toBe(1)
        })

        it('takes a new price to PayPal, and cancels there when it stops', async () => {
            const { id: planId } = await plans.create('cl_ANN00001', { description: 'Website hosting', amountCents: 4_900, interval: 'MONTHLY', startsOn: '2026-10-10', dueDays: 14, siteId: null })
            await billing.startAutopay(planId, 'cl_ANN00001')
            const plan = (await plans.get(planId))!
            fake.activate(plan.subscriptionId!)
            await billing.confirmSubscription(plan.subscriptionId!, planId)

            await plans.update(planId, { description: 'Website hosting', amountCents: 5_900, interval: 'MONTHLY', startsOn: '2026-10-10', dueDays: 14, siteId: null }, true)
            expect(await billing.repricePaypal(planId)).toEqual({ ok: true })
            expect(fake.calls).toContain(`updatePlanPrice ${plan.paypalPlanId} 59.00`)

            expect(await billing.stopAllForClient('cl_ANN00001', ADMIN)).toEqual({ ok: true })
            expect(fake.calls).toContain(`cancel ${plan.subscriptionId}`)
            expect((await plans.get(planId))!.subscriptionId).toBeNull()
        })
    })
})
