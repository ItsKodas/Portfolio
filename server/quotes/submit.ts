// What happens when someone sends the quote form, in order: the honeypot, Turnstile, the rate limit, validation, the
// save, and then the emails, which run after the response so nobody waits on the relay. Everything it touches is passed
// in (see wiring.ts for the real ones), so it can be tested without a database or the network.

import 'server-only'

import { RATE_LIMIT, RATE_WINDOW_MS } from '../ratelimit'
import { firstErrors, quoteSchema, type FieldErrors, type QuoteInput } from './schema'

// The hidden field people never fill in. A plausible name, so bots do.
export const HONEYPOT_FIELD = 'fax'

export type SubmitResult =
    | { ok: true }
    | { ok: false, reason: 'turnstile' | 'rate-limited' | 'server' }
    | { ok: false, reason: 'invalid', fieldErrors: FieldErrors }

export type SubmitDeps = {
    verifyTurnstile(token: string, ip: string): Promise<boolean>
    hashIp(ip: string): string
    countRecent(ipHash: string, since: Date): Promise<number>
    save(input: QuoteInput, ipHash: string): Promise<{ id: string }>
    afterResponse(task: () => Promise<void>): void
    deliver(id: string): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

export async function submitQuote(raw: unknown, ip: string, deps: SubmitDeps): Promise<SubmitResult> {
    const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

    // A bot filled in the field people never see. It gets the answer a person would, so it has nothing to learn from.
    const trap = fields[HONEYPOT_FIELD]
    if (typeof trap === 'string' && trap.trim() !== '') return { ok: true }

    const token = typeof fields.turnstileToken === 'string' ? fields.turnstileToken : ''
    let human = false
    try {
        human = await deps.verifyTurnstile(token, ip)
    } catch (error) {
        // Includes a missing secret key: refusing is safer than accepting everything unchecked
        deps.log('Turnstile check failed', error)
    }
    if (!human) return { ok: false, reason: 'turnstile' }

    let ipHash: string
    let recent: number
    try {
        ipHash = deps.hashIp(ip)
        recent = await deps.countRecent(ipHash, new Date(deps.now().getTime() - RATE_WINDOW_MS))
    } catch (error) {
        deps.log('Rate limit check failed', error)
        return { ok: false, reason: 'server' }
    }
    if (recent >= RATE_LIMIT) return { ok: false, reason: 'rate-limited' }

    const parsed = quoteSchema.safeParse(fields)
    if (!parsed.success) return { ok: false, reason: 'invalid', fieldErrors: firstErrors(parsed.error) }

    let id: string
    try {
        ({ id } = await deps.save(parsed.data, ipHash))
    } catch (error) {
        deps.log('Saving a quote failed', error)
        return { ok: false, reason: 'server' }
    }

    // The quote is safe in the database from here, so nothing that goes wrong with email, including scheduling it,
    // can be reported back as a failed submission
    try {
        deps.afterResponse(async () => {
            try {
                await deps.deliver(id)
            } catch (error) {
                deps.log(`Quote ${id}: sending its emails failed`, error)
            }
        })
    } catch (error) {
        deps.log(`Quote ${id}: scheduling its emails failed`, error)
    }
    return { ok: true }
}
