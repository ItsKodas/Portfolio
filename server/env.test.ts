import { describe, expect, it } from 'vitest'

import { EnvError, clientSecretKey, clientMailConfig, ipHashKey, quoteMailConfig, smtpConfig, turnstileSecret } from './env'

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

describe('quoteMailConfig', () => {
    it('reads the relay settings, without a trailing slash on the site address', () => {
        expect(quoteMailConfig(mail)).toEqual({
            host: 'smtp.example.com', port: 587, user: 'resend', pass: 'secret-value',
            from: 'Horizons <quotes@dev.horizons.gg>', notifyTo: 'koda@horizons.gg', replyTo: 'info@dev.horizons.gg',
            siteUrl: 'https://www.horizons.gg',
        })
    })

    it('treats the login as optional, as Mailpit takes none', () => {
        const { SMTP_USER, SMTP_PASS, ...rest } = mail
        expect(quoteMailConfig(rest)).toMatchObject({ user: undefined, pass: undefined })
    })

    it('names every missing setting at once', () => {
        expect(problemsOf(() => quoteMailConfig({}))).toEqual([
            'SMTP_HOST is not set', 'SMTP_PORT is not set', 'MAIL_FROM is not set', 'AUTH_URL is not set',
        ])
    })

    it('names missing quote settings when SMTP is present', () => {
        expect(problemsOf(() => quoteMailConfig(smtp))).toEqual([
            'QUOTE_NOTIFY_TO is not set', 'QUOTE_REPLY_TO is not set',
        ])
    })

    it('rejects a port that is not a port number', () => {
        expect(problemsOf(() => quoteMailConfig({ ...mail, SMTP_PORT: 'smtp' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
        expect(problemsOf(() => quoteMailConfig({ ...mail, SMTP_PORT: '70000' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
    })

    it('never puts a value in its message', () => {
        try {
            quoteMailConfig({ ...mail, SMTP_HOST: '' })
        } catch (error) {
            expect(String(error)).not.toContain('secret-value')
        }
    })
})

const smtp = {
    SMTP_HOST: 'localhost', SMTP_PORT: '1025', MAIL_FROM: 'Horizons <quotes@dev.horizons.gg>',
    AUTH_URL: 'https://www.horizons.gg/',
}

describe('smtpConfig', () => {
    it('reads the transport without needing any quote setting', () => {
        expect(smtpConfig(smtp)).toMatchObject({ host: 'localhost', port: 1025, siteUrl: 'https://www.horizons.gg' })
    })
})

describe('clientMailConfig', () => {
    it('adds the client reply-to', () => {
        expect(clientMailConfig({ ...smtp, CLIENT_REPLY_TO: 'info@dev.horizons.gg' }).replyTo).toBe('info@dev.horizons.gg')
    })

    it('names the variable when it is missing', () => {
        expect(() => clientMailConfig(smtp)).toThrow(/CLIENT_REPLY_TO/)
    })

    // The whole point of the split: a missing quote setting must not stop a client invite going out
    it('does not need QUOTE_NOTIFY_TO or QUOTE_REPLY_TO', () => {
        expect(() => clientMailConfig({ ...smtp, CLIENT_REPLY_TO: 'info@dev.horizons.gg' })).not.toThrow()
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

describe('clientSecretKey', () => {
    it('decodes 32 base64 bytes', () => {
        const key = Buffer.alloc(32, 7).toString('base64')
        expect(clientSecretKey({ CLIENT_SECRET_KEY: key })).toEqual(Buffer.alloc(32, 7))
    })

    it('names the variable when it is missing', () => {
        expect(() => clientSecretKey({})).toThrow(/CLIENT_SECRET_KEY/)
    })

    it('refuses a key of the wrong length, rather than padding it', () => {
        expect(() => clientSecretKey({ CLIENT_SECRET_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/)
    })
})
