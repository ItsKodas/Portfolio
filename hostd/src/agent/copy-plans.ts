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
    // through renameStream for the engine `rename` names, when it names one. errorFilter 'postgres' means
    // psql's exit code is not enough on its own: psql carries on past a failed statement, so its stderr is
    // read for ERROR: lines.
    | { kind: 'exec', service: string, before: string[] | null, argv: string[], rename: RenameEngine | null, errorFilter: 'postgres' | null }
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

// A postgres identifier as a dump writes one: bare, or double-quoted with any quote doubled.
const PG_IDENT = '(?:"(?:[^"]|"")*"|[^ "]+)'
// Each matches everything up to the database name, and nothing after it: only the name that follows is
// ever rewritten, so an owner, a grantee or a role that happens to be called `<from>` stays as it is.
const POSTGRES_STATEMENTS: RegExp[] = [
    /^CREATE DATABASE /,
    /^ALTER DATABASE /,
    /^COMMENT ON DATABASE /,
    /^(?:GRANT|REVOKE) [A-Z_, ]+? ON DATABASE /,
    new RegExp(`^SECURITY LABEL (?:FOR ${PG_IDENT} )?ON DATABASE `),
    new RegExp(`^ALTER ROLE ${PG_IDENT} IN DATABASE `),
]
const MYSQL_CREATE_OPTIONS = ['/*!32312 IF NOT EXISTS*/ ', 'IF NOT EXISTS ', '']

function renamePostgres(line: string, from: string, to: string): string {
    for (const statement of POSTGRES_STATEMENTS) {
        const match = statement.exec(line)
        if (match === null) continue
        const renamed = renamePostgresName(line.slice(match[0].length), from, to)
        return renamed === null ? line : match[0] + renamed
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
    return swap('USE ') ?? swap('ALTER DATABASE ') ?? line
}

// One line, without its line ending.
export function renameDatabaseLine(engine: RenameEngine, line: string, from: string, to: string): string {
    return engine === 'postgres' ? renamePostgres(line, from, to) : renameMysql(line, from, to)
}

// Lines that can never be renamed are passed through as soon as their first bytes show it, rather than
// buffered to their end: a mysqldump INSERT line can run to megabytes. Every prefix below is shorter than
// this, so PROBE bytes are always enough to decide.
const PROBE = 64
const POSTGRES_PREFIXES = [
    'CREATE DATABASE ', 'ALTER DATABASE ', 'COMMENT ON DATABASE ', 'GRANT ', 'REVOKE ', 'SECURITY LABEL ', 'ALTER ROLE ',
    '\\connect ', 'COPY ',
]
const MYSQL_PREFIXES = ['CREATE DATABASE ', 'USE ', 'ALTER DATABASE ']
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
        return { problem: `${service}: refusing to load database ${JSON.stringify(from)} into ${JSON.stringify(to)}, which is not a plain database name` }
    }

    const exec = (before: string[] | null, argv: string[], rename: RenameEngine | null, errorFilter: 'postgres' | null): LoadPlan =>
        ({ kind: 'exec', service, before, argv, rename, errorFilter })

    switch (entry.engine) {
        case 'postgres': {
            const user = named(service, entry.dump.userEnv, 'POSTGRES_USER')
            if (isProblem(user)) return user
            return exec(['sh', '-c', postgresWipe(user)], ['sh', '-c', `psql -U "$${user}" -d postgres`], 'postgres', 'postgres')
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
            return exec(['sh', '-c', mysqlWipe(connect)], ['sh', '-c', connect], client, null)
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
            ], null, null)
        }
    }
}

// ---- wiping the environment's databases before a load --------------------------------------------------
//
// Every database the environment's server has goes, not only <id>-<env>: pg_dumpall and mysqldump
// --all-databases recreate every database live has, and one the environment already holds from an earlier
// copy would otherwise fail its CREATE TABLEs with "already exists". What stays is what the server itself
// needs. The names to drop are read from the server and quoted by it (format's %I, and doubled backquotes
// for mysql), so no name ever reaches the shell as code.

const POSTGRES_KEEP = "('postgres', 'template0', 'template1')"
const MYSQL_KEEP = "('mysql', 'sys', 'information_schema', 'performance_schema')"

function postgresWipe(user: string): string {
    const psql = `psql -U "$${user}" -d postgres -v ON_ERROR_STOP=1 -Atq`
    // Every other connection ends first: a database cannot be dropped while anything is connected to it.
    // By hand rather than DROP ... WITH (FORCE), which postgres before 13 does not have.
    return `${psql} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname NOT IN ${POSTGRES_KEEP}" >/dev/null`
        + ` && drops=$(${psql} -c "SELECT format('DROP DATABASE IF EXISTS %I;', datname) FROM pg_database WHERE datname NOT IN ${POSTGRES_KEEP}")`
        + ` && printf '%s\\n' "$drops" | ${psql}`
}

