// How a live dump is loaded into an environment's own database container: the per-engine load commands,
// and the filter that renames live's database `<id>` to `<id>-<env>` on the way in.
//
// Like backup-dumps.ts, every command here is a fixed string. The registry contributes only environment
// variable NAMES (checked by the same helpers the dump uses, so a load authenticates exactly as its dump
// did), and the two database names are checked against a narrow pattern before they go anywhere near a
// shell. Values are read inside the container, so no password reaches an argv or a process list.
//
// The rename is deliberately narrow. A dump's data can mention the site id anywhere (a row, a COPY line,
// an INSERT), and rewriting data would corrupt it silently. So only the handful of statements that name a
// database are rewritten, and only when the name is `<from>` exactly: `acmeold`, `acme_x` and `acme-live`
// are other databases and stay as they are. Everything else passes through byte for byte.

import { Transform, type TransformCallback } from 'node:stream'
import type { ServiceEntry } from '../shared/registry.ts'
import { isProblem, named, passwordNamed, type PlanProblem } from './backup-dumps.ts'

export type RenameEngine = 'postgres' | 'mysql' | 'mariadb'

export type LoadPlan =
    // Run `before` (if any) in the environment's container, then run argv there with the dump on stdin,
    // through renameStream when `rename` is set. errorFilter 'postgres' means psql's exit code is not
    // enough on its own: psql carries on past a failed statement, so its stderr is read for ERROR: lines.
    | { kind: 'exec', service: string, before: string[] | null, argv: string[], rename: boolean, errorFilter: 'postgres' | null }
    // The run reads the environment's redis data directory and copies the rdb file in itself.
    | { kind: 'redis', service: string }
    // The run copies the sqlite file itself, with sqlite3's .backup.
    | { kind: 'sqlite', service: string, file: string }

// Project ids and environment names are narrower than this already. Checking again here is what makes it
// safe for the names to sit inside quotes in a shell command, whatever a caller passes.
const DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

// ---- the rename filter -------------------------------------------------------------------------------

// postgres writes a name bare when it is a plain lower-case identifier and double-quoted otherwise (which a
// hyphenated site id always is). The new name has a hyphen, so it is always written quoted.
function renamePostgresName(rest: string, from: string, to: string): string | null {
    for (const form of [`"${from}"`, from]) {
        if (!rest.startsWith(form)) continue
        const next = rest.charAt(form.length)
        if (next === '' || next === ' ' || next === ';') return `"${to}"${rest.slice(form.length)}`
    }
    return null
}

const POSTGRES_STATEMENTS = ['CREATE DATABASE ', 'ALTER DATABASE ', 'COMMENT ON DATABASE ']
const MYSQL_CREATE_OPTIONS = ['/*!32312 IF NOT EXISTS*/ ', 'IF NOT EXISTS ', '']

function renamePostgres(line: string, from: string, to: string): string {
    for (const statement of POSTGRES_STATEMENTS) {
        if (!line.startsWith(statement)) continue
        const renamed = renamePostgresName(line.slice(statement.length), from, to)
        return renamed === null ? line : statement + renamed
    }
    if (line.startsWith('\\connect ')) {
        const rest = line.slice('\\connect '.length)
        // pg_dumpall writes a name that is not a plain identifier (a hyphenated site id) as a connection
        // string. psql reads a double-quoted name just as well, so the new name is written that way.
        const forms = [from, `"${from}"`, `-reuse-previous=on "dbname='${from}'"`, `-reuse-previous=on "dbname=${from}"`]
        if (forms.includes(rest)) return `\\connect "${to}"`
    }
    return line
}

function renameMysql(line: string, from: string, to: string): string {
    const quoted = '`' + from + '`'
    const swap = (prefix: string): string | null => {
        if (!line.startsWith(prefix + quoted)) return null
        const next = line.charAt(prefix.length + quoted.length)
        if (next !== '' && next !== ' ' && next !== ';') return null
        return prefix + '`' + to + '`' + line.slice(prefix.length + quoted.length)
    }
    if (line.startsWith('CREATE DATABASE ')) {
        for (const option of MYSQL_CREATE_OPTIONS) {
            const renamed = swap('CREATE DATABASE ' + option)
            if (renamed !== null) return renamed
        }
        return line
    }
    return swap('USE ') ?? line
}

// One line, without its line ending.
export function renameDatabaseLine(engine: RenameEngine, line: string, from: string, to: string): string {
    return engine === 'postgres' ? renamePostgres(line, from, to) : renameMysql(line, from, to)
}

// Lines that can never be renamed are passed through as soon as their first bytes show it, rather than
// buffered to their end: a mysqldump INSERT line can run to megabytes. Every prefix below is shorter than
// this, so PROBE bytes are always enough to decide.
const PROBE = 64
const POSTGRES_PREFIXES = [...POSTGRES_STATEMENTS, '\\connect ', 'COPY ']
const MYSQL_PREFIXES = ['CREATE DATABASE ', 'USE ']
const COPY_START = /^COPY .* FROM stdin;$/
const COPY_END = '\\.'

