import { NextResponse } from 'next/server'

import { billing, log } from '@/server/invoices/wiring'

export const dynamic = 'force-dynamic'

// Where PayPal sends the client after they approve automatic payment, with ?subscription_id=. PayPal's own record
// of the subscription decides whether it is on; the query only says which one to ask about.
export async function GET(request: Request) {
    const url = new URL(request.url)
    const subscriptionId = url.searchParams.get('subscription_id')
    const planId = url.searchParams.get('plan')
    const base = (process.env.AUTH_URL ?? url.origin).replace(/\/+$/, '')
    if (!subscriptionId || !planId || subscriptionId.length > 64 || planId.length > 64) {
        return NextResponse.redirect(`${base}/portal/billing?autopay=failed`)
    }
    try {
        const result = await billing().confirmSubscription(subscriptionId, planId)
        return NextResponse.redirect(`${base}/portal/billing?autopay=${result.ok ? 'on' : 'failed'}`)
    } catch (error) {
        log(`Confirming subscription ${subscriptionId} failed`, error)
        return NextResponse.redirect(`${base}/portal/billing?autopay=failed`)
    }
}
