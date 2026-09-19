// Reads the settings each part of the quotes feature needs, one group at a time, so a missing relay setting only
// stops email (the quote is still saved) rather than the whole form. Errors name the variables, never their values.

import 'server-only'

export type Env = Record<string, string | undefined>

export class EnvError extends Error {
    constructor(readonly problems: string[]) {
        super(`Missing or invalid settings: ${problems.join('; ')}`)
        this.name = 'EnvError'
    }
}

function required(env: Env, name: string, problems: string[]): string {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is not set`)
    return value ?? ''
}

export type MailConfig = {
    host: string
    port: number
    user?: string
    pass?: string
    from: string
    notifyTo: string
    replyTo: string
    // The site's own address, for the link to a quote in the notification email
    siteUrl: string
}

export function mailConfig(env: Env = process.env): MailConfig {
    const problems: string[] = []
    const host = required(env, 'SMTP_HOST', problems)
    const portText = required(env, 'SMTP_PORT', problems)
    const port = Number(portText)
    if (portText && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push('SMTP_PORT must be a port number, such as 587')
    const from = required(env, 'MAIL_FROM', problems)
    const notifyTo = required(env, 'QUOTE_NOTIFY_TO', problems)
    const replyTo = required(env, 'QUOTE_REPLY_TO', problems)
    const siteUrl = required(env, 'AUTH_URL', problems)
    if (problems.length) throw new EnvError(problems)

    return {
        host, port, from, notifyTo, replyTo,
        user: env.SMTP_USER?.trim() || undefined,
        pass: env.SMTP_PASS || undefined,
        siteUrl: siteUrl.replace(/\/+$/, ''),
    }
}

function single(env: Env, name: string): string {
    const problems: string[] = []
    const value = required(env, name, problems)
    if (problems.length) throw new EnvError(problems)
    return value
}

// Without it every submission is refused (failing closed), rather than accepted unchecked
export const turnstileSecret = (env: Env = process.env) => single(env, 'TURNSTILE_SECRET_KEY')

// The IP hash is keyed with the sessions' secret, so there is one fewer secret to manage. Rotating it only resets
// the rate-limit window.
export const ipHashKey = (env: Env = process.env) => single(env, 'AUTH_SECRET')
