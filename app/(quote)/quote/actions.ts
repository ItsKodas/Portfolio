'use server'

import { headers } from 'next/headers'

import { clientIp } from '@/server/ratelimit'
import { submitQuote, type SubmitResult } from '@/server/quotes/submit'
import { submitDeps } from '@/server/quotes/wiring'

export async function submitQuoteAction(raw: unknown): Promise<SubmitResult> {
    return submitQuote(raw, clientIp(await headers()), submitDeps())
}
