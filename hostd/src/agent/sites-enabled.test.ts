import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseServerNames, findClaims, SitesEnabledReader, unreadableWarnings } from './sites-enabled.ts'

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

// The production failure this exists to stop: adding an alias to backroom died with
// "ENOENT: no such file or directory, open '/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'",
// a file belonging to a different site entirely. readdir listed it and open could not find it, which on
// Debian means a symlink into sites-available whose target was deleted or renamed.
describe('SitesEnabledReader', () => {
    // A directory of names, where a name mapped to null is one readdir lists and readFile cannot open.
    function fakeFs(entries: Record<string, string | null>, code = 'ENOENT') {
        return {
            async readdir() { return Object.keys(entries) },
            async readFile(path: string) {
                const text = entries[path.slice(path.lastIndexOf('/') + 1)]
                if (text === undefined || text === null) {
                    const error = new Error(`${code}: cannot open ${path}`) as NodeJS.ErrnoException
                    error.code = code
                    throw error
                }
                return text
            },
        }
    }

    const reader = (entries: Record<string, string | null>, code?: string) =>
        new SitesEnabledReader('/etc/apache2/sites-enabled', fakeFs(entries, code))

    it('reads the files it can and reports the one it cannot, rather than throwing over it', async () => {
        const result = await reader({
            'acme.conf': 'ServerName acme.com\n',
            '010-arbys.horizons.gg.conf': null,
            'quiet.conf': 'ServerName quiet.example\n',
        }).read()
        assert.deepEqual(result.files.map(file => file.path), [
            '/etc/apache2/sites-enabled/acme.conf',
            '/etc/apache2/sites-enabled/quiet.conf',
        ])
        assert.deepEqual(result.unreadable, ['/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'])
    })

    // The state the dedi was in: whatever the operator was doing had nothing to do with the broken file.
    it('still parses the readable ones, so an unrelated claim is still found', async () => {
        const { files } = await reader({ 'acme.conf': 'ServerName acme.com\n', 'gone.conf': null }).read()
        assert.deepEqual(findClaims(files, ['acme.com']).map(claim => claim.path), ['/etc/apache2/sites-enabled/acme.conf'])
    })

    it('answers an empty listing rather than throwing when nothing in the directory can be read', async () => {
        const result = await reader({ 'one.conf': null, 'two.conf': null }).read()
        assert.deepEqual(result.files, [])
        assert.deepEqual(result.unreadable, [
            '/etc/apache2/sites-enabled/one.conf',
            '/etc/apache2/sites-enabled/two.conf',
        ])
    })

    it('treats ENOTDIR the same way, since that path has nothing behind it either', async () => {
        const result = await reader({ 'acme.conf': 'ServerName acme.com\n', 'gone.conf': null }, 'ENOTDIR').read()
        assert.deepEqual(result.unreadable, ['/etc/apache2/sites-enabled/gone.conf'])
        assert.equal(result.files.length, 1)
    })

    // Deliberately different in kind. A file this process may not open may well be there and serving a
    // hostname right now, so carrying on as though sites-enabled did not contain it could put a second
    // vhost on a name something else already answers. hostd runs as root, so this is a real fault on the
    // host, and failing the call is the honest answer.
    it('throws on EACCES rather than pretending the file is not there', async () => {
        await assert.rejects(
            reader({ 'acme.conf': 'ServerName acme.com\n', 'locked.conf': null }, 'EACCES').read(),
            /EACCES/,
        )
    })

    it('ignores anything that is not a .conf, as the include in apache2.conf does', async () => {
        const result = await reader({ 'acme.conf': 'ServerName acme.com\n', 'acme.conf.dpkg-old': null }).read()
        assert.deepEqual(result.unreadable, [])
        assert.equal(result.files.length, 1)
    })

    it('treats a directory it cannot list at all as an empty one', async () => {
        const unlistable = new SitesEnabledReader('/etc/apache2/sites-enabled', {
            async readdir() { throw new Error('ENOENT') },
            async readFile() { return '' },
        })
        assert.deepEqual(await unlistable.read(), { files: [], unreadable: [] })
    })

    // The half that matters most on a live server: a dangling symlink fails apache2ctl configtest, hostd
    // runs configtest before every reload, and so every domain change on the box is refused while nobody
    // is doing anything at all. The agent's own sweep calls read() on a timer, so /health says this
    // without an operator first tripping over it in a domain action.
    it('says nothing while every file reads', async () => {
        const quiet = reader({ 'acme.conf': 'ServerName acme.com\n' })
        await quiet.read()
        assert.deepEqual(quiet.warnings(), [])
    })

    it('warns with the file named once its own read has run, with no domain action involved', async () => {
        const broken = reader({ '010-arbys.horizons.gg.conf': null })
        await broken.read()
        const [warning] = broken.warnings()
        assert.equal(broken.warnings().length, 1)
        assert.match(warning ?? '', /\/etc\/apache2\/sites-enabled\/010-arbys\.horizons\.gg\.conf/)
        // What it means, not only that it happened.
        assert.match(warning ?? '', /configuration test fails/)
        assert.match(warning ?? '', /no domain change on this server can take effect/)
    })

    it('clears the warning once the file is readable again', async () => {
        const entries: Record<string, string | null> = { 'acme.conf': null }
        const changing = new SitesEnabledReader('/etc/apache2/sites-enabled', fakeFs(entries))
        await changing.read()
        assert.equal(changing.warnings().length, 1)
        entries['acme.conf'] = 'ServerName acme.com\n'
        await changing.read()
        assert.deepEqual(changing.warnings(), [])
    })
})

describe('unreadableWarnings', () => {
    it('says nothing at all when every file read', () => {
        assert.deepEqual(unreadableWarnings([]), [])
    })

    // Written for somebody reading /health at nine at night: what is wrong, why the sites still look
    // fine, and what stops working until it is fixed.
    it('names the file, says the configuration test fails and says domain changes stop', () => {
        const [warning] = unreadableWarnings(['/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'])
        assert.match(warning ?? '', /010-arbys\.horizons\.gg\.conf/)
        assert.match(warning ?? '', /symlink whose target was deleted or renamed/)
        assert.match(warning ?? '', /configuration test fails/)
        assert.match(warning ?? '', /no domain change on this server can take effect/)
        assert.match(warning ?? '', /keeps serving the configuration it loaded earlier/)
    })

    it('names every file, in one warning rather than one apiece', () => {
        const warnings = unreadableWarnings(['/etc/apache2/sites-enabled/a.conf', '/etc/apache2/sites-enabled/b.conf'])
        assert.equal(warnings.length, 1)
        assert.match(warnings[0] ?? '', /a\.conf, \/etc\/apache2\/sites-enabled\/b\.conf/)
    })

    // A hard project rule, and this string is read by an operator rather than by a developer.
    it('has no em dash in it, whatever the count', () => {
        for (const paths of [['/a.conf'], ['/a.conf', '/b.conf']]) {
            assert.equal(unreadableWarnings(paths)[0]!.includes('—'), false)
        }
    })
})
