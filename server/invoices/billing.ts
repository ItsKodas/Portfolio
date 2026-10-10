// Everything invoicing does that has a consequence: sending an invoice, taking a payment, setting up or stopping
// automatic payment, and the hourly run that raises plan invoices and chases late ones. Every effect is a
// dependency (server/invoices/wiring.ts supplies the real ones), so each flow is a test rather than something
// first tried against PayPal.

import 'server-only'

import { BILLING_RUN, PAYPAL, type Actor, type AuditEntry } from '../audit/record'
import type { Email } from '../emails/layout'
import type { Order, PayMethod, Paypal } from '../paypal/api'
import { captureOf, invoiceIdOf, PaypalError } from '../paypal/api'
import type { PaypalMode } from '../paypal/config'
import type { Business } from './business'
import { addDays, daysBetween, hourIn, todayIn, type Day } from './days'
import { invoiceEmail, overdueEmail, receiptEmail, reminderEmail, type EmailInvoice } from './emails'
import { centsFromValue, formatMoney, paypalValue, totalsOf } from './money'
import type { PdfInvoice } from './pdf'
import { autopayActive, INTERVAL_MONTHS, periodOf, planDue } from './plans'
import type { BillTo, InvoiceRepo, InvoiceView, PlanRepo, PlanView } from './repo'
import { invoiceNumber, standingOf } from './standing'

// The reminder goes this many days before the due date, and only if the invoice gave the client longer than
// that to pay in the first place
export const REMINDER_DAYS_BEFORE = 3
// Overdue notices, by days past due. Three and then it is a conversation, not an email.
export const OVERDUE_NOTICE_DAYS = [1, 7, 14]
// However late the run is, notices are this far apart, so a server that was down for a fortnight does not
// send all three in one go when it comes back
const MIN_DAYS_BETWEEN_NOTICES = 5
// Chasing emails go out in business hours in Brisbane, not at three in the morning
const SEND_FROM_HOUR = 9
const SEND_UNTIL_HOUR = 18
// The most periods one plan is invoiced for in a single run, should it have fallen far behind
const MAX_CATCH_UP = 3

export type MailOptions = { from: string, replyTo: string, siteUrl: string }

export type BillingDeps = {
    invoices: InvoiceRepo
    plans: PlanRepo
    business: () => Business
    // Null when PayPal is not set up, which stops online payment and nothing else
    paypal: () => Paypal | null
    mode: () => PaypalMode | null
    siteUrl: () => string
    send: (build: (options: MailOptions) => Email) => Promise<void>
    pdf: (invoice: PdfInvoice) => Promise<Buffer>
    record: (entry: AuditEntry) => Promise<void>
    now: () => Date
    log: (message: string, error?: unknown) => void
}

export type Outcome = { ok: true } | { ok: false, error: string }

const fail = (error: string): Outcome => ({ ok: false, error })

export const billToOf = (client: { name: string, company: string | null, email: string }): BillTo =>
    ({ name: client.name, company: client.company, email: client.email })

const target = (invoice: { id: string, number: number | null, billToName: string }) =>
    ({ type: 'invoice', id: invoice.id, name: `${invoiceNumber(invoice.number)} for ${invoice.billToName}` })

const planTarget = (plan: PlanView) => ({ type: 'plan', id: plan.id, name: `${plan.description} for ${plan.client.name}` })

// Who paid, as the log should say it: the client the invoice is for, when there still is one
const payerOf = (invoice: InvoiceView): Actor =>
    invoice.client ? { type: 'CLIENT', id: invoice.client.id } : PAYPAL

export const paidCentsOf = (invoice: InvoiceView): number =>
    invoice.payments.filter(payment => !payment.refundedAt).reduce((sum, payment) => sum + payment.amountCents, 0)

