// What each database engine's dump is: a fixed command string, a file name in the staging directory, and
// nothing that came from a request. The only registry-driven part of any command is an environment
// variable NAME, checked against ENV_NAME_PATTERN below, so the worst a bad registry entry can do is name
// a variable that does not exist. Values are never read here: the command reads them inside the container,
// from that container's own environment, which is why no password ever reaches an argv or a process list.
//
// Running these is backup-dumps' other half, in backup-run.ts. Keeping the strings pure is what lets the
// tests assert them exactly.

import type { ProjectEntry, ServiceEntry } from '../shared/registry.ts'

export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export type DumpPlan =
    // Run argv through docker exec in `service` and write its stdout to `file` under the staging directory.
    | { kind: 'exec', service: string, argv: string[], file: string }
    // The agent copies the sqlite file itself: sqlite3's own .backup is safe against a concurrent writer.
    | { kind: 'sqlite', service: string, source: string, file: string }
    // Stop the service, copy its bind-mounted data, start it again. Briefly disruptive, and the record says so.
    | { kind: 'generic', service: string, file: string }

export type PlanProblem = { problem: string }

const named = (service: string, override: string | undefined, fallback: string): string | PlanProblem => {
    if (override === undefined) return fallback
    return ENV_NAME_PATTERN.test(override) ? override : { problem: `${service}: dump.userEnv is not an environment variable name` }
}

const passwordNamed = (service: string, override: string | undefined, fallback: string): string | PlanProblem => {
    if (override === undefined) return fallback
    return ENV_NAME_PATTERN.test(override) ? override : { problem: `${service}: dump.passwordEnv is not an environment variable name` }
}

const isProblem = (value: unknown): value is PlanProblem => typeof value === 'object' && value !== null && 'problem' in value

export function dumpPlan(service: string, entry: ServiceEntry): DumpPlan | PlanProblem | null {
    if (entry.role !== 'database') return null
    if (entry.engine === 'sqlite') return { kind: 'sqlite', service, source: entry.file, file: 'dump.db' }

    const exec = (argv: string[], file: string): DumpPlan => ({ kind: 'exec', service, argv, file })

    switch (entry.engine) {
        case 'postgres': {
            const user = named(service, entry.dump.userEnv, 'POSTGRES_USER')
            if (isProblem(user)) return user
            return exec(['sh', '-c', `pg_dumpall -U "$${user}"`], 'dump.sql')
        }
        case 'mysql':
        case 'mariadb': {
            const command = entry.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump'
            const defaultPassword = entry.engine === 'mysql' ? 'MYSQL_ROOT_PASSWORD' : 'MARIADB_ROOT_PASSWORD'
            const password = passwordNamed(service, entry.dump.passwordEnv, defaultPassword)
            if (isProblem(password)) return password
            // --all-databases needs a superuser, which in both images is root unless the registry says
            // otherwise. MYSQL_PWD rather than -p, so the password never appears in the container's process
            // list; mariadb-dump reads the same variable.
            const user = entry.dump.userEnv === undefined ? 'root' : named(service, entry.dump.userEnv, 'root')
            if (isProblem(user)) return user
            const userArg = entry.dump.userEnv === undefined ? '-u root' : `-u "$${user}"`
            return exec(['sh', '-c', `MYSQL_PWD="$${password}" ${command} --all-databases --single-transaction --routines --events ${userArg}`], 'dump.sql')
        }
        case 'mongodb': {
            const user = named(service, entry.dump.userEnv, 'MONGO_INITDB_ROOT_USERNAME')
            if (isProblem(user)) return user
            const password = passwordNamed(service, entry.dump.passwordEnv, 'MONGO_INITDB_ROOT_PASSWORD')
            if (isProblem(password)) return password
            // ${VAR:+...} expands to the credentials only when the image sets them, so an unauthenticated
            // development mongo and a credentialed production one both dump with one command string.
            return exec(['sh', '-c', `mongodump --archive --gzip \${${user}:+-u "$${user}" -p "$${password}" --authenticationDatabase admin}`], 'dump.archive.gz')
        }
        case 'redis':
            // --rdb writes to a file rather than stdout, so it goes to the container's own /tmp and is then
            // streamed out and removed. The rm runs even if cat fails, hence ';' rather than '&&'.
            return exec(['sh', '-c', 'redis-cli --rdb /tmp/hostd-dump.rdb >/dev/null && cat /tmp/hostd-dump.rdb; rm -f /tmp/hostd-dump.rdb'], 'dump.rdb')
        case 'generic':
            return { kind: 'generic', service, file: 'data' }
    }
}

export function dumpPlans(project: ProjectEntry): { ok: true, plans: DumpPlan[] } | { ok: false, problem: string } {
    const plans: DumpPlan[] = []
    for (const [service, entry] of Object.entries(project.services)) {
        const plan = dumpPlan(service, entry)
        if (plan === null) continue
        if (isProblem(plan)) return { ok: false, problem: plan.problem }
        plans.push(plan)
    }
    return { ok: true, plans }
}
