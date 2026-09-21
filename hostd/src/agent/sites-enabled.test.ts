import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseServerNames, findClaims } from './sites-enabled.ts'

describe('parseServerNames', () => {
    it('reads a ServerName and every ServerAlias, including several on one line', () => {
        const { names } = parseServerNames(`
<VirtualHost *:443>
    ServerName acme.com
    ServerAlias www.acme.com shop.acme.com
</VirtualHost>
`)
        assert.deepEqual(names, ['acme.com', 'www.acme.com', 'shop.acme.com'])
    })

    it('normalises what it finds, so a capitalised name still matches', () => {
        assert.deepEqual(parseServerNames('ServerName ACME.com').names, ['acme.com'])
    })

    it('ignores comments, because a commented-out name serves nothing', () => {
        assert.deepEqual(parseServerNames('# ServerName old.acme.com\nServerName acme.com').names, ['acme.com'])
    })

    it('does not repeat a name that appears in two blocks', () => {
        assert.deepEqual(parseServerNames('ServerName acme.com\nServerName acme.com').names, ['acme.com'])
    })

    it('reports Include as unsupported, because the names may be defined somewhere this never looked', () => {
        const parsed = parseServerNames('ServerName acme.com\nInclude /etc/apache2/common.conf')
        assert.match(parsed.unsupported ?? '', /Include/)
    })

    it('reports mod_macro as unsupported for the same reason', () => {
        assert.match(parseServerNames('Use CommonSite acme.com').unsupported ?? '', /Use/)
    })

    it('drops a name it cannot read as a hostname rather than passing it on', () => {
        assert.deepEqual(parseServerNames('ServerName ${SITE_NAME}').names, [])
    })
})

describe('findClaims', () => {
    const files = [
        { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\nServerAlias www.acme.com' },
        { path: '/etc/apache2/sites-enabled/other.conf', text: 'ServerName other.com' },
    ]

    it('returns only the files claiming one of the hostnames asked about', () => {
        const claims = findClaims(files, ['acme.com'])
        assert.equal(claims.length, 1)
        assert.equal(claims[0]!.path, '/etc/apache2/sites-enabled/acme.conf')
    })

    it('reports every name that file serves, not only the ones asked about', () => {
        assert.deepEqual(findClaims(files, ['acme.com'])[0]!.names, ['acme.com', 'www.acme.com'])
    })

    it('matches on an alias as readily as on the primary', () => {
        assert.equal(findClaims(files, ['www.acme.com']).length, 1)
    })

    it('returns nothing when no file claims the hostname', () => {
        assert.deepEqual(findClaims(files, ['nobody.com']), [])
    })

    // Adoption switches this file off and writes hostd's own in its place, and the two directives above
    // are all this parser understands of it. Anything else it does, a rewrite, a basic auth block, a
    // bespoke error page, is only ever visible as the text, so the text has to survive this function.
    it('carries the file itself, not only what it managed to read out of it', () => {
        assert.equal(findClaims(files, ['acme.com'])[0]!.text, files[0]!.text)
    })

    it('carries the text of a file it refuses to call adoptable too, which is when it matters most', () => {
        const awkward = [{ path: '/etc/apache2/sites-enabled/macro.conf', text: 'ServerName acme.com\nUse CommonSite acme.com' }]
        const claim = findClaims(awkward, ['acme.com'])[0]!
        assert.match(claim.unsupported ?? '', /Use/)
        assert.equal(claim.text, awkward[0]!.text)
    })
})
