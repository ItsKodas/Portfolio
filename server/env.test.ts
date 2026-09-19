import { describe, expect, it } from 'vitest'

import { EnvError, ipHashKey, mailConfig, turnstileSecret } from './env'

const mail = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'resend',
    SMTP_PASS: 'secret-value',
    MAIL_FROM: 'Horizons <quotes@dev.horizons.gg>',
    QUOTE_NOTIFY_TO: 'koda@horizons.gg',
    QUOTE_REPLY_TO: 'info@dev.horizons.gg',
    AUTH_URL: 'https://www.horizons.gg/',
}

const problemsOf = (read: () => unknown) => {
    try {
        read()
    } catch (error) {
        if (error instanceof EnvError) return error.problems
        throw error
    }
    throw new Error('expected an EnvError')
}

describe('mailConfig', () => {
    it('reads the relay settings, without a trailing slash on the site address', () => {
        expect(mailConfig(mail)).toEqual({
            host: 'smtp.example.com', port: 587, user: 'resend', pass: 'secret-value',
            from: 'Horizons <quotes@dev.horizons.gg>', notifyTo: 'koda@horizons.gg', replyTo: 'info@dev.horizons.gg',
            siteUrl: 'https://www.horizons.gg',
        })
    })

    it('treats the login as optional, as Mailpit takes none', () => {
        const { SMTP_USER, SMTP_PASS, ...rest } = mail
        expect(mailConfig(rest)).toMatchObject({ user: undefined, pass: undefined })
    })

    it('names every missing setting at once', () => {
        expect(problemsOf(() => mailConfig({}))).toEqual([
            'SMTP_HOST is not set', 'SMTP_PORT is not set', 'MAIL_FROM is not set', 'QUOTE_NOTIFY_TO is not set',
            'QUOTE_REPLY_TO is not set', 'AUTH_URL is not set',
        ])
    })

    it('rejects a port that is not a port number', () => {
        expect(problemsOf(() => mailConfig({ ...mail, SMTP_PORT: 'smtp' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
        expect(problemsOf(() => mailConfig({ ...mail, SMTP_PORT: '70000' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
    })

    it('never puts a value in its message', () => {
        try {
            mailConfig({ ...mail, SMTP_HOST: '' })
        } catch (error) {
            expect(String(error)).not.toContain('secret-value')
        }
    })
})

describe('turnstileSecret and ipHashKey', () => {
    it('return the value when set', () => {
        expect(turnstileSecret({ TURNSTILE_SECRET_KEY: 'abc' })).toBe('abc')
        expect(ipHashKey({ AUTH_SECRET: 'def' })).toBe('def')
    })

    it('throw when missing or blank', () => {
        expect(problemsOf(() => turnstileSecret({ TURNSTILE_SECRET_KEY: ' ' }))).toEqual(['TURNSTILE_SECRET_KEY is not set'])
        expect(problemsOf(() => ipHashKey({}))).toEqual(['AUTH_SECRET is not set'])
    })
})
