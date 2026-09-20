import { describe, expect, it } from 'vitest'

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
