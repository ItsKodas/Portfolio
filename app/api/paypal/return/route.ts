import { NextResponse } from 'next/server'

import { billing, log } from '@/server/invoices/wiring'

export const dynamic = 'force-dynamic'

// Where PayPal sends the client after they approve a payment, with the order as ?token=. The order is captured
// here, and the client lands back on the invoice. Outside /portal on purpose: it needs no session, because the
// order alone says which invoice it pays, and the cookie may not survive the trip through PayPal.
export async function GET(request: Request) {
    const url = new URL(request.url)
    const orderId = url.searchParams.get('token')
    const base = (process.env.AUTH_URL ?? url.origin).replace(/\/+$/, '')
    if (!orderId || orderId.length > 64) return NextResponse.redirect(`${base}/portal/billing`)

    try {
        const result = await billing().settleOrder(orderId)
        if (!result.invoiceId) return NextResponse.redirect(`${base}/portal/billing`)
        return NextResponse.redirect(`${base}/portal/billing/${result.invoiceId}?payment=${result.kind === 'unknown' ? 'failed' : result.kind}`)
    } catch (error) {
        log(`Settling order ${orderId} on return failed`, error)
        // The webhook will settle it if the money moved; the client is told it is still being processed
        return NextResponse.redirect(`${base}/portal/billing?payment=pending`)
    }
}
