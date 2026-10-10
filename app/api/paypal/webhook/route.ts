import { handlePaypalEvent, type PaypalEvent } from '@/server/invoices/webhook'
import { billing, log, paypal } from '@/server/invoices/wiring'

export const dynamic = 'force-dynamic'

// PayPal's webhook: payments, refunds and subscriptions changing. Every event is checked with PayPal before it is
// believed, since anyone can post to this address. Answers 200 once handled, and 500 when something went wrong
// here, so PayPal sends it again later.
export async function POST(request: Request) {
    const client = paypal()
    if (!client) return new Response('PayPal is not set up.', { status: 503 })

    let event: PaypalEvent
    try {
        event = await request.json() as PaypalEvent
    } catch {
        return new Response('Not JSON.', { status: 400 })
    }

    try {
        if (!(await client.verifyWebhook(request.headers, event))) {
            log(`A webhook claiming to be ${event.event_type ?? 'something'} failed verification`)
            return new Response('Not verified.', { status: 400 })
        }
    } catch (error) {
        log('Verifying a webhook failed', error)
        return new Response('Could not verify.', { status: 500 })
    }

    try {
        await handlePaypalEvent(billing(), event)
        return new Response('OK')
    } catch (error) {
        log(`Handling webhook ${event.id} (${event.event_type}) failed`, error)
        return new Response('Failed.', { status: 500 })
    }
}
