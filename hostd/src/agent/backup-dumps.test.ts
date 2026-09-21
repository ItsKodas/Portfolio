import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dumpPlan, dumpPlans } from './backup-dumps.ts'
import { parseRegistry } from '../shared/registry.ts'

const registry = (services: string) => parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services:
${services}
`)

describe('dumpPlan', () => {
    it('dumps postgres as the container\'s own superuser', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.sql',
            argv: ['sh', '-c', 'pg_dumpall -U "$POSTGRES_USER"'],
        })
    })

    it('honours a registry override of the variable name, never a value', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'PGUSER' } })
        assert.deepEqual(plan && 'argv' in plan && plan.argv, ['sh', '-c', 'pg_dumpall -U "$PGUSER"'])
    })

    it('refuses an override that is not an environment variable name', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'X"; rm -rf /; #' } })
        assert.deepEqual(plan, { problem: 'db: dump.userEnv is not an environment variable name' })
    })

    it('passes the mysql password through MYSQL_PWD so it never reaches a process list', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'mysql', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.sql',
            argv: ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --all-databases --single-transaction --routines --events -u root'],
        })
        const mariadb = dumpPlan('db', { role: 'database', engine: 'mariadb', dump: {} })
        assert.ok(mariadb && 'argv' in mariadb && mariadb.argv[2]!.startsWith('MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump'))
    })

    it('authenticates mongodump only when the image sets credentials', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'mongodb', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'db', file: 'dump.archive.gz',
            argv: ['sh', '-c', 'mongodump --archive --gzip ${MONGO_INITDB_ROOT_USERNAME:+-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}'],
        })
    })

    it('streams a redis rdb out through a temporary file inside the container, and keeps its exit status', () => {
        // The `s=$?; rm -f ...; exit $s` tail is what this assertion is really protecting. The exit status
        // of `A && B; C` is C's, and `rm -f` always succeeds, so without it a redis-cli that failed on
        // auth or is absent from the image exits 0 and the run is recorded as ok with an empty dump.rdb.
        const plan = dumpPlan('cache', { role: 'database', engine: 'redis', dump: {} })
        assert.deepEqual(plan, {
            kind: 'exec', service: 'cache', file: 'dump.rdb',
            argv: ['sh', '-c', 'redis-cli --rdb /tmp/hostd-dump.rdb >/dev/null && cat /tmp/hostd-dump.rdb; s=$?; rm -f /tmp/hostd-dump.rdb; exit $s'],
        })
    })

    it('copies a sqlite file with sqlite3 rather than reading it under a writer', () => {
        const plan = dumpPlan('app', { role: 'database', engine: 'sqlite', file: 'data/app.db' })
        assert.deepEqual(plan, { kind: 'sqlite', service: 'app', source: 'data/app.db', file: 'dump.db' })
    })

    it('falls back to stopping an unknown engine', () => {
        const plan = dumpPlan('db', { role: 'database', engine: 'generic', dump: {} })
        assert.deepEqual(plan, { kind: 'generic', service: 'db', file: 'data' })
    })

    it('has nothing to do for a site service', () => {
        assert.equal(dumpPlan('web', { role: 'site' }), null)
    })
})

describe('dumpPlans', () => {
    it('returns one plan per database service and no plan for the site', () => {
        const parsed = registry('      web: { role: site }\n      db: { role: database, engine: postgres }')
        const project = parsed.projects.get('acme')!
        const plans = dumpPlans(project)
        assert.equal(plans.ok, true)
        assert.deepEqual(plans.ok && plans.plans.map(plan => plan.service), ['db'])
    })
})
