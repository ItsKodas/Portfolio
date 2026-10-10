import { describe, expect, it } from 'vitest'

import { captureOf, createPaypal, invoiceIdOf, PaypalError } from './api'
import type { PaypalConfig } from './config'

const config: PaypalConfig = {
    mode: 'sandbox', apiBase: 'https://api-m.sandbox.paypal.com', clientId: 'id', secret: 'secret', webhookId: 'WH-1',
    brandName: 'Horizons', siteUrl: 'https://www.horizons.gg',
}

type Call = { url: string, init: RequestInit }

// Answers the token call itself, and everything else from the queue in order
function stub(answers: { status?: number, body?: unknown }[]) {
    const calls: Call[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 32_400 }), { status: 200 })
        const answer = answers.shift() ?? { status: 500, body: {} }
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
    }) as typeof fetch
    return { calls, fetchImpl }
}

const body = (call: Call) => JSON.parse(String(call.init.body))
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name]

describe('createPaypal', () => {
    it('makes an order for the invoice and hands back where to approve it', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://paypal.example/approve' }] } }])
        const paypal = createPaypal(config, fetchImpl)
        const order = await paypal.createOrder({
            invoiceId: 'inv1', invoiceNumber: 'INV-0001', description: 'Invoice INV-0001 from Horizons', value: '49.00', currency: 'AUD',
            returnUrl: 'https://www.horizons.gg/api/paypal/return', cancelUrl: 'https://www.horizons.gg/portal/billing/inv1', requestId: 'r1',
        })
        expect(order).toEqual({ id: 'ORDER1', approveUrl: 'https://paypal.example/approve' })
        expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
        expect(header(calls[0], 'Authorization')).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`)
        expect(calls[1].url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders')
        expect(header(calls[1], 'PayPal-Request-Id')).toBe('r1')
        expect(body(calls[1]).purchase_units[0]).toMatchObject({ custom_id: 'inv1', invoice_id: 'INV-0001', amount: { currency_code: 'AUD', value: '49.00' } })
        expect(body(calls[1]).payment_source.paypal.experience_context).toMatchObject({ shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', landing_page: 'LOGIN' })
    })

    it('opens straight on the card form for a client paying by card', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'O', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://a' }] } }])
        await createPaypal(config, fetchImpl).createOrder({
            invoiceId: 'inv1', invoiceNumber: 'INV-0001', description: 'd', value: '49.00', currency: 'AUD',
            returnUrl: 'https://r', cancelUrl: 'https://c', requestId: 'r1', method: 'card',
        })
        expect(body(calls[1]).payment_source.paypal.experience_context.landing_page).toBe('GUEST_ONLY')
    })

    it('reuses its access token', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'O', status: 'APPROVED' } }, { body: { id: 'O', status: 'APPROVED' } }])
        const paypal = createPaypal(config, fetchImpl)
        await paypal.getOrder('O')
        await paypal.getOrder('O')
        expect(calls.filter(call => call.url.endsWith('/oauth2/token'))).toHaveLength(1)
    })

    it('says what PayPal refused, with its issue and debug id', async () => {
        const { fetchImpl } = stub([{ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg', details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Already captured.' }] } }])
        const error = await createPaypal(config, fetchImpl).captureOrder('O').catch(thrown => thrown)
        expect(error).toBeInstanceOf(PaypalError)
        expect(error).toMatchObject({ status: 422, issue: 'ORDER_ALREADY_CAPTURED', debugId: 'dbg', message: 'Already captured.' })
    })

    it('captures with a request id of its own, so a second capture is the first one again', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'O', status: 'COMPLETED' } }])
        await createPaypal(config, fetchImpl).captureOrder('O')
        expect(header(calls[1], 'PayPal-Request-Id')).toBe('capture-O')
    })

    it('makes a monthly or a yearly plan', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'P-1' } }, { body: { id: 'P-2' } }])
        const paypal = createPaypal(config, fetchImpl)
        await paypal.createPlan({ productId: 'PROD', name: 'Hosting', months: 1, value: '49.00', currency: 'AUD', requestId: 'a' })
        await paypal.createPlan({ productId: 'PROD', name: 'Hosting', months: 12, value: '490.00', currency: 'AUD', requestId: 'b' })
        expect(body(calls[1]).billing_cycles[0].frequency).toEqual({ interval_unit: 'MONTH', interval_count: 1 })
        expect(body(calls[2]).billing_cycles[0].frequency).toEqual({ interval_unit: 'YEAR', interval_count: 1 })
        expect(body(calls[2]).billing_cycles[0].pricing_scheme.fixed_price).toEqual({ value: '490.00', currency_code: 'AUD' })
    })

    it('subscribes the client by name and email', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'I-1', status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: 'https://paypal.example/sub' }] } }])
        const result = await createPaypal(config, fetchImpl).createSubscription({
            planId: 'P-1', customId: 'plan1', subscriber: { name: 'Ann van Lee', email: 'ann@example.com' },
            returnUrl: 'https://r', cancelUrl: 'https://c', requestId: 's',
        })
        expect(result).toEqual({ id: 'I-1', approveUrl: 'https://paypal.example/sub' })
        expect(body(calls[1]).subscriber).toEqual({ name: { given_name: 'Ann', surname: 'van Lee' }, email_address: 'ann@example.com' })
        expect(body(calls[1]).custom_id).toBe('plan1')
        expect(body(calls[1]).application_context.landing_page).toBe('LOGIN')
    })

    it('opens a subscription on the card form for a client paying by card', async () => {
        const { calls, fetchImpl } = stub([{ body: { id: 'I-1', status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: 'https://a' }] } }])
        await createPaypal(config, fetchImpl).createSubscription({
            planId: 'P-1', customId: 'plan1', subscriber: { name: 'Ann', email: 'ann@example.com' },
            returnUrl: 'https://r', cancelUrl: 'https://c', requestId: 's', method: 'card',
        })
        expect(body(calls[1]).application_context.landing_page).toBe('BILLING')
    })

    it('verifies a webhook with PayPal, against the configured webhook', async () => {
        const { calls, fetchImpl } = stub([{ body: { verification_status: 'SUCCESS' } }, { body: { verification_status: 'FAILURE' } }])
        const paypal = createPaypal(config, fetchImpl)
        const headers = new Headers({ 'paypal-transmission-id': 't', 'paypal-transmission-sig': 'sig', 'paypal-auth-algo': 'SHA256withRSA' })
        const event = { id: 'WH-EVENT', event_type: 'PAYMENT.CAPTURE.COMPLETED' }
        expect(await paypal.verifyWebhook(headers, event)).toBe(true)
        expect(body(calls[1])).toMatchObject({ webhook_id: 'WH-1', transmission_id: 't', transmission_sig: 'sig', webhook_event: event })
        expect(await paypal.verifyWebhook(headers, event)).toBe(false)
    })

    it('refuses every webhook when no webhook id is set', async () => {
        const { calls, fetchImpl } = stub([])
        expect(await createPaypal({ ...config, webhookId: null }, fetchImpl).verifyWebhook(new Headers(), {})).toBe(false)
        expect(calls).toHaveLength(0)
    })
})

describe('reading an order', () => {
    it('finds the invoice and the capture', () => {
        const order = { id: 'O', status: 'COMPLETED', purchase_units: [{ custom_id: 'inv1', payments: { captures: [{ id: 'CAP', status: 'COMPLETED', amount: { currency_code: 'AUD', value: '1.00' } }] } }] }
        expect(invoiceIdOf(order)).toBe('inv1')
        expect(captureOf(order)?.id).toBe('CAP')
        expect(captureOf({ id: 'O', status: 'APPROVED' })).toBeNull()
    })
})
