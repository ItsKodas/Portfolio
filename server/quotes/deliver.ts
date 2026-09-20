// Sends whichever of a quote's two emails haven't gone yet, and records each one that does. Used right after a quote
// is saved, and again by the admin area's resend button. Never throws: a failure is logged and left unrecorded, which
// is what makes the admin area show "email not sent".

import 'server-only'

import type { MailConfig } from '../env'
import type { SendEmail } from '../mailer'
import type { Email } from '../emails/layout'
import { confirmationEmail, notificationEmail, type QuoteForEmail } from './emails'

export type DeliverableQuote = QuoteForEmail & { notifiedAt: Date | null, confirmedAt: Date | null }

export type DeliverDeps = {
    send: SendEmail
    markNotified(id: string, at: Date): Promise<void>
    markConfirmed(id: string, at: Date): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    mail: Pick<MailConfig, 'from' | 'notifyTo' | 'replyTo' | 'siteUrl'>
}

export type DeliverResult = { notified: boolean, confirmed: boolean }

export async function deliverQuoteEmails(quote: DeliverableQuote, deps: DeliverDeps): Promise<DeliverResult> {
    const { mail } = deps

    async function attempt(kind: string, email: Email, record: (at: Date) => Promise<void>): Promise<boolean> {
        try {
            await deps.send(email)
        } catch (error) {
            deps.log(`Quote ${quote.id}: the ${kind} email was not sent`, error)
            return false
        }
        try {
            await record(deps.now())
        } catch (error) {
            // It did go, so it counts as sent; the admin area may offer a resend that would send it twice
            deps.log(`Quote ${quote.id}: the ${kind} email was sent but could not be recorded`, error)
        }
        return true
    }

    // One after the other but independent: a failed notification doesn't stop the confirmation, or the reverse
    const notified = quote.notifiedAt !== null || await attempt(
        'notification',
        notificationEmail(quote, { from: mail.from, to: mail.notifyTo, siteUrl: mail.siteUrl }),
        at => deps.markNotified(quote.id, at),
    )
    const confirmed = quote.confirmedAt !== null || await attempt(
        'confirmation',
        confirmationEmail(quote, { from: mail.from, replyTo: mail.replyTo, siteUrl: mail.siteUrl }),
        at => deps.markConfirmed(quote.id, at),
    )
    return { notified, confirmed }
}
