import { describe, expect, it } from 'vitest'

import type { Email } from '../emails/layout'
import { emailChangedEmail, inviteEmail, passwordChangedEmail, resetEmail, twoFactorResetEmail } from './emails'

const options = { from: 'Horizons <quotes@dev.horizons.gg>', replyTo: 'info@dev.horizons.gg', siteUrl: 'https://www.horizons.gg' }
const client = { name: 'Ann Example', email: 'ann@example.com' }

describe('inviteEmail', () => {
    const email = inviteEmail(client, 'raw-token', options)

    it('carries the link, the expiry and the warning about an authenticator app', () => {
        expect(email.text).toContain('https://www.horizons.gg/portal/invite/raw-token')
        expect(email.text).toContain('7 days')
        expect(email.text.toLowerCase()).toContain('authenticator')
    })

    it('goes to the client and replies to the support address', () => {
        expect(email.to).toBe('ann@example.com')
        expect(email.replyTo).toBe('info@dev.horizons.gg')
    })
})

describe('resetEmail', () => {
    const email = resetEmail(client, 'raw-token', options)

    it('carries the link and its one hour expiry', () => {
        expect(email.text).toContain('https://www.horizons.gg/portal/reset/raw-token')
        expect(email.text).toContain('one hour')
    })

    it('tells them what to do if they did not ask', () => {
        expect(email.text.toLowerCase()).toContain("didn't ask")
    })
})

describe('the notices', () => {
    // No link at all, so a notice about a security change can never itself be the phishing vector
    it.each([
        ['password changed', passwordChangedEmail(client, options)],
        ['two factor reset', twoFactorResetEmail(client, options)],
    ])('%s carries no link', (unused, email) => {
        expect(email.text).not.toContain('http')
        expect(email.html).not.toContain('href')
    })

    it('tells the client their sign-in address changed, and can be aimed at the old one', () => {
        const email = emailChangedEmail(client, { ...options, to: 'old@example.com' })
        expect(email.to).toBe('old@example.com')
        expect(email.text).toContain('ann@example.com')
    })
})

describe('escaping', () => {
    it('escapes the name in the HTML version', () => {
        const email = inviteEmail({ name: 'Ann <script>', email: 'ann@example.com' }, 'raw-token', options)
        expect(email.html).toContain('Ann &lt;script&gt;')
        expect(email.html).not.toContain('<script>')
    })
})

describe('the styled shell', () => {
    const all: [string, Email][] = [
        ['invite', inviteEmail(client, 'raw-token', options)],
        ['reset', resetEmail(client, 'raw-token', options)],
        ['password changed', passwordChangedEmail(client, options)],
        ['two factor reset', twoFactorResetEmail(client, options)],
        ['email changed', emailChangedEmail(client, { ...options, to: 'old@example.com' })],
    ]

    it.each(all)('%s is a full HTML document with the logo served from the site', (unused, email) => {
        expect(email.html).toMatch(/^<!doctype html>/)
        expect(email.html).toContain('https://www.horizons.gg/images/logo.png')
    })

    // The inbox shows the first text in the body after the subject, which for all five would otherwise be
    // "Hi Ann Example,". The preheader is a hidden line that gives that slot something worth reading.
    it.each(all)('%s has a hidden preview line that says more than the greeting would', (unused, email) => {
        const preview = email.html.match(/max-height:0[^>]*>([^<]+)</)?.[1]

        expect(preview).toBeTruthy()
        expect(preview).not.toContain('Hi ')
        expect(email.text).not.toContain(preview)
    })

    it.each([
        ['invite', inviteEmail(client, 'raw-token', options), 'https://www.horizons.gg/portal/invite/raw-token'],
        ['reset', resetEmail(client, 'raw-token', options), 'https://www.horizons.gg/portal/reset/raw-token'],
    ])('%s links to its own page and shows that same address as the link text', (unused, email, link) => {
        const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map(match => match[1])
        expect(hrefs).toEqual([link, link])
        expect(email.html).toContain(`>${link}</a>`)
    })

    it.each([
        ['password changed', passwordChangedEmail(client, options)],
        ['two factor reset', twoFactorResetEmail(client, options)],
        ['email changed', emailChangedEmail(client, { ...options, to: 'old@example.com' })],
    ])('%s is marked as a security notice rather than something to act on', (unused, email) => {
        expect(email.html).toContain('#f19bb3')
        expect(email.html).not.toContain('#8fd4f5')
    })
})
