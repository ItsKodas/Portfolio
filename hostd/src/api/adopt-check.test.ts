import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { probeSite, rolledBackReason, wentDark, PROBE_TIMEOUT_MS, type Answer } from './adopt-check.ts'

// A fetch that never leaves the process. Each case says what the origin answered, or throws what the
// network would have thrown.
function answering(status: number, headers: Record<string, string> = {}): typeof fetch {
    return (async () => new Response(null, { status, headers })) as unknown as typeof fetch
}

function throwing(error: unknown): typeof fetch {
    return (async () => { throw error }) as unknown as typeof fetch
}

describe('probeSite', () => {
    it('asks the hostname over https at the bare path, the way a visitor would', async () => {
        const seen: { url: string, init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push({ url, init })
            return new Response(null, { status: 200 })
        }) as unknown as typeof fetch

        await probeSite(fetchImpl, 'thebackroom.dev')
        assert.equal(seen[0]!.url, 'https://thebackroom.dev/')
        // Following the redirect would turn the loop this exists to catch into a fetch that spins.
        assert.equal(seen[0]!.init.redirect, 'manual')
        assert.equal(seen[0]!.init.cache, 'no-store')
        assert.ok(seen[0]!.init.signal, 'the probe must not be able to hang')
    })

    it('grades a page as answered', async () => {
        assert.equal((await probeSite(answering(200), 'acme.example')).grade, 'answered')
    })

    // The site is answering, it is just saying no. The question is whether it went dark.
    it('grades a 401 and a 404 as answered too', async () => {
        assert.equal((await probeSite(answering(401), 'acme.example')).grade, 'answered')
        assert.equal((await probeSite(answering(404), 'acme.example')).grade, 'answered')
    })

    it('grades a redirect as a redirect, and says where it pointed', async () => {
        const answer = await probeSite(answering(301, { location: 'https://acme.example/' }), 'acme.example')
        assert.equal(answer.grade, 'redirect')
        assert.match(answer.said, /301/)
        assert.match(answer.said, /https:\/\/acme\.example\//)
    })

    it('grades a 5xx as an error', async () => {
        assert.equal((await probeSite(answering(502), 'acme.example')).grade, 'error')
    })

    it('grades a request that never completed as unreachable, and says why', async () => {
        const answer = await probeSite(throwing(new Error('getaddrinfo ENOTFOUND acme.example')), 'acme.example')
        assert.equal(answer.grade, 'unreachable')
        assert.match(answer.said, /ENOTFOUND/)
    })

    it('has a timeout, so one wedged origin cannot hold an adopt open forever', () => {
        assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 30_000)
    })
})

describe('wentDark', () => {
    const answer = (grade: Answer['grade']): Answer => ({ grade, said: grade })

    // The outage, in one line: a page before, a 301 after, because the template forces :80 to https and
    // a CDN terminating TLS on its own hands that straight back to the browser.
    it('is true when a page became a redirect', () => {
        assert.equal(wentDark(answer('answered'), answer('redirect')), true)
    })

    it('is true when a page became an error or stopped answering at all', () => {
        assert.equal(wentDark(answer('answered'), answer('error')), true)
        assert.equal(wentDark(answer('answered'), answer('unreachable')), true)
    })

    it('is false when nothing changed', () => {
        for (const grade of ['answered', 'redirect', 'error', 'unreachable'] as const) {
            assert.equal(wentDark(answer(grade), answer(grade)), false, grade)
        }
    })

    it('is false when the adoption made it better', () => {
        assert.equal(wentDark(answer('unreachable'), answer('answered')), false)
        assert.equal(wentDark(answer('error'), answer('redirect')), false)
    })

    // The case that must not be blocked: adoption is how an operator fixes a site that is already down,
    // and a baseline of unreachable has nothing below it to fall to.
    it('never blocks an adoption of a site that was already dark, however it comes out', () => {
        for (const grade of ['answered', 'redirect', 'error', 'unreachable'] as const) {
            assert.equal(wentDark(answer('unreachable'), answer(grade)), false, grade)
        }
    })
})

describe('rolledBackReason', () => {
    const before: Answer = { grade: 'answered', said: 'answered 200' }
    const after: Answer = { grade: 'redirect', said: 'answered 301 to https://thebackroom.dev/' }

    it('says what was measured before and after, and names the file it put back', () => {
        const said = rolledBackReason('thebackroom.dev', before, after, ['/etc/apache2/sites-enabled/backroom.conf'], null)
        assert.match(said, /thebackroom\.dev/)
        assert.match(said, /answered 200/)
        assert.match(said, /answered 301 to https:\/\/thebackroom\.dev\//)
        assert.match(said, /\/etc\/apache2\/sites-enabled\/backroom\.conf/)
    })

    it('says plainly that the configtest and the reload both passed, which is the confusing part', () => {
        const said = rolledBackReason('thebackroom.dev', before, after, ['/etc/apache2/sites-enabled/backroom.conf'], null)
        assert.match(said, /configuration test/)
        assert.match(said, /reloaded/)
    })

    it('does not claim the site is back when putting it back failed', () => {
        const said = rolledBackReason('thebackroom.dev', before, after, ['/etc/apache2/sites-enabled/backroom.conf'], 'Apache would not reload')
        assert.match(said, /Apache would not reload/)
        assert.equal(said.includes('should be answering as it was'), false)
    })

    it('has no em dash in it, because this is what the operator reads instead of a working site', () => {
        const said = rolledBackReason('thebackroom.dev', before, after, ['/etc/apache2/sites-enabled/backroom.conf'], null)
        assert.equal(said.includes('—'), false)
    })
})
