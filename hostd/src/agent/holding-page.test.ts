import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderHoldingPage, escapeHtml, HOLDING_STATES, type HoldingPageInput } from './holding-page.ts'

const input = (over: Partial<HoldingPageInput> = {}): HoldingPageInput => ({
    name: 'Mappies',
    hostname: 'mappies.horizons.gg',
    environment: 'live',
    state: 'unavailable',
    since: null,
    contact: null,
    ...over,
})

describe('renderHoldingPage', () => {
    it('says why the site is down, in each state', () => {
        assert.match(renderHoldingPage(input({ state: 'upgrading' })), /A new version of Mappies is being put in place/)
        assert.match(renderHoldingPage(input({ state: 'stopped' })), /Mappies has been switched off for now/)
        assert.match(renderHoldingPage(input({ state: 'crashed' })), /Mappies has run into a problem and could not restart itself/)
        assert.match(renderHoldingPage(input({ state: 'unavailable' })), /Mappies is not answering right now/)
    })

    it('names the site and its address', () => {
        const page = renderHoldingPage(input())
        assert.match(page, /<h1>Mappies<\/h1>/)
        assert.match(page, /<dd>mappies\.horizons\.gg<\/dd>/)
    })

    // The registry holds the name and the contact to a shape, not to being markup-free
    it('escapes everything that came from the registry', () => {
        const page = renderHoldingPage(input({
            name: '<script>alert(1)</script>',
            contact: { name: 'Jo "the owner"', email: 'jo+<b>@example.com', phone: null },
        }))
        assert.ok(!page.includes('<script>alert(1)</script>'))
        assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
        assert.match(page, /Need to reach Jo &quot;the owner&quot;\?/)
        assert.match(page, /href="mailto:jo\+&lt;b&gt;@example\.com"/)
    })

    it('leaves the contact section out when the site names nobody, and links each way to reach them when it does', () => {
        assert.ok(!renderHoldingPage(input()).includes('class="contact"'))
        const page = renderHoldingPage(input({ contact: { name: null, email: 'jo@example.com', phone: '+61 (0)400 123-456' } }))
        assert.match(page, /Need to reach the site owner\?/)
        assert.match(page, /href="mailto:jo@example\.com"/)
        assert.match(page, /href="tel:\+610400123456"/)
    })

    it('shows the environment only when it is not live', () => {
        assert.ok(!renderHoldingPage(input()).includes('<dt>Environment</dt>'))
        assert.match(renderHoldingPage(input({ environment: 'test' })), /<dt>Environment<\/dt><dd>test<\/dd>/)
    })

    it('shows since when it was given one', () => {
        assert.ok(!renderHoldingPage(input()).includes('<dt>Since</dt>'))
        assert.match(renderHoldingPage(input({ state: 'stopped', since: '2026-10-10T03:41:12.000Z' })), /<time datetime="2026-10-10T03:41:12\.000Z">2026-10-10 03:41:12 UTC<\/time>/)
    })

    it('renders the shared fallback without a site, leaving the address to the script', () => {
        const page = renderHoldingPage(input({ name: null, hostname: null, environment: null }))
        assert.match(page, /<span data-host>This site<\/span>/)
        assert.match(page, /This site is not answering right now/)
    })

    it('carries the scene and its campfire, and loads nothing from anywhere', () => {
        const page = renderHoldingPage(input())
        assert.match(page, /<svg class="scene"/)
        assert.match(page, /class="flame"/)
        assert.ok(!/\s(src|href)="\/\//.test(page) && !/<link /.test(page) && !/<script src/.test(page))
    })

    it('renders the same text twice, so an unchanged page is never rewritten', () => {
        assert.equal(renderHoldingPage(input({ state: 'crashed' })), renderHoldingPage(input({ state: 'crashed' })))
    })

    // CLAUDE.md: no em dashes in anything a visitor reads
    it('uses no em dashes in any state', () => {
        for (const state of HOLDING_STATES) {
            const page = renderHoldingPage(input({ state, contact: { name: 'Jo', email: 'jo@example.com', phone: null } }))
            assert.ok(!page.includes('\u2014') && !page.includes('&mdash;'), state)
        }
    })
})

describe('escapeHtml', () => {
    it('escapes the five characters that matter in text and attributes', () => {
        assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    })
})
