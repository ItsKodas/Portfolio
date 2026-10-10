// Who the invoices are from. Read from the environment with defaults, so an invoice can always be drawn,
// and the ABN in particular is never missing: an invoice without one can have 47% of it withheld by the
// payer under the PAYG no-ABN rules.

import 'server-only'

import type { Env } from '../env'

export type Business = {
    name: string
    abn: string
    email: string
    // Lines of a postal address, when one is set. Optional for a sole trader working from home.
    address: string[]
    website: string
    // Registered for GST. Off unless set, because charging GST without being registered is not allowed, and
    // an invoice that does not charge it must not call itself a tax invoice.
    gst: boolean
}

export const DEFAULT_ABN = '23 545 335 026'

export function businessDetails(env: Env = process.env): Business {
    const text = (name: string) => env[name]?.trim() || undefined
    return {
        name: text('BUSINESS_NAME') ?? 'Horizons',
        abn: text('BUSINESS_ABN') ?? DEFAULT_ABN,
        email: text('BUSINESS_EMAIL') ?? text('CLIENT_REPLY_TO') ?? 'info@horizons.gg',
        // One line in the env file, with a | between the lines of the address
        address: (text('BUSINESS_ADDRESS') ?? '').split(/\s*[|]\s*/).filter(Boolean),
        website: (text('AUTH_URL') ?? 'https://www.horizons.gg').replace(/\/+$/, ''),
        gst: /^(1|true|yes)$/i.test(text('GST_REGISTERED') ?? ''),
    }
}
