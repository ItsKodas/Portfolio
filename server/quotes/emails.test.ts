import { describe, expect, it } from 'vitest'

import { confirmationEmail, emailsMissing, escapeHtml, notificationEmail, type QuoteForEmail } from './emails'

const quote: QuoteForEmail = {
    id: 'q1',
    createdAt: new Date('2026-09-20T00:00:00Z'),
    name: 'Ann <b>Lee</b>',
    email: 'ann@example.com',
    company: 'Ann & Co',
    website: 'https://ann.example.com',
    projectType: 'WEB_APP',
    budget: 'FROM_2K_TO_5K',
    timeline: null,
    message: 'Build me a <script>alert(1)</script> booking system\nwith two lines',
    referenceSites: ['https://one.example.com', 'https://two.example.com'],
}

const notify = { from: 'Horizons <quotes@dev.horizons.gg>', to: 'koda@horizons.gg', siteUrl: 'https://www.horizons.gg' }
const confirm = { from: 'Horizons <quotes@dev.horizons.gg>', replyTo: 'info@dev.horizons.gg' }

describe('escapeHtml', () => {
    it('escapes everything that could open a tag or an attribute', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    })
})

describe('notificationEmail', () => {
    const email = notificationEmail(quote, notify)

    it('goes to Koda, with Reply-To set to the prospect so a reply reaches them', () => {
        expect(email).toMatchObject({ from: notify.from, to: 'koda@horizons.gg', replyTo: 'ann@example.com' })
    })

    it('names the sender and the project type in the subject', () => {
        expect(email.subject).toBe('New quote: Ann <b>Lee</b> (Web app)')
        expect(notificationEmail({ ...quote, projectType: null }, notify).subject).toBe('New quote: Ann <b>Lee</b>')
    })

    it('includes every given field, the message and a link to the quote', () => {
        for (const part of ['Ann & Co', 'https://ann.example.com', 'Web app', '$2k to $5k', 'https://one.example.com', 'https://two.example.com', 'with two lines', 'https://www.horizons.gg/admin/quotes/q1']) {
            expect(email.text).toContain(part)
        }
        expect(email.text).not.toContain('Timeline')
    })

    it('escapes every value in the HTML version', () => {
        expect(email.html).not.toContain('<script>')
        expect(email.html).not.toContain('<b>Lee</b>')
        expect(email.html).toContain('&lt;script&gt;')
        expect(email.html).toContain('Ann &amp; Co')
    })
})

describe('confirmationEmail', () => {
    const email = confirmationEmail(quote, confirm)

    it('goes to the prospect, with Reply-To set to the forwarded info address', () => {
        expect(email).toMatchObject({ from: confirm.from, to: 'ann@example.com', replyTo: 'info@dev.horizons.gg', subject: "Thanks, I've got your request" })
    })

    it('never repeats what the prospect typed, apart from their name', () => {
        for (const typed of ['booking system', 'Ann & Co', 'ann.example.com', 'one.example.com']) {
            expect(email.text).not.toContain(typed)
            expect(email.html).not.toContain(typed)
        }
        expect(email.text).toContain('Hi Ann <b>Lee</b>,')
        expect(email.html).toContain('Hi Ann &lt;b&gt;Lee&lt;/b&gt;,')
    })

    it('greets a plausible name as typed', () => {
        expect(confirmationEmail({ ...quote, name: 'Ann Lee' }, confirm).text).toContain('Hi Ann Lee,')
    })

    it.each([
        ['a URL', 'See https://evil.example for details'],
        ['an email address', 'Your account is locked, contact fix@evil.example'],
        ['a bare web address', 'Visit www.evil.example now'],
        ['a name over 40 characters', 'A'.repeat(41)],
    ])('falls back to a generic greeting for %s', (_case, name) => {
        const email = confirmationEmail({ ...quote, name }, confirm)
        expect(email.text).toContain('Hi there,')
        expect(email.html).toContain('Hi there,')
        expect(email.text).not.toContain(name)
        expect(email.html).not.toContain(name)
    })
})

describe('emailsMissing', () => {
    const at = (iso: string) => new Date(iso)
    const created = at('2026-09-20T00:00:00Z')

    it('gives a new quote two minutes before calling its emails missing', () => {
        const unsent = { createdAt: created, notifiedAt: null, confirmedAt: null }
        expect(emailsMissing(unsent, at('2026-09-20T00:01:59Z'))).toBe(false)
        expect(emailsMissing(unsent, at('2026-09-20T00:02:01Z'))).toBe(true)
    })

    it('is false once both are sent, and true when either is still unsent', () => {
        const later = at('2026-09-20T01:00:00Z')
        expect(emailsMissing({ createdAt: created, notifiedAt: created, confirmedAt: created }, later)).toBe(false)
        expect(emailsMissing({ createdAt: created, notifiedAt: created, confirmedAt: null }, later)).toBe(true)
        expect(emailsMissing({ createdAt: created, notifiedAt: null, confirmedAt: created }, later)).toBe(true)
    })
})
