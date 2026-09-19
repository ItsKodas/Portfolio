// Sends through the transactional relay (or Mailpit locally) over plain SMTP, so any provider works

import 'server-only'

import nodemailer from 'nodemailer'

import type { MailConfig } from './env'
import type { Email } from './quotes/emails'

export type SendEmail = (email: Email) => Promise<void>

export function createMailer(config: MailConfig): SendEmail {
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
