import { describe, expect, it } from 'vitest'

import { handlePaypalEvent } from './webhook'

function fakeBilling() {
    const calls: unknown[][] = []
    const track = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return undefined as never }
    return {
        calls,
        billing: {
            settleOrder: track('settleOrder'),
            subscriptionChanged: track('subscriptionChanged'),
            subscriptionPayment: track('subscriptionPayment'),
            refunded: track('refunded'),
            paymentFailed: track('paymentFailed'),
        },
    }
}

describe('handlePaypalEvent', () => {
    it('settles an order the client approved but never came back from', async () => {
        const { calls, billing } = fakeBilling()
        expect(await handlePaypalEvent(billing, { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1' } })).toBe('handled')
        expect(await handlePaypalEvent(billing, {
            event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP', supplementary_data: { related_ids: { order_id: 'ORDER-2' } } },
        })).toBe('handled')
        expect(calls).toEqual([['settleOrder', 'ORDER-1'], ['settleOrder', 'ORDER-2']])
    })

    it('reads a subscription payment from its sale', async () => {
        const { calls, billing } = fakeBilling()
        await handlePaypalEvent(billing, {
            event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE-1', billing_agreement_id: 'I-1', amount: { total: '49.00', currency: 'AUD' } },
        })
        expect(calls).toEqual([['subscriptionPayment', 'SALE-1', 'I-1', { total: '49.00', currency: 'AUD' }]])
    })

    it('finds the refunded capture from its link', async () => {
        const { calls, billing } = fakeBilling()
        await handlePaypalEvent(billing, {
            event_type: 'PAYMENT.CAPTURE.REFUNDED',
            resource: { id: 'REFUND', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP-9' }] },
        })
        expect(calls).toEqual([['refunded', 'CAP-9']])
    })

    it('follows a subscription as it changes', async () => {
        const { calls, billing } = fakeBilling()
        await handlePaypalEvent(billing, { event_type: 'BILLING.SUBSCRIPTION.SUSPENDED', resource: { id: 'I-1', status: 'SUSPENDED' } })
        await handlePaypalEvent(billing, { event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', resource: { id: 'I-1', status: 'ACTIVE' } })
        expect(calls[0]).toEqual(['subscriptionChanged', 'I-1', 'SUSPENDED'])
        expect(calls[1][0]).toBe('paymentFailed')
    })

    it('ignores what it does not use, and what is missing its ids', async () => {
        const { calls, billing } = fakeBilling()
        expect(await handlePaypalEvent(billing, { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} })).toBe('ignored')
        expect(await handlePaypalEvent(billing, { event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE' } })).toBe('ignored')
        expect(calls).toEqual([])
    })
})
