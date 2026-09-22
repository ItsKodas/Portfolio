import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    parseServerNames,
    findClaims,
    readNothing,
    SitesEnabledReader,
    blindWarning,
    unreadableWarnings,
    unlistableWarning,
    unopenableWarning,
} from './sites-enabled.ts'

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
        assert.match(parsed.unsupported.join(' '), /Include/)
    })

    it('reports mod_macro as unsupported for the same reason', () => {
        assert.match(parseServerNames('Use CommonSite acme.com').unsupported.join(' '), /Use/)
    })

    it('drops a name it cannot read as a hostname rather than passing it on', () => {
        assert.deepEqual(parseServerNames('ServerName ${SITE_NAME}').names, [])
    })

    it('says nothing is unsupported about a file the template can reproduce', () => {
        const parsed = parseServerNames(`
<VirtualHost *:80>
    ServerName acme.com
    Redirect permanent / https://acme.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName acme.com
    ProxyPass / http://127.0.0.1:3002/
    ProxyPassReverse / http://127.0.0.1:3002/
</VirtualHost>
`, 'http://127.0.0.1:3002/')
        assert.deepEqual(parsed.unsupported, [])
    })
})

// The four refusals added after thebackroom.dev went dark. Each one is a thing the generated vhost
// cannot reproduce and that is plainly readable in the file adoption is already parsing.
describe('parseServerNames: what the template cannot carry', () => {
    const wrap = (body: string) => `<VirtualHost *:443>\n    ServerName acme.com\n${body}\n</VirtualHost>\n`
    const reasons = (body: string, expected: string | null = null) => parseServerNames(wrap(body), expected).unsupported

    it('refuses a RewriteRule carrying the [P] flag, because the template has no rewrite of its own', () => {
        const found = reasons('    RewriteRule ^/?(.*) http://127.0.0.1:3002/$1 [P,L]')
        assert.equal(found.length, 1)
        assert.match(found[0]!, /\[P\] flag/)
        // The directive itself, so the operator can find the line in their own file.
        assert.match(found[0]!, /RewriteRule \^\/\?\(\.\*\)/)
    })

    it('reads the long form of the same flag, and reads it wherever it sits in the list', () => {
        assert.equal(reasons('    RewriteRule ^/?(.*) http://127.0.0.1:3002/$1 [NE,proxy,L]').length, 1)
    })

    it('leaves an ordinary redirecting rewrite alone, which is most of them', () => {
        assert.deepEqual(reasons('    RewriteRule ^/?(.*)$ https://acme.com/$1 [R=301,L]'), [])
    })

    it('refuses a ws:// target, because the template proxies plain HTTP only', () => {
        const found = reasons('    ProxyPass /socket ws://127.0.0.1:3002/socket')
        assert.equal(found.length, 1)
        assert.match(found[0]!, /ws:\/\/127\.0\.0\.1:3002\/socket/)
        assert.match(found[0]!, /mod_proxy_wstunnel/)
    })

    it('refuses wss:// too', () => {
        assert.match(reasons('    ProxyPass /socket wss://127.0.0.1:3002/socket').join(' '), /wss:\/\//)
    })

    it('refuses a ProxyPass that disagrees with the upstream the registry gives', () => {
        const found = reasons('    ProxyPass / http://127.0.0.1:9999/', 'http://127.0.0.1:3002/')
        assert.equal(found.length, 1)
        assert.match(found[0]!, /http:\/\/127\.0\.0\.1:9999\//)
        assert.match(found[0]!, /http:\/\/127\.0\.0\.1:3002\//)
    })

    it('accepts the same upstream spelled without its trailing slash', () => {
        assert.deepEqual(reasons('    ProxyPass / http://127.0.0.1:3002', 'http://127.0.0.1:3002/'), [])
    })

    it('says nothing about a ProxyPass exclusion, which names a path and no upstream at all', () => {
        assert.deepEqual(reasons('    ProxyPass /503.html !\n    ProxyPass / http://127.0.0.1:3002/', 'http://127.0.0.1:3002/'), [])
    })

    // The expectation is passed in by the caller that holds the registry. With none to compare against,
    // the honest answer is to say nothing rather than to invent one and refuse against it.
    it('skips the upstream comparison entirely when no expected target was given', () => {
        assert.deepEqual(reasons('    ProxyPass / http://127.0.0.1:9999/'), [])
    })

    it('does not read ProxyPassReverse or ProxyPassMatch as the upstream', () => {
        const body = '    ProxyPass / http://127.0.0.1:3002/\n    ProxyPassReverse / http://127.0.0.1:9999/'
        assert.deepEqual(reasons(body, 'http://127.0.0.1:3002/'), [])
    })

    it('refuses a vhost with no port 443 block, because the forced redirect to https would loop', () => {
        const found = parseServerNames('<VirtualHost *:80>\n    ServerName acme.com\n</VirtualHost>\n').unsupported
        assert.equal(found.length, 1)
        assert.match(found[0]!, /no port 443 block/)
        assert.match(found[0]!, /Flexible/)
    })

    it('accepts a 443 block on a named address, not only on the wildcard', () => {
        assert.deepEqual(parseServerNames('<VirtualHost 10.0.0.1:443>\n    ServerName acme.com\n</VirtualHost>\n').unsupported, [])
    })

    it('says nothing about a fragment with no VirtualHost in it at all, which it cannot judge', () => {
        assert.deepEqual(parseServerNames('ServerName acme.com\n').unsupported, [])
    })

    it('says the same thing once however many times the file does it', () => {
        const body = '    RewriteRule ^/a(.*) http://127.0.0.1:3002/$1 [P]\n    RewriteRule ^/b(.*) http://127.0.0.1:3002/$1 [P]'
        assert.equal(reasons(body).length, 1)
    })

    it('ignores all of it inside a comment, because a commented-out directive serves nothing', () => {
        const body = '    # RewriteRule ^/?(.*) ws://127.0.0.1:3002/$1 [P,L]\n    # ProxyPass / http://127.0.0.1:9999/'
        assert.deepEqual(reasons(body, 'http://127.0.0.1:3002/'), [])
    })
})

// The file that took thebackroom.dev off the internet, verbatim. Adoption moved it aside, Apache's own
// configtest passed, the reload succeeded, hostd reported success, and the game was dark until the
// operator put the file back by hand. Two things did it, and both are in this text: the [P] rewrite onto
// a ws:// upstream, which the template has no equivalent for, and the absence of any :443 block, which
// means the origin is HTTP-only behind a CDN in Flexible mode and hostd's forced redirect to https loops
// forever. This fixture is the regression test for that outage and must keep failing adoption.
describe('the vhost that took thebackroom.dev off the internet', () => {
    const THE_BACKROOM = `<VirtualHost *:80>
    ServerName thebackroom.dev

    DocumentRoot /var/www/html

    # The game talks over socket.io, which upgrades to a raw WebSocket. Hand
    # those requests to mod_proxy_wstunnel before the plain HTTP proxy below
    # gets a chance to answer them and break the handshake.
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) ws://127.0.0.1:3002/$1 [P,L]

    ProxyPass /503.html !
    ProxyPass / http://127.0.0.1:3002/
    ProxyPassReverse / http://127.0.0.1:3002/
    ProxyPreserveHost On
    ProxyErrorOverride Off
</VirtualHost>
`
    const file = [{ path: '/etc/apache2/sites-enabled/thebackroom.conf', text: THE_BACKROOM }]
    // The registry really does say 3002 for this environment, and the file really does proxy to 3002.
    // The upstream was never the problem, and the refusal must not pretend it was.
    const expected = 'http://127.0.0.1:3002/'

    it('still finds the hostname, so the operator is not told there is nothing there', () => {
        assert.deepEqual(findClaims(file, ['thebackroom.dev'], expected)[0]!.names, ['thebackroom.dev'])
    })

    it('refuses it, naming the proxying rewrite, the WebSocket upstream and the missing 443 block', () => {
        const reasons = findClaims(file, ['thebackroom.dev'], expected)[0]!.unsupported
        assert.equal(reasons.length, 3, reasons.join('\n'))
        assert.match(reasons.join('\n'), /\[P\] flag/)
        assert.match(reasons.join('\n'), /ws:\/\/127\.0\.0\.1:3002\//)
        assert.match(reasons.join('\n'), /mod_proxy_wstunnel/)
        assert.match(reasons.join('\n'), /no port 443 block/)
    })

    // The proxy target was right all along: the registry says 3002 and so does the file. A refusal that
    // also blamed the port would send the operator to change a setting that was never wrong.
    it('says nothing about the upstream, because the upstream agreed with the registry', () => {
        const reasons = findClaims(file, ['thebackroom.dev'], expected)[0]!.unsupported
        assert.equal(reasons.some(reason => reason.includes('another site')), false, reasons.join('\n'))
    })

    it('carries the file verbatim, so the operator sees what they would be replacing', () => {
        assert.equal(findClaims(file, ['thebackroom.dev'], expected)[0]!.text, THE_BACKROOM)
    })

    it('has no em dash in any reason, because these are operator-facing copy', () => {
        for (const reason of findClaims(file, ['thebackroom.dev'], expected)[0]!.unsupported) {
            assert.equal(reason.includes('—'), false, reason)
        }
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
        assert.match(claim.unsupported.join(' '), /Use/)
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

    // A readable file beside the broken one on purpose: a directory where the broken one is the ONLY
    // entry is read differently now, and says so a few tests below.
    it('warns with the file named once its own read has run, with no domain action involved', async () => {
        const broken = reader({ 'acme.conf': 'ServerName acme.com\n', '010-arbys.horizons.gg.conf': null })
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

    // The shape the real bug had. sites-available was not mounted into the agent, so every relative
    // symlink a2ensite had made dangled inside the container: readdir listed all five sites and open
    // answered ENOENT on every one. Calling that "five deleted targets" would send the operator hunting
    // for something that never happened, so the whole-directory reading replaces the per-file one.
    it('blames the mount, not five deleted targets, when nothing in the directory could be read', async () => {
        const blind = reader({ 'a.conf': null, 'b.conf': null })
        await blind.read()
        const [warning] = blind.warnings()
        assert.equal(blind.warnings().length, 1)
        assert.match(warning ?? '', /could not read a single one of them/)
        assert.match(warning ?? '', /sites-available/)
        assert.equal((warning ?? '').includes('Each is almost certainly a symlink'), false)
    })

    // One entry is the threshold, deliberately: a dedi serving a single site has a single entry, and
    // hostd is exactly as blind there as it is with five.
    it('says the same of a directory holding one entry it could not read', async () => {
        const blind = reader({ 'only.conf': null })
        await blind.read()
        assert.match(blind.warnings()[0] ?? '', /could not read a single one of them/)
    })

    it('goes back to the per-file warning as soon as one file reads', async () => {
        const mixed = reader({ 'a.conf': 'ServerName acme.com\n', 'b.conf': null })
        await mixed.read()
        assert.match(mixed.warnings()[0] ?? '', /symlink whose target was deleted or renamed/)
    })

    // Entries that are not .conf are never opened, so they cannot be the reason nothing was read.
    it('does not call a directory blind when its only unopened entries were not .conf', async () => {
        const quiet = reader({ 'acme.conf': 'ServerName acme.com\n', 'acme.conf.dpkg-old': null })
        await quiet.read()
        assert.deepEqual(quiet.warnings(), [])
    })
})

// The distinction the whole fix rests on: an empty sites-enabled and a sites-enabled hostd cannot read
// are the same value to everything downstream, and only one of them means "no file claims this name".
describe('readNothing', () => {
    const file = { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\n' }

    it('is true when entries were listed and not one of them could be read', () => {
        assert.equal(readNothing({ files: [], unreadable: ['/etc/apache2/sites-enabled/a.conf'] }), true)
    })

    it('is true on a single entry, because one site is as invisible as five', () => {
        assert.equal(readNothing({ files: [], unreadable: ['/a.conf'] }), true)
    })

    // Already handled: what was read is real and gets checked, and the rest goes to /health.
    it('is false when something was read, however much was not', () => {
        assert.equal(readNothing({ files: [file], unreadable: ['/a.conf', '/b.conf', '/c.conf'] }), false)
    })

    it('is false for a directory that genuinely holds nothing', () => {
        assert.equal(readNothing({ files: [], unreadable: [] }), false)
    })
})

describe('blindWarning', () => {
    const DIR = '/etc/apache2/sites-enabled'

    // It has to say all three, because the operator's instinct will be to look at the site.
    it('says hostd can list the directory, that a mount is the likely cause, and what stops', () => {
        const warning = blindWarning(DIR, [`${DIR}/010-arbys.horizons.gg.conf`])
        assert.match(warning, /can see \/etc\/apache2\/sites-enabled/)
        assert.match(warning, /not an empty directory/)
        assert.match(warning, /a mount is missing rather than anything a site did/)
        assert.match(warning, /cannot tell whether a hostname is already served/)
    })

    // The one line that separates a missing mount from genuinely deleted targets, because it asks from
    // inside the container, which is the only place the two answers differ.
    it('carries the exec that tells the two causes apart, naming a file that is actually there', () => {
        const warning = blindWarning(DIR, [`${DIR}/a.conf`, `${DIR}/b.conf`])
        assert.match(warning, /sudo docker exec hostd-agent cat \/etc\/apache2\/sites-enabled\/a\.conf/)
        assert.match(warning, /If that prints the file, the mount is fine/)
    })

    it('names every entry it could not read', () => {
        const warning = blindWarning(DIR, [`${DIR}/a.conf`, `${DIR}/b.conf`])
        assert.match(warning, /a\.conf, \/etc\/apache2\/sites-enabled\/b\.conf/)
    })

    it('has no em dash in it, whatever the count', () => {
        for (const paths of [['/a.conf'], ['/a.conf', '/b.conf']]) {
            assert.equal(blindWarning(DIR, paths).includes('—'), false)
        }
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

// A sweep that fails is the one thing /health used to miss. read() throws on EACCES, which is the right
// answer for the caller, but the agent's periodic sweep only logs what it catches, so the error class
// deliberately treated as the serious one was the class nobody could see without reading agent logs.
describe('a sweep that fails, rather than an entry with nothing behind it', () => {
    const DIR = '/etc/apache2/sites-enabled'

    function fs(entries: Record<string, string | null>, code: string) {
        return {
            async readdir() { return Object.keys(entries) },
            async readFile(path: string) {
                const text = entries[path.slice(path.lastIndexOf('/') + 1)]
                if (text === null || text === undefined) {
                    const error = new Error(`${code}: permission denied, open ${path}`) as NodeJS.ErrnoException
                    error.code = code
                    throw error
                }
                return text
            },
        }
    }

    it('warns, naming the file and the directory, when a file could not be opened at all', async () => {
        const reader = new SitesEnabledReader(DIR, fs({ 'locked.conf': null }, 'EACCES'))
        await assert.rejects(reader.read(), /EACCES/)
        const [warning] = reader.warnings()
        assert.match(warning ?? '', /\/etc\/apache2\/sites-enabled\/locked\.conf/)
        assert.match(warning ?? '', /\/etc\/apache2\/sites-enabled was not read either/)
        assert.match(warning ?? '', /permissions fault on the host/)
    })

    // The two classes are not the same problem and do not want the same action: one is cleaned up by
    // removing a dangling entry, the other by fixing permissions on the host.
    it('does not describe it as a name with nothing behind it', async () => {
        const reader = new SitesEnabledReader(DIR, fs({ 'locked.conf': null }, 'EACCES'))
        await assert.rejects(reader.read(), /EACCES/)
        const [warning] = reader.warnings()
        assert.match(warning ?? '', /not a name with nothing behind it/)
        assert.equal((warning ?? '').includes('symlink whose target was deleted'), false)
    })

    // The blind spot in full: a good sweep, then a failing one, must not leave /health still saying all
    // is well because the last reading happened to be clean.
    it('replaces a previous all-clear rather than preserving it', async () => {
        const entries: Record<string, string | null> = { 'acme.conf': 'ServerName acme.com\n' }
        const reader = new SitesEnabledReader(DIR, fs(entries, 'EACCES'))
        await reader.read()
        assert.deepEqual(reader.warnings(), [])

        entries['acme.conf'] = null
        await assert.rejects(reader.read(), /EACCES/)
        assert.equal(reader.warnings().length, 1)
        assert.match(reader.warnings()[0] ?? '', /could not open it/)
    })

    it('clears again once the sweep works, so a fixed permission stops being reported', async () => {
        const entries: Record<string, string | null> = { 'acme.conf': null }
        const reader = new SitesEnabledReader(DIR, fs(entries, 'EACCES'))
        await assert.rejects(reader.read(), /EACCES/)
        assert.equal(reader.warnings().length, 1)
        entries['acme.conf'] = 'ServerName acme.com\n'
        await reader.read()
        assert.deepEqual(reader.warnings(), [])
    })

    // The entries already found are real and stay reported; the failure is added to them rather than
    // replacing them.
    it('keeps the dangling entries it had already found, and adds the failure to them', async () => {
        const reader = new SitesEnabledReader(DIR, {
            async readdir() { return ['a-dangling.conf', 'b-locked.conf'] },
            async readFile(path: string) {
                const error = new Error(path.includes('dangling') ? 'ENOENT' : 'EACCES') as NodeJS.ErrnoException
                error.code = path.includes('dangling') ? 'ENOENT' : 'EACCES'
                throw error
            },
        })
        await assert.rejects(reader.read(), /EACCES/)
        const warnings = reader.warnings()
        assert.equal(warnings.length, 2)
        assert.match(warnings[0] ?? '', /b-locked\.conf/)
        assert.match(warnings[1] ?? '', /a-dangling\.conf/)
    })

    // Treating an unlistable directory as empty is older than this change and stays, but it is no longer
    // silent: a directory hostd cannot list is a sweep that failed like any other.
    it('warns when the directory itself cannot be listed, while still answering empty', async () => {
        const reader = new SitesEnabledReader(DIR, {
            async readdir() {
                const error = new Error('EACCES: permission denied, scandir') as NodeJS.ErrnoException
                error.code = 'EACCES'
                throw error
            },
            async readFile() { return '' },
        })
        assert.deepEqual(await reader.read(), { files: [], unreadable: [] })
        const [warning] = reader.warnings()
        assert.match(warning ?? '', /\/etc\/apache2\/sites-enabled could not be listed at all/)
        assert.match(warning ?? '', /cannot tell whether a hostname is already served/)
    })

    it('does not leave a stale all-clear when the directory stops being listable', async () => {
        let listable = true
        const reader = new SitesEnabledReader(DIR, {
            async readdir() {
                if (!listable) throw new Error('gone')
                return ['acme.conf']
            },
            async readFile() { return 'ServerName acme.com\n' },
        })
        await reader.read()
        assert.deepEqual(reader.warnings(), [])
        listable = false
        await reader.read()
        assert.equal(reader.warnings().length, 1)
    })

    it('has no em dash in either message', () => {
        assert.equal(unlistableWarning('/etc/apache2/sites-enabled', 'EACCES').includes('—'), false)
        assert.equal(unopenableWarning('/a.conf', '/etc/apache2/sites-enabled', 'EACCES').includes('—'), false)
    })
})
