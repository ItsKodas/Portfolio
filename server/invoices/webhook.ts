// What each PayPal webhook event means here. The route verifies the event with PayPal first; this only reads it.
// Everything it calls is safe to run twice, because PayPal retries an event it thinks was missed, and the same
// payment can arrive here and on the page the client returns to at the same moment.

import 'server-only'

import type { Billing } from './billing'

export type PaypalEvent = { id?: string, event_type?: string, resource_type?: string, resource?: Record<string, unknown> }

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

// A refund names its capture only by link: the "up" link ends in the capture's id
function refundedCapture(resource: Record<string, unknown>): string | null {
    const links = Array.isArray(resource.links) ? resource.links as { rel?: string, href?: string }[] : []
    const up = links.find(link => link.rel === 'up')?.href
    const match = up?.match(/\/captures\/([^/?#]+)/)
    return match?.[1] ?? null
}

export type Handled = 'handled' | 'ignored'

export async function handlePaypalEvent(billing: Pick<Billing, 'settleOrder' | 'subscriptionChanged' | 'subscriptionPayment' | 'refunded' | 'paymentFailed'>, event: PaypalEvent): Promise<Handled> {
    const resource = event.resource ?? {}
    switch (event.event_type) {
        // The client approved and then never came back to the site: the order is captured from here instead
        case 'CHECKOUT.ORDER.APPROVED': {
            const id = text(resource.id)
            if (!id) return 'ignored'
            await billing.settleOrder(id)
            return 'handled'
        }

        // A capture that finished later than the return page, such as one PayPal held for review
        case 'PAYMENT.CAPTURE.COMPLETED': {
            const related = (resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids
            const orderId = text(related?.order_id)
            if (!orderId) return 'ignored'
            await billing.settleOrder(orderId)
            return 'handled'
        }

        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED':
            await billing.paymentFailed({ invoiceId: text(resource.custom_id) }, String(event.event_type).split('.').pop()!.toLowerCase())
            return 'handled'

        case 'PAYMENT.CAPTURE.REFUNDED': {
            const capture = refundedCapture(resource)
            if (!capture) return 'ignored'
            await billing.refunded(capture)
            return 'handled'
        }

        // A subscription's payment. Still the v1 "sale" shape, with the subscription as billing_agreement_id.
        case 'PAYMENT.SALE.COMPLETED': {
            const saleId = text(resource.id)
            const subscriptionId = text(resource.billing_agreement_id)
            const amount = resource.amount as { total?: string, currency?: string } | undefined
            if (!saleId || !subscriptionId || !amount?.total || !amount.currency) return 'ignored'
            await billing.subscriptionPayment(saleId, subscriptionId, { total: amount.total, currency: amount.currency })
            return 'handled'
        }

        case 'BILLING.SUBSCRIPTION.ACTIVATED':
        case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
        case 'BILLING.SUBSCRIPTION.SUSPENDED':
        case 'BILLING.SUBSCRIPTION.CANCELLED':
        case 'BILLING.SUBSCRIPTION.EXPIRED': {
            const id = text(resource.id)
            const status = text(resource.status)
            if (!id || !status) return 'ignored'
            await billing.subscriptionChanged(id, status)
            return 'handled'
        }

        case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
            const id = text(resource.id)
            if (!id) return 'ignored'
            await billing.paymentFailed({ subscriptionId: id }, 'PayPal could not take it, and will try again')
            return 'handled'
        }

        default:
            return 'ignored'
    }
}
