// Reading just enough of a hand-written vhost to know which hostnames it serves. This is not an Apache
// configuration parser and must never grow into one: it reads ServerName and ServerAlias, and when it
// meets a directive that could define a hostname somewhere it cannot see, it says so and adoption
// refuses. Half-understanding a file that is serving a client's site is the failure this exists to stop.

import { posix } from 'node:path'
import { describeError } from '../shared/formats.ts'
import { normaliseHostname } from '../shared/hostnames.ts'

export type VhostFile = { path: string, text: string }
export type ServerNames = { names: string[], unsupported: string | null }

const NAME_LINE = /^\s*Server(?:Name|Alias)\s+(.+?)\s*$/i
// Include and IncludeOptional pull in files this never read. Use is mod_macro, where the hostname is an
// argument expanded at load time and is not in this file in any readable form.
const UNSUPPORTED = /^\s*(Include|IncludeOptional|Use)\s+/i

export function parseServerNames(text: string): ServerNames {
    const names: string[] = []
    let unsupported: string | null = null
    for (const raw of text.split('\n')) {
        // Apache treats a line whose first non-space character is # as a comment in full; there is no
        // trailing-comment syntax, so this is the whole rule.
        if (/^\s*#/.test(raw)) continue

        const blocked = raw.match(UNSUPPORTED)
        if (blocked && unsupported === null) {
            unsupported = `${blocked[1]} is used, so the hostnames this file serves cannot be read here`
            continue
        }

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
    return { names, unsupported }
}

// The file itself is carried, not only what was understood of it. Adoption switches this file off and
// puts hostd's own in its place, in one reload, on a site that is serving somebody right now, and what
// this parser reads is two directives out of however many the file has. A custom rewrite, basic auth or
// a bespoke error page is invisible to everything above except the text, so the text travels with the
// claim and the operator sees the whole of what they are replacing before they confirm it. It is their
// own server's configuration, and every route that can reach it is admin-only.
export type Claim = { path: string, text: string, names: string[], unsupported: string | null }

export function findClaims(files: VhostFile[], hostnames: string[]): Claim[] {
    const claims: Claim[] = []
    for (const file of files) {
        const parsed = parseServerNames(file.text)
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

// One reader, shared by the domain verbs and by the agent's periodic health sweep, so /health can say a
// file is unreadable without anyone having run a domain action first.
export class SitesEnabledReader {
    private unreadable: string[] = []
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
                    this.failure = unopenableWarning(path, this.dir, describeError(error))
                    throw error
                }
                unreadable.push(path)
                continue
            }
            files.push({ path, text })
        }
        this.unreadable = unreadable
        this.failure = null
        return { files, unreadable }
    }

    warnings(): string[] {
        // The sweep's own failure first: it means hostd cannot see part of what it is reasoning about,
        // so it colours everything below it.
        return [...(this.failure ? [this.failure] : []), ...unreadableWarnings(this.unreadable)]
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