// A line-splitting transform that applies renameDatabaseLine. It works on bytes, not text: a dump holds
// whatever bytes the data held, and decoding them as UTF-8 would mangle anything that is not. Lines are
// read as latin1, which maps every byte to one character and back, so a line that is not rewritten, and
// every byte of one that is, other than the name, comes out exactly as it went in. Line endings (LF or
// CRLF) are kept, and so is a last line with no newline.
//
// For postgres it also tracks COPY blocks: between `COPY ... FROM stdin;` and `\.` every line is data, and
// a data line that happens to read `CREATE DATABASE acme ...` is still data.
export function renameStream(engine: RenameEngine, from: string, to: string): Transform {
    const prefixes = engine === 'postgres' ? POSTGRES_PREFIXES : MYSQL_PREFIXES
    let pending: Buffer[] = []
    let passthrough = false
    let inCopy = false

    // Called only with PROBE bytes of a longer line, which is longer than every prefix and than `\.`: so
    // inside a COPY block such a line is data, and outside one only its prefix can make it matter.
    const mayMatter = (head: string): boolean => !inCopy && prefixes.some(prefix => head.startsWith(prefix))

    const finishLine = (line: Buffer): Buffer => {
        const text = line.toString('latin1')
        const ending = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : ''
        const body = text.slice(0, text.length - ending.length)
        if (engine === 'postgres') {
            if (inCopy) {
                if (body === COPY_END) inCopy = false
                return line
            }
            if (COPY_START.test(body)) {
                inCopy = true
                return line
            }
        }
        const renamed = renameDatabaseLine(engine, body, from, to)
        return renamed === body ? line : Buffer.from(renamed + ending, 'latin1')
    }

    return new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
            let start = 0
            while (start < chunk.length) {
                const newline = chunk.indexOf(10, start)
                const end = newline === -1 ? chunk.length : newline + 1
                const piece = chunk.subarray(start, end)
                start = end
                if (passthrough) {
                    this.push(piece)
                    if (newline !== -1) passthrough = false
                    continue
                }
                pending.push(piece)
                const line = pending.length === 1 ? piece : Buffer.concat(pending)
                if (newline !== -1) {
                    pending = []
                    this.push(finishLine(line))
                    continue
                }
                pending = [line]
                if (line.length >= PROBE && !mayMatter(line.subarray(0, PROBE).toString('latin1'))) {
                    pending = []
                    passthrough = true
                    this.push(line)
                }
            }
            callback()
        },
        flush(callback: TransformCallback) {
            if (pending.length > 0) this.push(finishLine(Buffer.concat(pending)))
            pending = []
            callback()
        },
    })
}

// ---- the load plans ----------------------------------------------------------------------------------

export function loadPlan(service: string, entry: ServiceEntry, from: string, to: string): LoadPlan | PlanProblem | null {
    if (entry.role !== 'database') return null
    if (entry.engine === 'generic') {
        return { problem: `${service} uses the generic engine, which cannot be copied while live runs; give it a real engine in the registry` }
    }
    if (entry.engine === 'sqlite') return { kind: 'sqlite', service, file: entry.file }
    if (entry.engine === 'redis') return { kind: 'redis', service }
    if (!DATABASE_NAME.test(from) || !DATABASE_NAME.test(to)) {
        return { problem: `${service}: refusing to load into an oddly named database` }
    }

    const exec = (before: string[] | null, argv: string[], rename: boolean, errorFilter: 'postgres' | null): LoadPlan =>
        ({ kind: 'exec', service, before, argv, rename, errorFilter })

    switch (entry.engine) {
        case 'postgres': {
            const user = named(service, entry.dump.userEnv, 'POSTGRES_USER')
            if (isProblem(user)) return user
            // The dump's own CREATE DATABASE then makes the database fresh, rather than loading into an
            // old copy's tables. FORCE ends any session the environment's site still has open.
            return exec(
                ['sh', '-c', `psql -U "$${user}" -d postgres -c "DROP DATABASE IF EXISTS \\"${to}\\" WITH (FORCE)"`],
                ['sh', '-c', `psql -U "$${user}" -d postgres`],
                true, 'postgres',
            )
        }
        case 'mysql':
        case 'mariadb': {
            // The same credentials as dumpPlan: MYSQL_PWD from the password variable, and root unless the
            // registry names a user variable.
            const client = entry.engine
            const defaultPassword = entry.engine === 'mysql' ? 'MYSQL_ROOT_PASSWORD' : 'MARIADB_ROOT_PASSWORD'
            const password = passwordNamed(service, entry.dump.passwordEnv, defaultPassword)
            if (isProblem(password)) return password
            const user = entry.dump.userEnv === undefined ? 'root' : named(service, entry.dump.userEnv, 'root')
            if (isProblem(user)) return user
            const userArg = entry.dump.userEnv === undefined ? '-u root' : `-u "$${user}"`
            const connect = `MYSQL_PWD="$${password}" ${client} ${userArg}`
            // Single quotes, so the shell leaves the backquotes alone.
            return exec(['sh', '-c', `${connect} -e 'DROP DATABASE IF EXISTS \`${to}\`'`], ['sh', '-c', connect], true, null)
        }
        case 'mongodb': {
            const user = named(service, entry.dump.userEnv, 'MONGO_INITDB_ROOT_USERNAME')
            if (isProblem(user)) return user
            const password = passwordNamed(service, entry.dump.passwordEnv, 'MONGO_INITDB_ROOT_PASSWORD')
            if (isProblem(password)) return password
            // mongorestore renames namespaces itself, so the archive is fed through untouched, and --drop
            // replaces each collection rather than merging into it.
            return exec(null, [
                'sh', '-c',
                `mongorestore --archive --gzip --drop --nsFrom "${from}.*" --nsTo "${to}.*" \${${user}:+-u "$${user}" -p "$${password}" --authenticationDatabase admin}`,
            ], false, null)
        }
    }
}

// psql reports a failed statement on stderr and carries on. Roles and databases the environment's server
// already has (its own superuser, say) are expected to collide; any other ERROR: fails the load.
const TOLERATED = /ERROR:\s+(role|database) "[^"]*" already exists/

export function postgresLoadErrors(stderr: string): string[] {
    return stderr.split(/\r?\n/).filter(line => line.includes('ERROR:') && !TOLERATED.test(line))
}
