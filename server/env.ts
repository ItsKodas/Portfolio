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

export function required(env: Env, name: string, problems: string[]): string {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is not set`)
    return value ?? ''
}

export type SmtpConfig = {
    host: string
    port: number
    user?: string
    pass?: string
    from: string
    // The site's own address, for links in emails
    siteUrl: string
}

// Collects rather than throws, so a caller that needs more than the transport can gather its own
// problems into the same list and report everything missing in one error. A fresh deploy should
// have to be told once what is missing, not once per group.
function readSmtp(env: Env, problems: string[]): SmtpConfig {
    const host = required(env, 'SMTP_HOST', problems)
    const portText = required(env, 'SMTP_PORT', problems)
    const port = Number(portText)
    if (portText && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push('SMTP_PORT must be a port number, such as 587')
    const from = required(env, 'MAIL_FROM', problems)
    const siteUrl = required(env, 'AUTH_URL', problems)

    return {
        host, port, from,
        user: env.SMTP_USER?.trim() || undefined,
        // Not trimmed on purpose: a password may legitimately start or end with whitespace
        pass: env.SMTP_PASS || undefined,
        siteUrl: siteUrl.replace(/\/+$/, ''),
    }
}

// Just the transport. Split out from the quote settings so a missing QUOTE_NOTIFY_TO can't stop a client
// invite going out: the two features fail independently.
export function smtpConfig(env: Env = process.env): SmtpConfig {
    const problems: string[] = []
    const config = readSmtp(env, problems)
    if (problems.length) throw new EnvError(problems)
    return config
}

export type MailConfig = SmtpConfig & { notifyTo: string, replyTo: string }

export function quoteMailConfig(env: Env = process.env): MailConfig {
    const problems: string[] = []
    const base = readSmtp(env, problems)
    const notifyTo = required(env, 'QUOTE_NOTIFY_TO', problems)
    const replyTo = required(env, 'QUOTE_REPLY_TO', problems)
    if (problems.length) throw new EnvError(problems)
    return { ...base, notifyTo, replyTo }
}

export type ClientMailConfig = SmtpConfig & { replyTo: string }

export function clientMailConfig(env: Env = process.env): ClientMailConfig {
    const problems: string[] = []
    const base = readSmtp(env, problems)
    const replyTo = required(env, 'CLIENT_REPLY_TO', problems)
    if (problems.length) throw new EnvError(problems)
    return { ...base, replyTo }
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

// Encrypts TOTP secrets and keys the recovery code HMACs. Deliberately not AUTH_SECRET: rotating that today
// only resets rate-limit windows, and it must not also brick every client's authenticator.
export function clientSecretKey(env: Env = process.env): Buffer {
    const value = single(env, 'CLIENT_SECRET_KEY')
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32) throw new EnvError(['CLIENT_SECRET_KEY must be 32 bytes, base64 encoded, from: openssl rand -base64 32'])
    return key
}
