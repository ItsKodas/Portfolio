// Which PayPal the site talks to, and with what. PAYPAL_MODE picks the sandbox (test money, the default) or live
// (real money); each has its own API host, its own app credentials and its own webhook, and nothing made in one
// exists in the other. Live is refused outside a production build, so a laptop running `npm run dev` with the
// server's .env copied over cannot take anyone's money.

import 'server-only'

import { required, type Env } from '../env'

export type PaypalMode = 'sandbox' | 'live'

export type PaypalConfig = {
    mode: PaypalMode
    apiBase: string
    clientId: string
    secret: string
    // Without it webhooks cannot be verified, so they are refused; checkout still works, settled on the return
    webhookId: string | null
    // Shown on PayPal's pages, and where it sends the client back to
    brandName: string
    siteUrl: string
}

export const API_BASE: Record<PaypalMode, string> = {
    sandbox: 'https://api-m.sandbox.paypal.com',
    live: 'https://api-m.paypal.com',
}

export type PaypalSetup = { ok: true, value: PaypalConfig } | { ok: false, mode: PaypalMode | null, problems: string[] }

export function modeOf(env: Env = process.env): PaypalMode | null {
    const mode = env.PAYPAL_MODE?.trim().toLowerCase() || 'sandbox'
    return mode === 'sandbox' || mode === 'live' ? mode : null
}

export function readPaypal(env: Env = process.env): PaypalSetup {
    const problems: string[] = []
    const mode = modeOf(env)
    if (!mode) problems.push('PAYPAL_MODE must be sandbox or live')
    if (mode === 'live' && env.NODE_ENV !== 'production') problems.push('PAYPAL_MODE=live only runs in a production build; use sandbox while developing')
    const clientId = required(env, 'PAYPAL_CLIENT_ID', problems)
    // Not trimmed into something else: a secret is used exactly as it was given
    const secret = env.PAYPAL_CLIENT_SECRET?.trim() ?? ''
    if (!secret) problems.push('PAYPAL_CLIENT_SECRET is not set')
    const siteUrl = required(env, 'AUTH_URL', problems).replace(/\/+$/, '')
    if (problems.length || !mode) return { ok: false, mode, problems }
    return {
        ok: true,
        value: {
            mode,
            apiBase: API_BASE[mode],
            clientId,
            secret,
            webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
            brandName: env.BUSINESS_NAME?.trim() || 'Horizons',
            siteUrl,
        },
    }
}
