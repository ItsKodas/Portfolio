// The handful of PayPal REST calls invoicing needs, over plain fetch: Orders v2 for paying an invoice once,
// Catalog Products, Billing Plans and Subscriptions for paying a plan automatically, and webhook verification.
// fetch is a parameter, so the tests run every call against a stand-in and never reach PayPal.

import 'server-only'

import type { PaypalConfig } from './config'

export type Fetch = typeof fetch

export class PaypalError extends Error {
    constructor(message: string, readonly status: number, readonly issue: string | null, readonly debugId: string | null) {
        super(message)
        this.name = 'PaypalError'
    }
}

type Link = { href: string, rel: string, method?: string }

export type Money = { currency_code: string, value: string }

export type Capture = { id: string, status: string, amount: Money, invoice_id?: string, custom_id?: string }

export type Order = {
    id: string
    status: string
    links?: Link[]
    purchase_units?: {
        reference_id?: string
        custom_id?: string
        invoice_id?: string
        amount?: Money
        payments?: { captures?: Capture[] }
    }[]
}

export type Subscription = {
    id: string
    status: string
    plan_id?: string
    custom_id?: string
    links?: Link[]
    billing_info?: { next_billing_time?: string, last_payment?: { amount?: Money, time?: string } }
}

// How long a token is trusted for: PayPal's live for about nine hours, and a minute is taken off so one never
// expires between being read and being used
const TOKEN_MARGIN_MS = 60_000

const linkOf = (links: Link[] | undefined, ...rels: string[]): string | null =>
    links?.find(link => rels.includes(link.rel))?.href ?? null

