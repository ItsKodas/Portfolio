import { describe, expect, it } from 'vitest'

import { button, callout, facts, fields, message, paragraph, render } from './layout'

const shell = {
    preheader: 'Choose a password and the portal is yours',
    eyebrow: 'Client account',
    heading: 'Your account is ready',
    footer: 'You are getting this because an account was created for you.',
    siteUrl: 'https://www.horizons.gg',
}

describe('the text version', () => {
    it('reads as the plain email it replaces: heading, then paragraphs a blank line apart', () => {
        const email = render({ ...shell, blocks: [paragraph('Hi Ann,'), paragraph('Your account is set up.')] })

        expect(email.text).toBe([
            'Your account is ready',
            'Hi Ann,',
            'Your account is set up.',
            'You are getting this because an account was created for you.',
        ].join('\n\n'))
    })

    it('leaves out the preheader, which exists only for the inbox preview line', () => {
        const email = render({ ...shell, blocks: [paragraph('Hi Ann,')] })

        expect(email.text).not.toContain(shell.preheader)
    })
})

describe('the HTML version', () => {
    it('escapes every value it interpolates', () => {
        const email = render({
            ...shell,
            heading: 'Ann <b>Lee</b>',
            blocks: [paragraph(`Hi <script>alert('x')</script>,`)],
        })

        expect(email.html).not.toContain('<b>Lee</b>')
        expect(email.html).not.toContain('<script>')
        expect(email.html).toContain('Ann &lt;b&gt;Lee&lt;/b&gt;')
        expect(email.html).toContain('&lt;script&gt;')
    })

    it('carries the preheader for the inbox preview line', () => {
        const email = render({ ...shell, blocks: [paragraph('Hi Ann,')] })

        expect(email.html).toContain(shell.preheader)
    })
})

// The property the plain-text email had for free, now that there is an anchor: the address a client is about to
// open is always in front of them, in both versions. An email that hands over account access is exactly the
// shape a phishing email takes, so the destination never hides behind link text.
describe('a button', () => {
    const url = 'https://www.horizons.gg/portal/invite/raw-token'

    it('reads in the text version as the label followed by the address on its own line', () => {
        const email = render({ ...shell, blocks: [paragraph('Hi Ann,'), button('Set your password', url)] })

        expect(email.text).toContain(`Set your password:\n${url}`)
    })

    it('shows the same address it links to, so nothing hides behind the link text', () => {
        const email = render({ ...shell, blocks: [button('Set your password', url)] })

        const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map(match => match[1])
        expect(hrefs).toEqual([url, url])
        expect(email.html).toContain(`>${url}</a>`)
    })

    it('escapes the address inside the href, so a crafted link cannot break out of the attribute', () => {
        const email = render({ ...shell, blocks: [button('Open', 'https://x.example/"><script>alert(1)</script>')] })

        expect(email.html).not.toContain('<script>')
        expect(email.html).toContain('&quot;&gt;&lt;script&gt;')
    })

    it('is the only thing that can put a link in an email, so a notice with no button has none', () => {
        const email = render({ ...shell, blocks: [paragraph('Your password was changed.')] })

        expect(email.html).not.toContain('href')
        expect(email.text).not.toContain('http')
    })
})

describe('the other blocks', () => {
    it('lays out facts as a lead and the rest of the sentence, in both versions', () => {
        const email = render({ ...shell, blocks: [facts([
            { lead: 'The link lasts 7 days.', rest: 'After that, ask me for a new one.' },
            { lead: 'Have an authenticator app ready.', rest: 'Authy & 1Password both work.' },
        ])] })

        expect(email.text).toContain('The link lasts 7 days. After that, ask me for a new one.')
        expect(email.text).toContain('Have an authenticator app ready. Authy & 1Password both work.')
        expect(email.html).toContain('The link lasts 7 days.')
        expect(email.html).toContain('Authy &amp; 1Password both work.')
    })

    it('sets a callout apart without turning it into a link', () => {
        const email = render({ ...shell, blocks: [callout('Was this not you?', 'Reply straight away.')] })

        expect(email.text).toContain('Was this not you? Reply straight away.')
        expect(email.html).toContain('Was this not you?')
        expect(email.html).not.toContain('href')
    })

    it('lines fields up as label and value, indenting a value that runs to several lines', () => {
        const email = render({ ...shell, blocks: [fields([
            ['Company', 'Ann & Co'],
            ['Reference sites', 'https://one.example\nhttps://two.example'],
        ])] })

        expect(email.text).toContain('Company: Ann & Co')
        expect(email.text).toContain('Reference sites: https://one.example\n    https://two.example')
        expect(email.html).toContain('Ann &amp; Co')
        expect(email.html).toContain('https://one.example<br>https://two.example')
    })

    it('keeps the line breaks of a quoted message without letting its markup through', () => {
        const email = render({ ...shell, blocks: [message('Build me a <b>booking</b> system\nwith two lines')] })

        expect(email.text).toContain('Build me a <b>booking</b> system\nwith two lines')
        expect(email.html).not.toContain('<b>booking</b>')
        expect(email.html).toContain('&lt;b&gt;booking&lt;/b&gt;')
    })
})

describe('the accent', () => {
    const lake = '#8fd4f5'
    const blush = '#f19bb3'

    it('is lake by default, the one interactive accent the site uses', () => {
        const email = render({ ...shell, blocks: [paragraph('Hi Ann,')] })

        expect(email.html).toContain(lake)
        expect(email.html).not.toContain(blush)
    })

    it('is blush on a notice, because blush means a person did this', () => {
        const email = render({ ...shell, tone: 'notice', blocks: [paragraph('Your password was changed.')] })

        expect(email.html).toContain(blush)
        expect(email.html).not.toContain(lake)
    })
})

describe('a subheading', () => {
    it('sits under the heading in both versions when there is a summary worth leading with', () => {
        const email = render({ ...shell, subheading: 'Web app, $2k to $5k', blocks: [paragraph('Hi Ann,')] })

        expect(email.text).toBe(['Your account is ready', 'Web app, $2k to $5k', 'Hi Ann,', shell.footer].join('\n\n'))
        expect(email.html).toContain('Web app, $2k to $5k')
    })

    it('is left out entirely when there is none, rather than leaving a gap', () => {
        const withNone = render({ ...shell, blocks: [paragraph('Hi Ann,')] })
        const withOne = render({ ...shell, subheading: 'Web app', blocks: [paragraph('Hi Ann,')] })

        expect(withNone.html.length).toBeLessThan(withOne.html.length)
        expect(withNone.text).toBe(['Your account is ready', 'Hi Ann,', shell.footer].join('\n\n'))
    })
})
