// Sends through the transactional relay (or Mailpit locally) over plain SMTP, so any provider works

import 'server-only'

import nodemailer from 'nodemailer'

import type { SmtpConfig } from './env'
import type { Email } from './emails/layout'

export type SendEmail = (email: Email) => Promise<void>

// Takes the plain transport settings rather than either feature's own config type, so it works for the
// quotes' MailConfig and the clients' ClientMailConfig alike: both are SmtpConfig plus fields this never reads.
export function createMailer(config: SmtpConfig): SendEmail {
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        // 465 is TLS from the first byte; other ports upgrade with STARTTLS whenever the server offers it
        secure: config.port === 465,
        auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    })
    return async email => {
        await transport.sendMail(email)
    }
}