function mysqlWipe(connect: string): string {
    // CHAR(96) is a backquote, spelled so because a backquote inside the double quotes below would be
    // read by the shell as a command.
    const tick = 'CHAR(96 USING utf8mb4)'
    const select = `SELECT CONCAT('DROP DATABASE IF EXISTS ', ${tick}, REPLACE(schema_name, ${tick}, REPEAT(${tick}, 2)), ${tick}, ';')`
        + ` FROM information_schema.schemata WHERE schema_name NOT IN ${MYSQL_KEEP}`
    // -r, so a name is printed as it is rather than with its backslashes escaped
    return `drops=$(${connect} -N -B -r -e "${select}") && printf '%s\\n' "$drops" | ${connect}`
}

// ---- readiness ---------------------------------------------------------------------------------------

// What says a database the copy has just started (or restarted) takes connections: a container that is
// running is not yet a server that answers. Run in the environment's container with the dump's own
// credential variables; exit 0 means ready. null for what has no server of its own to ask.
export function readyProbe(service: string, entry: ServiceEntry): string[] | PlanProblem | null {
    if (entry.role !== 'database') return null
    switch (entry.engine) {
        case 'postgres': {
            const user = named(service, entry.dump.userEnv, 'POSTGRES_USER')
            if (isProblem(user)) return user
            return ['sh', '-c', `pg_isready -U "$${user}"`]
        }
        case 'mysql':
        case 'mariadb': {
            const admin = entry.engine === 'mysql' ? 'mysqladmin' : 'mariadb-admin'
            const defaultPassword = entry.engine === 'mysql' ? 'MYSQL_ROOT_PASSWORD' : 'MARIADB_ROOT_PASSWORD'
            const password = passwordNamed(service, entry.dump.passwordEnv, defaultPassword)
            if (isProblem(password)) return password
            const user = entry.dump.userEnv === undefined ? 'root' : named(service, entry.dump.userEnv, 'root')
            if (isProblem(user)) return user
            const userArg = entry.dump.userEnv === undefined ? '-u root' : `-u "$${user}"`
            return ['sh', '-c', `MYSQL_PWD="$${password}" ${admin} ${userArg} ping`]
        }
        case 'mongodb': {
            const ping = `--quiet --eval "db.adminCommand('ping')"`
            return ['sh', '-c', `if command -v mongosh >/dev/null 2>&1; then mongosh ${ping}; else mongo ${ping}; fi`]
        }
        case 'redis':
            // redis-cli exits 0 on an error reply (LOADING, say), so the answer itself is checked
            return ['sh', '-c', '[ "$(redis-cli ping)" = PONG ]']
        case 'sqlite':
        case 'generic':
            return null
    }
}

// psql reports a failed statement on stderr and carries on. Roles and databases the environment's server
// already has (its own superuser, say) are expected to collide; any other ERROR: fails the load.
const TOLERATED = /ERROR:\s+(role|database) "[^"]*" already exists/

const isLoadError = (line: string): boolean => line.includes('ERROR:') && !TOLERATED.test(line)

export function postgresLoadErrors(stderr: string): string[] {
    return stderr.split(/\r?\n/).filter(isLoadError)
}

// The streaming form, fed from exec's onStderr: psql's stderr for a whole dump is unbounded (one "already
// exists" per role, and any number of real errors), so it is never held whole. Only the start of the
// current line is kept (psql writes `psql:<stdin>:N: ERROR:` at the start of a line, well inside
// LINE_HEAD), and only the first MAX_ERRORS error lines, while count() still says how many there were.
const LINE_HEAD = 1024
const MAX_ERRORS = 50

export type PostgresErrorCollector = { push(chunk: Buffer): void, errors(): string[], count(): number }

export function postgresErrorCollector(): PostgresErrorCollector {
    // Bytes, decoded once the line is complete, so a character split across two chunks survives.
    let head: Buffer[] = []
    let headLength = 0
    let total = 0
    const found: string[] = []
    const finishLine = () => {
        const text = Buffer.concat(head).toString('utf8')
        const line = text.endsWith('\r') ? text.slice(0, -1) : text
        head = []
        headLength = 0
        if (!isLoadError(line)) return
        total++
        if (found.length < MAX_ERRORS) found.push(line)
    }
    // A last line with no newline counts too, once the caller asks.
    const flush = () => { if (headLength > 0) finishLine() }
    return {
        push(chunk) {
            let start = 0
            while (start < chunk.length) {
                const newline = chunk.indexOf(10, start)
                const end = newline === -1 ? chunk.length : newline
                if (headLength < LINE_HEAD) {
                    const piece = chunk.subarray(start, Math.min(end, start + LINE_HEAD - headLength))
                    head.push(piece)
                    headLength += piece.length
                }
                if (newline === -1) break
                finishLine()
                start = newline + 1
            }
        },
        errors() {
            flush()
            return [...found]
        },
        count() {
            flush()
            return total
        },
    }
}