export function createPaypal(config: PaypalConfig, fetchImpl: Fetch = fetch, now: () => number = Date.now) {
    let token: { value: string, expiresAt: number } | null = null

    async function accessToken(): Promise<string> {
        if (token && token.expiresAt > now()) return token.value
        const response = await fetchImpl(`${config.apiBase}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(20_000),
        })
        const body = await response.json().catch(() => null) as { access_token?: string, expires_in?: number, error_description?: string } | null
        if (!response.ok || !body?.access_token) {
            throw new PaypalError(`PayPal refused the app credentials: ${body?.error_description ?? response.status}`, response.status, 'AUTHENTICATION', null)
        }
        token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 - TOKEN_MARGIN_MS }
        return token.value
    }

    // requestId makes a create safe to repeat: PayPal answers the same request id with the first result
    async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, requestId?: string): Promise<T> {
        const response = await fetchImpl(`${config.apiBase}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${await accessToken()}`,
                'Content-Type': 'application/json',
                Prefer: 'return=representation',
                ...(requestId && { 'PayPal-Request-Id': requestId }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        })
        if (response.status === 204) return undefined as T
        const text = await response.text()
        const parsed = text ? JSON.parse(text) as Record<string, unknown> : {}
        if (!response.ok) {
            const details = parsed.details as { issue?: string, description?: string }[] | undefined
            const issue = details?.[0]?.issue ?? (parsed.name as string | undefined) ?? null
            const message = details?.[0]?.description ?? (parsed.message as string | undefined) ?? `PayPal answered ${response.status}`
            throw new PaypalError(message, response.status, issue, (parsed.debug_id as string | undefined) ?? null)
        }
        return parsed as T
    }

    const experience = (returnUrl: string, cancelUrl: string) => ({
        brand_name: config.brandName.slice(0, 127),
        shipping_preference: 'NO_SHIPPING',
        return_url: returnUrl,
        cancel_url: cancelUrl,
    })

    return {
        mode: config.mode,

        // One purchase unit for the whole invoice. custom_id carries our invoice id back on every event about
        // it; invoice_id is the number the client sees, and PayPal refuses a second capture against it.
        createOrder: async (input: {
            invoiceId: string, invoiceNumber: string, description: string, value: string, currency: string,
            returnUrl: string, cancelUrl: string, requestId: string,
        }): Promise<{ id: string, approveUrl: string }> => {
            const order = await call<Order>('POST', '/v2/checkout/orders', {
                intent: 'CAPTURE',
                purchase_units: [{
                    reference_id: input.invoiceId,
                    custom_id: input.invoiceId,
                    invoice_id: input.invoiceNumber,
                    description: input.description.slice(0, 127),
                    amount: { currency_code: input.currency, value: input.value },
                }],
                payment_source: {
                    paypal: { experience_context: { ...experience(input.returnUrl, input.cancelUrl), user_action: 'PAY_NOW' } },
                },
            }, input.requestId)
            const approveUrl = linkOf(order.links, 'payer-action', 'approve')
            if (!approveUrl) throw new PaypalError('PayPal did not say where to send the client to pay', 502, null, null)
            return { id: order.id, approveUrl }
        },

        getOrder: (id: string) => call<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`),

        // Repeating a capture with the same request id answers with the first capture, not a second payment
        captureOrder: (id: string) =>
            call<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `capture-${id}`),

        createProduct: async (input: { name: string, requestId: string }): Promise<string> =>
            (await call<{ id: string }>('POST', '/v1/catalogs/products', {
                name: input.name.slice(0, 127), type: 'SERVICE',
            }, input.requestId)).id,

        createPlan: async (input: {
            productId: string, name: string, months: number, value: string, currency: string, requestId: string,
        }): Promise<string> =>
            (await call<{ id: string }>('POST', '/v1/billing/plans', {
                product_id: input.productId,
                name: input.name.slice(0, 127),
                status: 'ACTIVE',
                billing_cycles: [{
                    frequency: input.months === 12 ? { interval_unit: 'YEAR', interval_count: 1 } : { interval_unit: 'MONTH', interval_count: input.months },
                    tenure_type: 'REGULAR',
                    sequence: 1,
                    // Zero is "until cancelled"
                    total_cycles: 0,
                    pricing_scheme: { fixed_price: { value: input.value, currency_code: input.currency } },
                }],
                payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
            }, input.requestId)).id,

        // Takes effect from the next payment of every subscription on the plan, and PayPal tells the subscriber
        updatePlanPrice: (planId: string, value: string, currency: string) =>
            call<void>('POST', `/v1/billing/plans/${encodeURIComponent(planId)}/update-pricing-schemes`, {
                pricing_schemes: [{ billing_cycle_sequence: 1, pricing_scheme: { fixed_price: { value, currency_code: currency } } }],
            }),

        // With no start_time the first payment is taken as soon as the client approves, which settles the open
        // invoice they were looking at when they set it up
        createSubscription: async (input: {
            planId: string, customId: string, subscriber: { name: string, email: string },
            returnUrl: string, cancelUrl: string, requestId: string,
        }): Promise<{ id: string, approveUrl: string }> => {
            const [given, ...rest] = input.subscriber.name.trim().split(/\s+/)
            const subscription = await call<Subscription>('POST', '/v1/billing/subscriptions', {
                plan_id: input.planId,
                custom_id: input.customId,
                subscriber: {
                    name: { given_name: (given || input.subscriber.name).slice(0, 140), ...(rest.length && { surname: rest.join(' ').slice(0, 140) }) },
                    email_address: input.subscriber.email,
                },
                application_context: { ...experience(input.returnUrl, input.cancelUrl), user_action: 'SUBSCRIBE_NOW' },
            }, input.requestId)
            const approveUrl = linkOf(subscription.links, 'approve')
            if (!approveUrl) throw new PaypalError('PayPal did not say where to send the client to approve', 502, null, null)
            return { id: subscription.id, approveUrl }
        },

        getSubscription: (id: string) => call<Subscription>('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`),

        cancelSubscription: (id: string, reason: string) =>
            call<void>('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 127) }),

        // PayPal checks the signature itself. The event must go back exactly as it arrived, so it is passed as
        // the parsed body rather than rebuilt.
        verifyWebhook: async (headers: Headers, event: unknown): Promise<boolean> => {
            if (!config.webhookId) return false
            const header = (name: string) => headers.get(name) ?? ''
            const result = await call<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
                auth_algo: header('paypal-auth-algo'),
                cert_url: header('paypal-cert-url'),
                transmission_id: header('paypal-transmission-id'),
                transmission_sig: header('paypal-transmission-sig'),
                transmission_time: header('paypal-transmission-time'),
                webhook_id: config.webhookId,
                webhook_event: event,
            })
            return result.verification_status === 'SUCCESS'
        },
    }
}

export type Paypal = ReturnType<typeof createPaypal>

// The capture an order's payment produced, if it has one
export const captureOf = (order: Order): Capture | null =>
    order.purchase_units?.flatMap(unit => unit.payments?.captures ?? [])[0] ?? null

export const invoiceIdOf = (order: Order): string | null =>
    order.purchase_units?.[0]?.custom_id ?? order.purchase_units?.[0]?.reference_id ?? null
