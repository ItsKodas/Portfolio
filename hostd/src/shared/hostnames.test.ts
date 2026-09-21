import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseHostname, atOrBelow, isReserved, allowedEntryProblem } from './hostnames.ts'

describe('normaliseHostname', () => {
    it('lowercases and keeps a plain hostname', () => {
        assert.equal(normaliseHostname('WWW.Example.COM'), 'www.example.com')
    })

    it('converts a unicode name to punycode', () => {
        assert.equal(normaliseHostname('café.example.com'), 'xn--caf-dma.example.com')
    })

    it('strips a trailing dot, because the root label is not part of a ServerName', () => {
        assert.equal(normaliseHostname('example.com.'), 'example.com')
    })

    it('refuses a single label, a scheme, a port, a path and an empty string', () => {
        for (const bad of ['localhost', 'https://example.com', 'example.com:443', 'example.com/x', '']) {
            assert.equal(normaliseHostname(bad), null, bad)
        }
    })

    it('refuses anything that is not a string', () => {
        for (const bad of [null, undefined, 42, {}, ['example.com']]) assert.equal(normaliseHostname(bad), null)
    })
})

describe('atOrBelow', () => {
    it('matches the name itself and anything under it', () => {
        assert.equal(atOrBelow('horizons.gg', 'horizons.gg'), true)
        assert.equal(atOrBelow('a.b.horizons.gg', 'horizons.gg'), true)
    })

    it('does not match a name that merely ends with the same letters', () => {
        assert.equal(atOrBelow('nothorizons.gg', 'horizons.gg'), false)
    })
})

describe('isReserved', () => {
    it('refuses a reserved name and everything under it', () => {
        assert.equal(isReserved('horizons.gg', ['horizons.gg'], []), true)
        assert.equal(isReserved('mail.horizons.gg', ['horizons.gg'], []), true)
    })

    it('exempts an exact allowed entry and nothing else under it', () => {
        const reserved = ['horizons.gg']
        const allowed = ['test.hostd.horizons.gg']
        assert.equal(isReserved('test.hostd.horizons.gg', reserved, allowed), false)
        // The carve-out is the one name, never the subtree below it.
        assert.equal(isReserved('deeper.test.hostd.horizons.gg', reserved, allowed), true)
    })
})

describe('allowedEntryProblem', () => {
    it('accepts an ordinary test hostname', () => {
        assert.equal(allowedEntryProblem('test.hostd.horizons.gg'), null)
    })

    it('refuses the apex, whatever else the file says', () => {
        assert.match(allowedEntryProblem('horizons.gg') ?? '', /never be exempted/)
    })

    it('refuses the mail subtree, at any depth', () => {
        assert.match(allowedEntryProblem('dev.horizons.gg') ?? '', /never be exempted/)
        assert.match(allowedEntryProblem('mail.dev.horizons.gg') ?? '', /never be exempted/)
    })
})