export function pdfInvoiceOf(invoice: InvoiceView, today: Day): PdfInvoice {
    return {
        number: invoice.number,
        standing: standingOf(invoice, today),
        issuedOn: invoice.issuedOn,
        dueOn: invoice.dueOn,
        billToName: invoice.billToName,
        billToCompany: invoice.billToCompany,
        billToEmail: invoice.billToEmail,
        currency: invoice.currency,
        gst: invoice.gst,
        lines: invoice.lines,
        subtotalCents: invoice.subtotalCents,
        gstCents: invoice.gstCents,
        totalCents: invoice.totalCents,
        paidCents: paidCentsOf(invoice),
        paidOn: invoice.paidAt ? todayIn(invoice.paidAt) : null,
        notes: invoice.notes,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
    }
}

export const emailInvoiceOf = (invoice: InvoiceView): EmailInvoice => ({
    id: invoice.id,
    number: invoice.number,
    billToName: invoice.billToName,
    billToEmail: invoice.billToEmail,
    totalCents: invoice.totalCents,
    currency: invoice.currency,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    planDescription: invoice.plan?.description ?? null,
})

// What a plan charges each period, GST and all: the amount the PayPal plan must take
export const planTotalCents = (plan: { amountCents: number }, gst: boolean) =>
    totalsOf([{ quantity: 1, unitCents: plan.amountCents }], gst).totalCents

