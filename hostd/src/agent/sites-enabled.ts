// Reading just enough of a hand-written vhost to know which hostnames it serves, and to know when the
// file is doing something hostd's template cannot do. This is not an Apache configuration parser and
// must never grow into one: it reads ServerName and ServerAlias, and when it meets a directive that
// could define a hostname somewhere it cannot see, or that plainly has no equivalent in the generated
// vhost, it says so and adoption refuses. Half-understanding a file that is serving a client's site is
// the failure this exists to stop.
//
// The second half of that, the refusals below `unsupportedReasons`, was written after adopting
// thebackroom.dev took a live game off the internet. The design said adoption "cannot know what a
// hand-written vhost really did" and that was taken as licence not to look; in fact the two directives
// that mattered, a [P] rewrite onto a ws:// upstream and the total absence of a :443 block, were both
// plainly readable in the very file adoption was already parsing. What cannot be read is still refused;
// what can be read is now read.

import { posix } from 'node:path'
import { describeError } from '../shared/formats.ts'
import { normaliseHostname } from '../shared/hostnames.ts'

export type VhostFile = { path: string, text: string }
// Every reason this file cannot be adopted, not the first one found. An operator reading the preview is
// about to replace a file by hand, and being told one thing at a time (fix it, retry, be told the next
// thing) is how a site stays down for an afternoon. Empty means nothing stood in the way.
export type ServerNames = { names: string[], unsupported: string[] }

const NAME_LINE = /^\s*Server(?:Name|Alias)\s+(.+?)\s*$/i
// Include and IncludeOptional pull in files this never read. Use is mod_macro, where the hostname is an
// argument expanded at load time and is not in this file in any readable form.
const UNSUPPORTED = /^\s*(Include|IncludeOptional|Use)\s+/i

// <VirtualHost *:80 10.0.0.1:443>, with the address list captured whole.
const VHOST_OPEN = /^\s*<VirtualHost\s+([^>]*)>/i
const REWRITE_RULE = /^\s*RewriteRule\s+(.+?)\s*$/i
// mod_rewrite's flags are a bracketed, comma-separated list at the end of the rule, and only there.
const REWRITE_FLAGS = /\[([^\]]*)\]$/
// ProxyPass and nothing else: ProxyPassReverse and ProxyPassMatch do not match, because the character
// after "ProxyPass" has to be whitespace. ProxyPassReverse only rewrites response headers, so a
// disagreement there is not the site's upstream moving.
const PROXY_PASS = /^\s*ProxyPass\s+(.+?)\s*$/i
const WEBSOCKET_URL = /\bwss?:\/\/\S+/i

// How much of a directive is quoted back at the operator. Enough to find the line in their own file,
// bounded so a minified RewriteRule cannot fill the pane.
const QUOTED = 120

function quoteDirective(line: string): string {
    const trimmed = line.trim()
    return trimmed.length <= QUOTED ? trimmed : `${trimmed.slice(0, QUOTED)}...`
}

// A ProxyPass target, or null when the line carries none. Three shapes reach here:
//   ProxyPass /503.html !        an exclusion, which has a path and no target at all
//   ProxyPass / http://host/     the ordinary two-argument form
//   ProxyPass http://host/       the one-argument form, only legal inside <Location>
// Trailing key=value parameters (retry=, connectiontimeout=) are ignored: they are never the target.
function proxyTarget(rest: string): string | null {
    const tokens = rest.split(/\s+/).filter(token => token !== '')
    if (tokens.length === 0) return null
    if (tokens.length === 1) return tokens[0]!
    const second = tokens[1]!
    if (second === '!') return null
    return second
}

// Compared without a trailing slash and without case, because http://127.0.0.1:3002 and
// http://127.0.0.1:3002/ are the same upstream and Apache treats the scheme and host case-insensitively.
// Nothing else is normalised: a target that differs in any other way really is a different upstream.
function sameUpstream(found: string, expected: string): boolean {
    const trim = (value: string) => value.replace(/\/+$/, '').toLowerCase()
    return trim(found) === trim(expected)
}

