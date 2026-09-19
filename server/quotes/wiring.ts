// Connects the quotes feature's pure modules (submit.ts, deliver.ts) to the real database, relay, Turnstile and
// Next's after(). The only file that does, so everything else can be tested with stand-ins.

import 'server-only'

import { after } from 'next/server'

import { getDb } from '../db'
import { ipHashKey, mailConfig, turnstileSecret } from '../env'
import { createMailer } from '../mailer'
import { hashIp } from '../ratelimit'
import { verifyTurnstile } from '../turnstile'
import { deliverQuoteEmails, type DeliverResult } from './deliver'
import { quoteRepo } from './repo'
import type { SubmitDeps } from './submit'

export function log(message: string, error?: unknown) {
    console.error(`[quotes] ${message}`, error ?? '')
}

export async function deliverById(id: string): Promise<DeliverResult> {
    const repo = quoteRepo(getDb())
    const quote = await repo.get(id)
    if (!quote) throw new Error(`Quote ${id} does not exist`)
    // Read here rather than at startup, so a missing relay setting only stops email
    const mail = mailConfig()
    return deliverQuoteEmails(quote, {
        send: createMailer(mail),
        markNotified: repo.markNotified,
        markConfirmed: repo.markConfirmed,
        now: () => new Date(),
        log,
        mail,
    })
}

export function submitDeps(): SubmitDeps {
    const repo = quoteRepo(getDb())
    return {
        verifyTurnstile: (token, ip) => verifyTurnstile(token, ip, turnstileSecret()),
        hashIp: ip => hashIp(ip, ipHashKey()),
        countRecent: repo.countRecent,
        save: repo.create,
        afterResponse: task => after(task),
        deliver: async id => {
            await deliverById(id)
        },
        now: () => new Date(),
        log,
    }
}