export function createBilling(deps: BillingDeps) {
    const today = () => todayIn(deps.now())

    // Never throws: whatever an email was about has already happened, and the sent-mail log has the failure
    async function mail(what: string, build: (options: MailOptions) => Email): Promise<boolean> {
        try {
            await deps.send(build)
            return true
        } catch (error) {
            deps.log(`${what}: sending the email failed`, error)
            return false
        }
    }

    async function emailInvoice(invoice: InvoiceView): Promise<boolean> {
        const business = deps.business()
        let pdf: Buffer
        try {
            pdf = await deps.pdf(pdfInvoiceOf(invoice, today()))
        } catch (error) {
            deps.log(`Drawing the PDF of ${invoice.id} failed`, error)
            return false
        }
        return mail(`Invoice ${invoice.id}`, options => invoiceEmail(emailInvoiceOf(invoice), business, { ...options, pdf }))
    }

    async function receipt(invoice: InvoiceView, amountCents: number, automatic: boolean) {
        const business = deps.business()
        await mail(`Receipt for ${invoice.id}`, options =>
            receiptEmail(emailInvoiceOf(invoice), business, { ...options, amountCents, paidOn: today(), automatic }))
    }

    // A PayPal payment arriving, from whichever direction it came. Kept once, however often it is reported.
    async function paid(invoiceId: string, payment: { paypalId: string, amountCents: number, automatic: boolean }): Promise<'paid' | 'duplicate' | 'missing'> {
        const recorded = await deps.invoices.recordPayment(invoiceId, {
            method: payment.automatic ? 'PAYPAL_AUTOPAY' : 'PAYPAL',
            amountCents: payment.amountCents,
            paypalId: payment.paypalId,
            paypalMode: deps.mode(),
        }, deps.now())
        if (recorded.kind !== 'recorded') return recorded.kind
        const invoice = recorded.invoice
        const number = invoiceNumber(invoice.number)
        // Money that arrived for an invoice that was voided or already paid is said plainly, so it can be refunded
        const odd = recorded.paidNow ? '' : invoice.status === 'VOID' ? ', but it had been voided' : invoice.status === 'PAID' ? ', which was already paid' : ', which leaves some still owing'
        await deps.record({
            kind: 'billing.paid', actor: payerOf(invoice), target: target(invoice),
            summary: `${invoice.billToName} paid ${formatMoney(payment.amountCents, invoice.currency)} on ${number}${payment.automatic ? ' automatically' : ''} with PayPal${odd}`,
            detail: { paypalId: payment.paypalId, mode: deps.mode() },
        })
        await receipt(invoice, payment.amountCents, payment.automatic)
        return 'paid'
    }

    // The order behind a checkout, captured if the client approved it and nobody has yet. Called from the page
    // PayPal sends the client back to and from the webhook alike, and safe to call from both at once.
    async function settleOrder(orderId: string): Promise<{ kind: 'paid' | 'pending' | 'failed' | 'unknown', invoiceId: string | null, error?: string }> {
        const paypal = deps.paypal()
        if (!paypal) return { kind: 'unknown', invoiceId: null }
        let order: Order = await paypal.getOrder(orderId)
        const invoiceId = invoiceIdOf(order)
        if (!invoiceId) return { kind: 'unknown', invoiceId: null }
        const invoice = await deps.invoices.get(invoiceId)
        if (!invoice) return { kind: 'unknown', invoiceId: null }

        if (order.status === 'APPROVED') {
            try {
                order = await paypal.captureOrder(orderId)
            } catch (error) {
                if (error instanceof PaypalError && error.issue === 'ORDER_ALREADY_CAPTURED') {
                    order = await paypal.getOrder(orderId)
                } else if (error instanceof PaypalError && error.status === 422) {
                    // Declined, or the invoice number was paid already: nothing moved, and the client is told so
                    await deps.record({
                        kind: 'billing.paymentFailed', actor: payerOf(invoice), target: target(invoice),
                        summary: `PayPal did not take payment for ${invoiceNumber(invoice.number)}: ${error.issue ?? error.message}`,
                        detail: { orderId, issue: error.issue, debugId: error.debugId },
                    })
                    return { kind: 'failed', invoiceId, error: error.issue ?? error.message }
                } else throw error
            }
        }

        const capture = captureOf(order)
        if (!capture) return { kind: order.status === 'COMPLETED' ? 'failed' : 'pending', invoiceId }
        if (capture.status === 'PENDING') return { kind: 'pending', invoiceId }
        if (capture.status !== 'COMPLETED') return { kind: 'failed', invoiceId, error: capture.status }
        const cents = centsFromValue(capture.amount.value)
        if (cents === null || capture.amount.currency_code !== invoice.currency) {
            deps.log(`Order ${orderId} paid ${capture.amount.value} ${capture.amount.currency_code}, which is not an amount for ${invoiceId}`)
            return { kind: 'failed', invoiceId, error: 'AMOUNT' }
        }
        await paid(invoiceId, { paypalId: capture.id, amountCents: cents, automatic: false })
        return { kind: 'paid', invoiceId }
    }

    // A PayPal plan for this plan's price, in the PayPal mode the site is running in, made or repriced as needed
    async function ensurePaypalPlan(paypal: Paypal, plan: PlanView, mode: PaypalMode): Promise<string> {
        const business = deps.business()
        const total = planTotalCents(plan, business.gst)
        const value = paypalValue(total)
        if (plan.paypalMode === mode && plan.paypalPlanId) {
            if (plan.paypalPlanCents !== total) {
                await paypal.updatePlanPrice(plan.paypalPlanId, value, 'AUD')
                await deps.plans.setPaypalPlanCents(plan.id, total)
            }
            return plan.paypalPlanId
        }
        const productId = await paypal.createProduct({ name: `${business.name}: ${plan.description}`, requestId: `product-${plan.id}-${mode}` })
        const paypalPlanId = await paypal.createPlan({
            productId,
            name: `${plan.description} for ${plan.client.name}`,
            months: INTERVAL_MONTHS[plan.interval],
            value,
            currency: 'AUD',
            requestId: `plan-${plan.id}-${mode}-${total}`,
        })
        await deps.plans.setPaypalPlan(plan.id, { paypalMode: mode, paypalProductId: productId, paypalPlanId, paypalPlanCents: total }, plan.paypalMode !== mode)
        return paypalPlanId
    }

    async function cancelAtPaypal(plan: PlanView, reason: string): Promise<Outcome> {
        if (!plan.subscriptionId || plan.paypalMode !== deps.mode()) return { ok: true }
        const paypal = deps.paypal()
        if (!paypal) return fail('PayPal is not set up, so the automatic payment could not be cancelled there.')
        try {
            await paypal.cancelSubscription(plan.subscriptionId, reason)
        } catch (error) {
            // Already cancelled, or gone: either way it takes no more money
            const finished = error instanceof PaypalError && (error.status === 404 || error.issue === 'SUBSCRIPTION_STATUS_INVALID')
            if (!finished) {
                deps.log(`Cancelling subscription ${plan.subscriptionId} failed`, error)
                return fail('PayPal did not cancel the automatic payment. Try again, or cancel it from the PayPal dashboard.')
            }
        }
        return { ok: true }
    }

    const STOPPED = ['CANCELLED', 'SUSPENDED', 'EXPIRED']

    // A subscription moving, told by the return page or a webhook. Records the change once, not per telling.
    async function subscriptionChanged(subscriptionId: string, status: string, planId?: string): Promise<boolean> {
        const plan = (await deps.plans.bySubscription(subscriptionId)) ?? (planId ? await deps.plans.get(planId) : null)
        if (!plan || (plan.subscriptionId && plan.subscriptionId !== subscriptionId)) return false
        const before = plan.subscriptionStatus
        if (before === status) return true
        await deps.plans.setSubscription(plan.id, subscriptionId, status, plan.paypalMode ?? deps.mode())
        const wasOn = before === 'ACTIVE' || before === 'APPROVED'
        const isOn = status === 'ACTIVE' || status === 'APPROVED'
        if (isOn && !wasOn) {
            await deps.record({
                kind: 'billing.autopayStart', actor: { type: 'CLIENT', id: plan.clientId }, target: planTarget(plan),
                summary: `${plan.client.name} set ${plan.description} to pay automatically with PayPal`, detail: { subscriptionId, mode: plan.paypalMode },
            })
        } else if (STOPPED.includes(status) && wasOn) {
            await deps.record({
                kind: 'billing.autopayStop', actor: PAYPAL, target: planTarget(plan),
                summary: `PayPal reports automatic payment for ${plan.client.name}'s ${plan.description} is ${status.toLowerCase()}`,
                detail: { subscriptionId },
            })
        }
        return true
    }

    async function stopAutopay(planId: string, actor: Actor, clientId?: string): Promise<Outcome> {
        const plan = await deps.plans.get(planId)
        if (!plan || (clientId && plan.clientId !== clientId)) return fail('That plan could not be found.')
        if (!plan.subscriptionId) return { ok: true }
        const cancelled = await cancelAtPaypal(plan, 'Stopped from the Horizons portal')
        if (!cancelled.ok) return cancelled
        await deps.plans.setSubscription(plan.id, null, null, null)
        await deps.record({
            kind: 'billing.autopayStop', actor, target: planTarget(plan),
            summary: `Stopped automatic payment for ${plan.client.name}'s ${plan.description}`, detail: { subscriptionId: plan.subscriptionId },
        })
        return { ok: true }
    }

    return {
        settleOrder,
        subscriptionChanged,
        stopAutopay,

        // Draft to sent: numbered, emailed with its PDF, and visible to the client from now on
        async send(invoiceId: string, billTo: BillTo, actor: Actor): Promise<Outcome & { emailed?: boolean }> {
            const draft = await deps.invoices.get(invoiceId)
            if (!draft || draft.status !== 'DRAFT') return fail('Only a draft can be sent. Reload the page to see where it stands.')
            if (draft.dueOn < today()) return fail('The due date has passed. Choose a later one before sending it.')
            if (draft.totalCents <= 0) return fail('An invoice for nothing cannot be sent. Add a line with a price.')
            const invoice = await deps.invoices.issue(invoiceId, billTo, today(), deps.now())
            if (!invoice) return fail('Only a draft can be sent. Reload the page to see where it stands.')
            const emailed = await emailInvoice(invoice)
            await deps.record({
                kind: 'billing.invoiceSend', actor, target: target(invoice),
                summary: `Sent ${invoiceNumber(invoice.number)} to ${invoice.billToName} for ${formatMoney(invoice.totalCents, invoice.currency)}${emailed ? '' : ', but the email did not send'}`,
                detail: { total: invoice.totalCents, dueOn: invoice.dueOn },
            })
            return { ok: true, emailed }
        },

        async resend(invoiceId: string, actor: Actor): Promise<Outcome> {
            const invoice = await deps.invoices.get(invoiceId)
            if (!invoice || invoice.status === 'DRAFT') return fail('A draft has not been sent yet. Send it instead.')
            if (!(await emailInvoice(invoice))) return fail('The email did not send. The Emails log has the reason.')
            await deps.record({ kind: 'billing.invoiceResend', actor, target: target(invoice), summary: `Sent ${invoiceNumber(invoice.number)} to ${invoice.billToEmail} again` })
            return { ok: true }
        },

        // The operator chasing an invoice by hand: a reminder while it is due, a notice once it is late
        async chase(invoiceId: string, actor: Actor): Promise<Outcome> {
            const invoice = await deps.invoices.get(invoiceId)
            if (!invoice || invoice.status !== 'OPEN') return fail('Only an unpaid invoice can be chased.')
            const business = deps.business()
            const late = invoice.dueOn < today()
            const notice = invoice.overdueNotices + 1
            const sent = await mail(`Chasing ${invoiceId}`, options => (late
                ? overdueEmail(emailInvoiceOf(invoice), business, { ...options, notice })
                : reminderEmail(emailInvoiceOf(invoice), business, options)))
            if (!sent) return fail('The email did not send. The Emails log has the reason.')
            if (late) await deps.invoices.claimOverdueNotice(invoice.id, invoice.overdueNotices, deps.now())
            else await deps.invoices.claimReminder(invoice.id, deps.now())
            await deps.record({
                kind: late ? 'billing.overdue' : 'billing.reminder', actor, target: target(invoice),
                summary: late ? `Sent ${invoice.billToName} an overdue notice for ${invoiceNumber(invoice.number)}` : `Reminded ${invoice.billToName} that ${invoiceNumber(invoice.number)} is due`,
            })
            return { ok: true }
        },

        async markPaid(invoiceId: string, note: string | null, actor: Actor): Promise<Outcome> {
            const invoice = await deps.invoices.get(invoiceId)
            if (!invoice || invoice.status !== 'OPEN') return fail('Only an unpaid invoice can be marked paid.')
            const owing = invoice.totalCents - paidCentsOf(invoice)
            const recorded = await deps.invoices.recordPayment(invoiceId, { method: 'MANUAL', amountCents: owing, note }, deps.now())
            if (recorded.kind !== 'recorded') return fail('That did not work. Reload the page and try again.')
            await deps.record({
                kind: 'billing.markedPaid', actor, target: target(invoice),
                summary: `Marked ${invoiceNumber(invoice.number)} paid (${formatMoney(owing, invoice.currency)})${note ? `: ${note}` : ''}`,
            })
            return { ok: true }
        },

        async void(invoiceId: string, actor: Actor): Promise<Outcome> {
            const invoice = await deps.invoices.get(invoiceId)
            if (!invoice || !(await deps.invoices.voidInvoice(invoiceId, deps.now()))) return fail('Only an unpaid invoice can be voided.')
            await deps.record({ kind: 'billing.invoiceVoid', actor, target: target(invoice), summary: `Voided ${invoiceNumber(invoice.number)} for ${invoice.billToName}` })
            return { ok: true }
        },

        // The client pressing Pay: a PayPal order for what is owed, and where to send them to approve it
        async startCheckout(invoiceId: string, clientId: string, method: PayMethod = 'paypal'): Promise<{ ok: true, url: string } | { ok: false, error: string }> {
            const paypal = deps.paypal()
            if (!paypal) return { ok: false, error: 'Online payment is not available right now. Reply to the invoice email and I will sort it out.' }
            const invoice = await deps.invoices.get(invoiceId)
            if (!invoice || invoice.clientId !== clientId) return { ok: false, error: 'That invoice could not be found.' }
            if (invoice.status !== 'OPEN') return { ok: false, error: 'That invoice is not waiting to be paid.' }
            const owing = invoice.totalCents - paidCentsOf(invoice)
            const number = invoiceNumber(invoice.number)
            const siteUrl = deps.siteUrl()
            try {
                const order = await paypal.createOrder({
                    invoiceId: invoice.id,
                    invoiceNumber: number,
                    description: `Invoice ${number} from ${deps.business().name}`,
                    value: paypalValue(owing),
                    currency: invoice.currency,
                    returnUrl: `${siteUrl}/api/paypal/return`,
                    cancelUrl: `${siteUrl}/portal/billing/${invoice.id}?payment=cancelled`,
                    requestId: `order-${invoice.id}-${deps.now().getTime()}`,
                    method,
                })
                await deps.record({
                    kind: 'billing.checkout', actor: payerOf(invoice), target: target(invoice),
                    summary: `${invoice.billToName} started paying ${number} ${method === 'card' ? 'by card through PayPal' : 'with PayPal'}`,
                    detail: { orderId: order.id, mode: paypal.mode, method },
                })
                return { ok: true, url: order.approveUrl }
            } catch (error) {
                deps.log(`Starting checkout for ${invoiceId} failed`, error)
                return { ok: false, error: 'PayPal could not be reached. Please try again in a minute.' }
            }
        },

        // The client choosing to have a plan pay itself: a PayPal subscription at the plan's price
        async startAutopay(planId: string, clientId: string, method: PayMethod = 'paypal'): Promise<{ ok: true, url: string } | { ok: false, error: string }> {
            const paypal = deps.paypal()
            const mode = deps.mode()
            if (!paypal || !mode) return { ok: false, error: 'Automatic payment is not available right now.' }
            const plan = await deps.plans.get(planId)
            if (!plan || plan.clientId !== clientId || plan.endedAt) return { ok: false, error: 'That plan could not be found.' }
            if (plan.amountCents <= 0) return { ok: false, error: 'There is nothing to pay on that plan.' }
            if (autopayActive(plan, mode)) return { ok: false, error: 'That plan already pays automatically.' }
            const siteUrl = deps.siteUrl()
            try {
                // A subscription left suspended after failed payments is cancelled before a new one takes its place
                if (plan.subscriptionId && plan.paypalMode === mode && plan.subscriptionStatus === 'SUSPENDED') {
                    await cancelAtPaypal(plan, 'Replaced by a new automatic payment')
                }
                const paypalPlanId = await ensurePaypalPlan(paypal, plan, mode)
                const subscription = await paypal.createSubscription({
                    planId: paypalPlanId,
                    customId: plan.id,
                    subscriber: { name: plan.client.name, email: plan.client.email },
                    returnUrl: `${siteUrl}/api/paypal/subscribed?plan=${encodeURIComponent(plan.id)}`,
                    cancelUrl: `${siteUrl}/portal/billing?autopay=cancelled`,
                    requestId: `subscription-${plan.id}-${deps.now().getTime()}`,
                    method,
                })
                await deps.plans.setSubscription(plan.id, subscription.id, 'APPROVAL_PENDING', mode)
                return { ok: true, url: subscription.approveUrl }
            } catch (error) {
                deps.log(`Starting automatic payment for plan ${planId} failed`, error)
                return { ok: false, error: 'PayPal could not be reached. Please try again in a minute.' }
            }
        },

        // The client back from approving a subscription. PayPal's own record decides, never the address bar.
        async confirmSubscription(subscriptionId: string, planId: string): Promise<{ ok: boolean }> {
            const paypal = deps.paypal()
            if (!paypal) return { ok: false }
            const subscription = await paypal.getSubscription(subscriptionId)
            if (subscription.custom_id !== planId) return { ok: false }
            return { ok: await subscriptionChanged(subscriptionId, subscription.status, planId) }
        },

        // A plan whose price changed takes its PayPal plan with it, so the next automatic payment is the new price
        async repricePaypal(planId: string): Promise<Outcome> {
            const plan = await deps.plans.get(planId)
            const paypal = deps.paypal()
            const mode = deps.mode()
            if (!plan || !paypal || !mode || plan.paypalMode !== mode || !plan.paypalPlanId) return { ok: true }
            const total = planTotalCents(plan, deps.business().gst)
            if (plan.paypalPlanCents === total) return { ok: true }
            try {
                await ensurePaypalPlan(paypal, plan, mode)
                return { ok: true }
            } catch (error) {
                deps.log(`Repricing the PayPal plan for ${planId} failed`, error)
                return fail('Saved, but PayPal was not told the new price, so automatic payments still take the old one. Save again to retry.')
            }
        },

        // An automatic payment arriving. It settles the oldest open invoice the plan raised for that amount, or
        // raises the period's invoice already paid when there is none.
        async subscriptionPayment(saleId: string, subscriptionId: string, value: { total: string, currency: string }): Promise<void> {
            const plan = await deps.plans.bySubscription(subscriptionId)
            if (!plan) {
                deps.log(`A payment for subscription ${subscriptionId} arrived, and no plan has it`)
                return
            }
            if (await deps.invoices.hasPayment(saleId)) return
            const cents = centsFromValue(value.total)
            if (cents === null || value.currency !== 'AUD') {
                deps.log(`Subscription payment ${saleId} was ${value.total} ${value.currency}, which is not an amount this site takes`)
                return
            }
            const open = await deps.invoices.oldestOpenForPlan(plan.id, cents)
            if (open) {
                await paid(open, { paypalId: saleId, amountCents: cents, automatic: true })
                return
            }
            const gst = deps.business().gst
            const day = today()
            const invoice = await deps.invoices.createForPlan(plan, billToOf(plan.client), periodOf(plan, plan.periodsBilled), gst, day, day, deps.now(), {
                method: 'PAYPAL_AUTOPAY', paypalId: saleId, paypalMode: deps.mode() ?? 'sandbox', amountCents: cents,
            })
            if (!invoice) {
                deps.log(`Subscription payment ${saleId} could not claim a period of plan ${plan.id}`)
                return
            }
            await deps.record({
                kind: 'billing.paid', actor: { type: 'CLIENT', id: plan.clientId }, target: target(invoice),
                summary: `${plan.client.name} paid ${formatMoney(cents)} automatically for ${plan.description}, as ${invoiceNumber(invoice.number)}`,
                detail: { paypalId: saleId, subscriptionId, mode: deps.mode() },
            })
            await receipt(invoice, cents, true)
        },

        async refunded(captureId: string): Promise<void> {
            const invoice = await deps.invoices.markRefunded(captureId, deps.now())
            if (!invoice) return
            await deps.record({
                kind: 'billing.refund', actor: PAYPAL, target: target(invoice),
                summary: `A PayPal payment on ${invoiceNumber(invoice.number)} was refunded. The invoice still says paid: void it or chase it as fits.`,
                detail: { paypalId: captureId },
            })
        },

        async paymentFailed(invoiceOrPlan: { invoiceId?: string | null, subscriptionId?: string | null }, reason: string): Promise<void> {
            if (invoiceOrPlan.invoiceId) {
                const invoice = await deps.invoices.get(invoiceOrPlan.invoiceId)
                if (invoice) {
                    await deps.record({ kind: 'billing.paymentFailed', actor: PAYPAL, target: target(invoice), summary: `PayPal did not take payment for ${invoiceNumber(invoice.number)}: ${reason}` })
                }
                return
            }
            if (invoiceOrPlan.subscriptionId) {
                const plan = await deps.plans.bySubscription(invoiceOrPlan.subscriptionId)
                if (plan) {
                    await deps.record({
                        kind: 'billing.paymentFailed', actor: PAYPAL, target: planTarget(plan),
                        summary: `An automatic payment for ${plan.client.name}'s ${plan.description} failed: ${reason}`,
                    })
                }
            }
        },

        // Ending a plan stops what it takes: no more invoices from it, and no more automatic payments
        async endPlan(planId: string, actor: Actor): Promise<Outcome> {
            const plan = await deps.plans.get(planId)
            if (!plan || plan.endedAt) return fail('That plan has already ended.')
            const stopped = await stopAutopay(planId, actor)
            if (!stopped.ok) return stopped
            await deps.plans.end(planId, deps.now())
            await deps.record({ kind: 'billing.planEnd', actor, target: planTarget(plan), summary: `Ended ${plan.client.name}'s ${plan.description}` })
            return { ok: true }
        },

        // Before a client is deleted: their plans go with them, so PayPal must stop taking money for them first
        async stopAllForClient(clientId: string, actor: Actor): Promise<Outcome> {
            const plans = await deps.plans.list({ clientId, includeEnded: true })
            for (const plan of plans) {
                const stopped = await stopAutopay(plan.id, actor)
                if (!stopped.ok) return stopped
            }
            return { ok: true }
        },

        // The hourly run. Raises each plan's invoice when its period starts, then reminds and chases.
        async run(): Promise<{ raised: number, reminders: number, notices: number }> {
            const now = deps.now()
            const day = todayIn(now)
            const mode = deps.mode()
            const business = deps.business()
            let raised = 0
            let reminders = 0
            let notices = 0

            for (let plan of await deps.plans.running()) {
                for (let round = 0; round < MAX_CATCH_UP && planDue(plan, day, mode); round++) {
                    const period = periodOf(plan, plan.periodsBilled)
                    const invoice = await deps.invoices.createForPlan(plan, billToOf(plan.client), period, business.gst, day, addDays(day, plan.dueDays), now)
                    // Another run claimed this period first
                    if (!invoice) break
                    raised++
                    plan = { ...plan, periodsBilled: plan.periodsBilled + 1 }
                    const emailed = await emailInvoice(invoice)
                    await deps.record({
                        kind: 'billing.invoiceSend', actor: BILLING_RUN, target: target(invoice),
                        summary: `Raised ${invoiceNumber(invoice.number)} for ${plan.client.name}'s ${plan.description}, ${period.start} to ${period.end}${emailed ? '' : ', but the email did not send'}`,
                        detail: { plan: plan.id, total: invoice.totalCents },
                    })
                }
            }

            const hour = hourIn(now)
            if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return { raised, reminders, notices }

            for (const invoice of await deps.invoices.openInvoices()) {
                // A plan that pays itself is about to be paid; chasing it would only worry the client
                if (invoice.plan && autopayActive(invoice.plan, mode)) continue
                const number = invoiceNumber(invoice.number)

                if (invoice.dueOn >= day) {
                    const left = daysBetween(day, invoice.dueOn)
                    const gave = invoice.issuedOn ? daysBetween(invoice.issuedOn, invoice.dueOn) : 0
                    if (left > REMINDER_DAYS_BEFORE || gave <= REMINDER_DAYS_BEFORE || invoice.reminderSentAt) continue
                    if (!(await deps.invoices.claimReminder(invoice.id, now))) continue
                    const sent = await mail(`Reminder for ${invoice.id}`, options => reminderEmail(emailInvoiceOf(invoice), business, options))
                    reminders++
                    await deps.record({
                        kind: 'billing.reminder', actor: BILLING_RUN, target: target(invoice),
                        summary: `Reminded ${invoice.billToName} that ${number} is due ${invoice.dueOn}${sent ? '' : ', but the email did not send'}`,
                    })
                    continue
                }

                const late = daysBetween(invoice.dueOn, day)
                const sentSoFar = invoice.overdueNotices
                if (sentSoFar >= OVERDUE_NOTICE_DAYS.length || late < OVERDUE_NOTICE_DAYS[sentSoFar]) continue
                if (invoice.lastOverdueNoticeAt && daysBetween(todayIn(invoice.lastOverdueNoticeAt), day) < MIN_DAYS_BETWEEN_NOTICES) continue
                if (!(await deps.invoices.claimOverdueNotice(invoice.id, sentSoFar, now))) continue
                const sent = await mail(`Overdue notice for ${invoice.id}`, options =>
                    overdueEmail(emailInvoiceOf(invoice), business, { ...options, notice: sentSoFar + 1 }))
                notices++
                await deps.record({
                    kind: 'billing.overdue', actor: BILLING_RUN, target: target(invoice),
                    summary: `Sent ${invoice.billToName} overdue notice ${sentSoFar + 1} of ${OVERDUE_NOTICE_DAYS.length} for ${number}, ${late} days late${sent ? '' : ', but the email did not send'}`,
                })
            }
            return { raised, reminders, notices }
        },
    }
}

export type Billing = ReturnType<typeof createBilling>