// mod_rewrite accepts P and its long form proxy, in any position in the flag list, in either case.
function proxiesTheRequest(rule: string): boolean {
    const flags = rule.match(REWRITE_FLAGS)
    if (!flags) return false
    return flags[1]!.split(',').some(flag => {
        const name = flag.trim().toLowerCase()
        return name === 'p' || name === 'proxy'
    })
}

// What this file does that hostd's generated vhost would not. Each entry says what was found and why the
// template cannot carry it, because this string is what the operator reads instead of a working site.
//
// `expected` is the upstream hostd's template would proxy this environment to, passed in by the caller
// that holds the registry. Null means the caller had none to offer (no domain, no port), and the
// ProxyPass comparison is then skipped rather than guessed at: inventing an expectation here and
// refusing against it would block adoptions for a mismatch nobody established.
function unsupportedReasons(text: string, expected: string | null): string[] {
    // Keyed by kind, so a file with four [P] rewrites says the [P] thing once. The first occurrence is
    // the one quoted, which is the one an operator reading top to bottom finds first.
    const found = new Map<string, string>()
    const add = (kind: string, reason: string) => { if (!found.has(kind)) found.set(kind, reason) }

    let sawVirtualHost = false
    let sawPort443 = false

    for (const raw of text.split('\n')) {
        if (/^\s*#/.test(raw)) continue

        const blocked = raw.match(UNSUPPORTED)
        if (blocked) {
            add('include', `${blocked[1]} is used, so the hostnames this file serves cannot be read here`)
            continue
        }

        const opened = raw.match(VHOST_OPEN)
        if (opened) {
            sawVirtualHost = true
            // Any address on the line ending :443, not only *:443. An origin listening on 443 at one
            // address is still an origin that terminates TLS, which is the fact this is measuring.
            if (opened[1]!.split(/\s+/).some(address => address.endsWith(':443'))) sawPort443 = true
        }

        const rewrite = raw.match(REWRITE_RULE)
        if (rewrite && proxiesTheRequest(rewrite[1]!)) {
            add('rewrite-proxy', `${quoteDirective(raw)} carries the [P] flag, so it proxies the request through mod_proxy instead of answering or redirecting it. hostd's generated vhost has no rewrite of its own and no way to reproduce this, so adopting would drop the rule and hand those requests to whatever ProxyPass sits below it.`)
        }

        const websocket = raw.match(WEBSOCKET_URL)
        if (websocket) {
            add('websocket', `${quoteDirective(raw)} sends traffic to ${websocket[0]}, a WebSocket upstream served by mod_proxy_wstunnel. hostd's generated vhost proxies plain HTTP only, so adopting would leave the upgrade handshake unanswered and every realtime connection this site makes would stop.`)
        }

        const proxy = raw.match(PROXY_PASS)
        if (proxy && expected !== null) {
            const target = proxyTarget(proxy[1]!)
            // A ws:// or wss:// target is already named by the reason above, in words that say what is
            // actually wrong with it. Reporting it a second time as a port disagreement would send the
            // operator to the registry to change a port that is perfectly correct.
            if (target !== null && !WEBSOCKET_URL.test(target) && !sameUpstream(target, expected)) {
                add('proxy-target', `${quoteDirective(raw)} sends traffic to ${target}, and hostd's generated vhost for this environment would send it to ${expected}. Adopting would move the site onto a different upstream, so either the registry's port is not the one this file is really serving or this file belongs to another site.`)
            }
        }
    }

    // Last, because it is a fact about the whole file rather than about any one line, and because a file
    // with no <VirtualHost> in it at all is a fragment this has no business judging.
    if (sawVirtualHost && !sawPort443) {
        add('no-443', 'This file has no port 443 block, so the origin answers plain HTTP on port 80 only and whatever sits in front of it is terminating TLS on its own (Cloudflare calls this Flexible). hostd\'s generated vhost sends every request on port 80 to https and serves 443 itself, so the visitor would be redirected back through the CDN to the same HTTP origin and round again, forever. Give the origin a port 443 block, or take the site off Flexible SSL, before adopting it.')
    }

    return [...found.values()]
}

// `expected` is hostd's own upstream for this environment, or null when there is none to compare
// against. See unsupportedReasons for what it is used for and why it is never guessed here.
export function parseServerNames(text: string, expected: string | null = null): ServerNames {
    const names: string[] = []
    for (const raw of text.split('\n')) {
        // Apache treats a line whose first non-space character is # as a comment in full; there is no
        // trailing-comment syntax, so this is the whole rule.
        if (/^\s*#/.test(raw)) continue
        if (UNSUPPORTED.test(raw)) continue

        const match = raw.match(NAME_LINE)
        if (!match) continue
        // ServerAlias takes several names on one line, separated by whitespace.
        for (const candidate of match[1]!.split(/\s+/)) {
            const host = normaliseHostname(candidate)
            // A name that will not normalise is a variable, a wildcard or a typo. None of those is a
            // hostname this can claim to have understood, so it is dropped rather than carried.
            if (host !== null && !names.includes(host)) names.push(host)
        }
    }
    return { names, unsupported: unsupportedReasons(text, expected) }
}

// The file itself is carried, not only what was understood of it. Adoption switches this file off and
// puts hostd's own in its place, in one reload, on a site that is serving somebody right now, and what
// this parser reads is a handful of directives out of however many the file has. A custom error page,
// basic auth or a header rule is invisible to everything above except the text, so the text travels with
// the claim and the operator sees the whole of what they are replacing before they confirm it. It is
// their own server's configuration, and every route that can reach it is admin-only.
export type Claim = { path: string, text: string, names: string[], unsupported: string[] }

export function findClaims(files: VhostFile[], hostnames: string[], expected: string | null = null): Claim[] {
    const claims: Claim[] = []
    for (const file of files) {
        const parsed = parseServerNames(file.text, expected)
        if (!parsed.names.some(name => hostnames.includes(name))) continue
        claims.push({ path: file.path, text: file.text, names: parsed.names, unsupported: parsed.unsupported })
    }
    return claims
}

// What one sweep of sites-enabled found: the files that were read, and the paths of the ones that were
// not. The second list is never silently dropped, because a file nobody can open is the whole subject of
// the health warning below.
export type SitesEnabled = { files: VhostFile[], unreadable: string[] }

export type SitesEnabledFs = {
    readdir(dir: string): Promise<string[]>
    readFile(path: string): Promise<string>
}

// Codes that mean there is nothing behind the directory entry to read, as opposed to something there
// this process cannot get at.
//
// ENOENT is the observed case: on Debian, sites-enabled holds symlinks into sites-available, and a
// symlink whose target was deleted or renamed still shows up in readdir while open() says ENOENT.
// ENOTDIR is the same kind of miss, a path component that turned out to be a file.
//
// A file in that state serves nothing. Apache has no contents for it, so it cannot be claiming a
// hostname, and aborting an unrelated site's domain change because of it is plainly wrong. It is skipped
// and reported rather than skipped and forgotten.
//
// EACCES is deliberately NOT here, and that is a different judgement rather than an oversight. A file
// this process may not open may well be there and serving a hostname right now; treating it as absent
// would let hostd write a second vhost for a name something else already answers, and Apache decides
// which of the two wins by load order. hostd runs as root, so this should not happen at all, and if it
// does the honest answer is to fail the call loudly rather than to act on a view of the directory that
// is known to be incomplete.
const NOTHING_TO_READ = new Set(['ENOENT', 'ENOTDIR'])

// Entries were listed and not one of them could be read. This is NOT an empty directory, and the whole
// point of naming the state is that the two are indistinguishable to everything downstream: both answer
// "no file claims this hostname", one truthfully and one because hostd is blind. Some entries unreadable
// is a different thing and is handled above: what was read is real and is checked.
//
// The threshold is one entry. It is tempting to want two or three before calling it a mount fault, but a
// dedi serving one site has one entry, and the cost of being wrong is not symmetric: a genuinely
// dangling symlink fails apache2ctl configtest, which hostd runs before every reload, so the domain
// change was going to fail either way and refusing here only changes which message the operator gets.
// Being wrong the other way means adopting over a site that is serving somebody right now.
//
// Only ever asked of a sweep that completed. A sweep that threw hands no result back at all.
export function readNothing(sites: SitesEnabled): boolean {
    return sites.files.length === 0 && sites.unreadable.length > 0
}

// One reader, shared by the domain verbs and by the agent's periodic health sweep, so /health can say a
// file is unreadable without anyone having run a domain action first.
export class SitesEnabledReader {
    private unreadable: string[] = []
    // Whether the last completed sweep read nothing at all out of a directory that had entries in it.
    // Held rather than recomputed because warnings() has no result to look at, and false on either
    // failure path below: those have a failure of their own to report, which says more than this would.
    private blind = false
    // The last sweep's own failure, as opposed to the entries it found nothing behind. Held separately
    // because the two mean different things and want different actions: a name with nothing behind it is
    // cleaned up by removing the entry, while a directory or file this process cannot read is a host
    // permissions fault on a service that runs as root and should not be meeting one at all.
    private failure: string | null = null

    constructor(private readonly dir: string, private readonly fs: SitesEnabledFs) {}

    async read(): Promise<SitesEnabled> {
        let names: string[]
        try {
            names = await this.fs.readdir(this.dir)
        } catch (error) {
            // A sites-enabled that cannot be listed at all is still an empty one to the caller, which is
            // what it saw before this class existed: every claim check then finds nothing and the domain
            // verbs carry on. What is new is that it no longer passes in silence. Both pieces of state
            // are replaced, so a sweep that fails cannot leave the previous all-clear standing.
            this.unreadable = []
            this.blind = false
            this.failure = unlistableWarning(this.dir, describeError(error))
            return { files: [], unreadable: [] }
        }
        const files: VhostFile[] = []
        const unreadable: string[] = []
        for (const name of names) {
            if (!name.endsWith('.conf')) continue
            const path = posix.join(this.dir, name)
            let text: string
            try {
                text = await this.fs.readFile(path)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code ?? ''
                if (!NOTHING_TO_READ.has(code)) {
                    // Recorded before it is rethrown. The throw is the point for whoever called this, but
                    // the periodic sweep only logs what it catches, so without this the one error class
                    // deliberately treated as serious would be the one thing /health never mentioned.
                    // What was found up to here is kept rather than discarded: those entries are real.
                    this.unreadable = unreadable
                    // Not blind, whatever was read so far: this sweep stopped early, so "nothing in the
                    // whole directory could be read" was never established, and the failure below says
                    // more about what is wrong than a guess at a missing mount would.
                    this.blind = false
                    this.failure = unopenableWarning(path, this.dir, describeError(error))
                    throw error
                }
                unreadable.push(path)
                continue
            }
            files.push({ path, text })
        }
        this.unreadable = unreadable
        this.blind = readNothing({ files, unreadable })
        this.failure = null
        return { files, unreadable }
    }

    warnings(): string[] {
        // The sweep's own failure first: it means hostd cannot see part of what it is reasoning about,
        // so it colours everything below it.
        const failure = this.failure ? [this.failure] : []
        // Replaces the dangling-symlink warning rather than joining it. Every entry unreadable at once
        // is almost never several targets deleted on the same day, and sending the operator off to hunt
        // for targets that were never deleted is worse than saying nothing.
        if (this.blind) return [...failure, blindWarning(this.dir, this.unreadable)]
        return [...failure, ...unreadableWarnings(this.unreadable)]
    }
}

// The directory itself could not be listed. hostd is then reasoning about a server it cannot see, which
// is worse than any one broken entry in it.
export function unlistableWarning(dir: string, reason: string): string {
    return `Apache's sites-enabled at ${dir} could not be listed at all: ${reason}. hostd cannot see any `
        + 'of the vhosts already on this server, so it cannot tell whether a hostname is already served '
        + 'by one of them, and it is going ahead as though the directory were empty. Check the directory '
        + 'is there and that hostd\'s mount of it can be read. hostd runs as root, so this should not be '
        + 'possible and is a fault on the host rather than anything a site did.'
}

// A file that is there as far as anyone can tell, and that this process was refused. EACCES above all.
// Deliberately not folded in with the dangling entries above: this one is not cleaned up by deleting
// anything, and the file it names may be serving a hostname right now.
export function unopenableWarning(path: string, dir: string, reason: string): string {
    return `${path} is in Apache's sites-enabled and hostd could not open it: ${reason}. This is not a `
        + 'name with nothing behind it. The file may well be there and serving a hostname right now, and '
        + 'hostd simply cannot see it, so it refuses every domain action rather than risk writing a '
        + 'second vhost for a hostname that file already answers. Whatever comes after it in '
        + `${dir} was not read either. hostd runs as root, so this is a permissions fault on the host `
        + 'itself and no domain change can take effect until it is put right.'
}

// The directory listed fine and every single file behind it was a miss. Said in its own words, because
// the honest reading of it is not "a lot of dangling symlinks" but "hostd is not looking at what Apache
// is looking at", and the operator's move is to check the mount, not to go hunting for deleted targets.
//
// The shape this had in the wild: sites-enabled was mounted into the agent and sites-available was not,
// so every relative symlink a2ensite had made resolved to a path that did not exist inside the
// container. The host read each file perfectly well, hostd read none of them, and nothing anywhere said
// so. The exec below is the one line that tells the two apart, because it asks the question from inside
// the container where the answer actually differs.
export function blindWarning(dir: string, paths: string[]): string {
    const many = paths.length > 1
    return `hostd can see ${dir} and the ${paths.length} vhost${many ? 's' : ''} listed in it `
        + `(${paths.join(', ')}), and it could not read a single one of them. That is not an empty `
        + 'directory and hostd will not treat it as one. It almost always means a mount is missing '
        + 'rather than anything a site did: on Debian these entries are relative symlinks into '
        + '/etc/apache2/sites-available, so if that directory is not mounted into hostd-agent beside '
        + 'this one, every link dangles inside the container while the host reads the same files '
        + 'perfectly well. Until it is fixed hostd cannot tell whether a hostname is already served by '
        + 'one of these files, so it refuses every domain action rather than write a second vhost for a '
        + 'name one of them already answers. Check it from the host with: sudo docker exec hostd-agent '
        + `cat ${paths[0] ?? posix.join(dir, '<name>.conf')}`
        + '. If that prints the file, the mount is fine and these entries really are symlinks whose '
        + 'targets were deleted or renamed, which fails apache2ctl configtest and stops domain changes '
        + 'just as surely; remove them. If it says no such file while the host reads it, the mount is '
        + 'the fault.'
}

// Written for somebody reading /health at nine at night who has never seen this code. It has to say what
// is broken, why nothing looks broken, and what stops until it is fixed.
export function unreadableWarnings(paths: string[]): string[] {
    if (paths.length === 0) return []
    const many = paths.length > 1
    const it = many ? 'they are' : 'it is'
    const cause = many
        ? 'Each is almost certainly a symlink whose target was deleted or renamed'
        : 'It is almost certainly a symlink whose target was deleted or renamed'
    return [
        `${paths.join(', ')} ${many ? 'are' : 'is'} listed in Apache's sites-enabled but cannot be opened. `
        + `${cause}. Apache's own configuration test fails while ${it} there, and hostd runs that test `
        + `before every reload, so no domain change on this server can take effect until ${it} removed. `
        + 'Apache keeps serving the configuration it loaded earlier, so the sites look fine and nothing '
        + 'else reports a problem.',
    ]
}
