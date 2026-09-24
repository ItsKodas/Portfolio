import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { loadPlan, postgresLoadErrors, renameDatabaseLine, renameStream } from './copy-plans.ts'

describe('renameDatabaseLine (postgres)', () => {
    const pg = (line: string) => renameDatabaseLine('postgres', line, 'acme', 'acme-uat1')

    it('rewrites CREATE DATABASE, bare and quoted', () => {
        assert.equal(
            pg("CREATE DATABASE acme WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';"),
            "CREATE DATABASE \"acme-uat1\" WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';",
        )
        assert.equal(pg('CREATE DATABASE "acme" WITH TEMPLATE = template0;'), 'CREATE DATABASE "acme-uat1" WITH TEMPLATE = template0;')
    })

    it('rewrites the database of ALTER DATABASE, and never its owner', () => {
        assert.equal(pg('ALTER DATABASE acme OWNER TO acme;'), 'ALTER DATABASE "acme-uat1" OWNER TO acme;')
        assert.equal(pg('ALTER DATABASE "acme" SET search_path TO public;'), 'ALTER DATABASE "acme-uat1" SET search_path TO public;')
    })

    it('rewrites COMMENT ON DATABASE, bare and quoted', () => {
        assert.equal(pg("COMMENT ON DATABASE acme IS 'acme';"), "COMMENT ON DATABASE \"acme-uat1\" IS 'acme';")
        assert.equal(pg("COMMENT ON DATABASE \"acme\" IS 'x';"), "COMMENT ON DATABASE \"acme-uat1\" IS 'x';")
    })

    it('rewrites \\connect in every form pg_dumpall writes', () => {
        assert.equal(pg('\\connect acme'), '\\connect "acme-uat1"')
        assert.equal(pg('\\connect "acme"'), '\\connect "acme-uat1"')
        assert.equal(
            renameDatabaseLine('postgres', "\\connect -reuse-previous=on \"dbname='acme-co'\"", 'acme-co', 'acme-co-uat1'),
            '\\connect "acme-co-uat1"',
        )
        assert.equal(
            renameDatabaseLine('postgres', 'CREATE DATABASE "acme-co" WITH TEMPLATE = template0;', 'acme-co', 'acme-co-uat1'),
            'CREATE DATABASE "acme-co-uat1" WITH TEMPLATE = template0;',
        )
    })

    it('leaves other databases alone, even ones whose names start with the id', () => {
        for (const line of [
            'CREATE DATABASE acmeold WITH TEMPLATE = template0;',
            'CREATE DATABASE acme_x WITH TEMPLATE = template0;',
            'CREATE DATABASE "acme-live" WITH TEMPLATE = template0;',
            'ALTER DATABASE acmeold OWNER TO acme;',
            '\\connect acmeold',
            '\\connect "acme-live"',
            "\\connect -reuse-previous=on \"dbname='acme-live'\"",
            'CREATE DATABASE other WITH TEMPLATE = template0;',
        ]) assert.equal(pg(line), line, line)
    })

    it('never touches data or other statements that mention the id', () => {
        for (const line of [
            "INSERT INTO public.sites VALUES (1, 'acme', 'CREATE DATABASE acme');",
            '1\tacme\tCREATE DATABASE acme',
            'CREATE ROLE acme;',
            'ALTER ROLE acme WITH NOSUPERUSER LOGIN;',
            'GRANT ALL ON SCHEMA public TO acme;',
            '-- Database "acme" dump',
        ]) assert.equal(pg(line), line, line)
    })
})

describe('renameDatabaseLine (mysql and mariadb)', () => {
    it('rewrites CREATE DATABASE in the mysqldump form and plain', () => {
        for (const engine of ['mysql', 'mariadb'] as const) {
            assert.equal(
                renameDatabaseLine(engine, 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acme` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;', 'acme', 'acme-uat1'),
                'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acme-uat1` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
            )
            assert.equal(renameDatabaseLine(engine, 'CREATE DATABASE `acme`;', 'acme', 'acme-uat1'), 'CREATE DATABASE `acme-uat1`;')
            assert.equal(renameDatabaseLine(engine, 'CREATE DATABASE IF NOT EXISTS `acme`;', 'acme', 'acme-uat1'), 'CREATE DATABASE IF NOT EXISTS `acme-uat1`;')
        }
    })

    it('rewrites USE', () => {
        assert.equal(renameDatabaseLine('mysql', 'USE `acme`;', 'acme', 'acme-uat1'), 'USE `acme-uat1`;')
    })

    it('leaves other databases, data and comments alone', () => {
        for (const line of [
            'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acmeold` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
            'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acme_x`;',
            'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acme-live`;',
            'USE `acmeold`;',
            'USE `mysql`;',
            "INSERT INTO `sites` VALUES (1,'acme','USE `acme`;');",
            '-- Current Database: `acme`',
            'CREATE DATABASE acme;',
        ]) assert.equal(renameDatabaseLine('mysql', line, 'acme', 'acme-uat1'), line, line)
    })
})

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
}

const through = (engine: 'postgres' | 'mysql', chunks: Array<string | Buffer>) =>
    collect(Readable.from(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).pipe(renameStream(engine, 'acme', 'acme-uat1')))

describe('renameStream', () => {
    it('rewrites a statement split across two chunks', async () => {
        const out = await through('postgres', ['SET x = 1;\nCREATE DATA', 'BASE acme WITH TEMPLATE = template0;\n\\connect acme\n'])
        assert.equal(out.toString(), 'SET x = 1;\nCREATE DATABASE "acme-uat1" WITH TEMPLATE = template0;\n\\connect "acme-uat1"\n')
    })

    it('keeps CRLF endings and a last line with no newline', async () => {
        const out = await through('mysql', ['USE `acme`;\r\nSELECT 1;\r\nUSE `acme`;'])
        assert.equal(out.toString(), 'USE `acme-uat1`;\r\nSELECT 1;\r\nUSE `acme-uat1`;')
    })

    it('never rewrites inside a postgres COPY block', async () => {
        const dump = [
            'COPY public.notes (id, body) FROM stdin;',
            '1\tCREATE DATABASE acme WITH TEMPLATE = template0;',
            'CREATE DATABASE acme WITH TEMPLATE = template0;',
            '\\.',
            'ALTER DATABASE acme OWNER TO acme;',
            '',
        ].join('\n')
        const out = await through('postgres', [dump])
        assert.equal(out.toString(), dump.replace('ALTER DATABASE acme', 'ALTER DATABASE "acme-uat1"'))
    })

    it('passes bytes that are not UTF-8 through untouched', async () => {
        const binary = Buffer.from([0x49, 0x4e, 0x53, 0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3, 0x28, 0x0a])
        const long = Buffer.concat([Buffer.from("INSERT INTO `t` VALUES ('"), Buffer.alloc(200_000, 0xff), Buffer.from("');\n")])
        const out = await through('mysql', [binary, long.subarray(0, 100), long.subarray(100), 'USE `acme`;\n'])
        assert.deepEqual(out, Buffer.concat([binary, long, Buffer.from('USE `acme-uat1`;\n')]))
    })
})

describe('loadPlan', () => {
    it('drops the environment database, then feeds pg_dumpall output to psql', () => {
        assert.deepEqual(loadPlan('db', { role: 'database', engine: 'postgres', dump: {} }, 'acme', 'acme-uat1'), {
            kind: 'exec', service: 'db',
            before: ['sh', '-c', 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \\"acme-uat1\\" WITH (FORCE)"'],
            argv: ['sh', '-c', 'psql -U "$POSTGRES_USER" -d postgres'],
            rename: true, errorFilter: 'postgres',
        })
        const custom = loadPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'PGUSER' } }, 'acme', 'acme-uat1')
        assert.ok(custom && 'argv' in custom && custom.argv[2] === 'psql -U "$PGUSER" -d postgres')
    })

    it('uses the dump\'s mysql and mariadb credentials, through MYSQL_PWD', () => {
        assert.deepEqual(loadPlan('db', { role: 'database', engine: 'mysql', dump: {} }, 'acme', 'acme-uat1'), {
            kind: 'exec', service: 'db',
            before: ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root -e \'DROP DATABASE IF EXISTS `acme-uat1`\''],
            argv: ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root'],
            rename: true, errorFilter: null,
        })
        assert.deepEqual(loadPlan('db', { role: 'database', engine: 'mariadb', dump: { userEnv: 'DB_USER', passwordEnv: 'DB_PASS' } }, 'acme', 'acme-uat1'), {
            kind: 'exec', service: 'db',
            before: ['sh', '-c', 'MYSQL_PWD="$DB_PASS" mariadb -u "$DB_USER" -e \'DROP DATABASE IF EXISTS `acme-uat1`\''],
            argv: ['sh', '-c', 'MYSQL_PWD="$DB_PASS" mariadb -u "$DB_USER"'],
            rename: true, errorFilter: null,
        })
        const mariadb = loadPlan('db', { role: 'database', engine: 'mariadb', dump: {} }, 'acme', 'acme-uat1')
        assert.ok(mariadb && 'argv' in mariadb && mariadb.argv[2] === 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -u root')
    })

    it('restores mongodb under the new name with the dump\'s credentials', () => {
        assert.deepEqual(loadPlan('db', { role: 'database', engine: 'mongodb', dump: {} }, 'acme', 'acme-uat1'), {
            kind: 'exec', service: 'db', before: null,
            argv: ['sh', '-c', 'mongorestore --archive --gzip --drop --nsFrom "acme.*" --nsTo "acme-uat1.*" ${MONGO_INITDB_ROOT_USERNAME:+-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}'],
            rename: false, errorFilter: null,
        })
    })

    it('hands redis and sqlite to the run', () => {
        assert.deepEqual(loadPlan('cache', { role: 'database', engine: 'redis', dump: {} }, 'acme', 'acme-uat1'), { kind: 'redis', service: 'cache' })
        assert.deepEqual(loadPlan('lite', { role: 'database', engine: 'sqlite', file: 'data/app.db' }, 'acme', 'acme-uat1'), { kind: 'sqlite', service: 'lite', file: 'data/app.db' })
    })

    it('refuses the generic engine, naming the service', () => {
        assert.deepEqual(loadPlan('files', { role: 'database', engine: 'generic', dump: {} }, 'acme', 'acme-uat1'), {
            problem: 'files uses the generic engine, which cannot be copied while live runs; give it a real engine in the registry',
        })
    })

    it('has nothing to load for a site service', () => {
        assert.equal(loadPlan('web', { role: 'site' } as never, 'acme', 'acme-uat1'), null)
    })

    it('refuses a credential override that is not a variable name, like the dump does', () => {
        assert.deepEqual(loadPlan('db', { role: 'database', engine: 'postgres', dump: { userEnv: 'X"; rm -rf /; #' } }, 'acme', 'acme-uat1'), {
            problem: 'db: dump.userEnv is not an environment variable name',
        })
    })

    it('refuses database names that could break out of the command', () => {
        for (const [from, to] of [['acme', 'acme"; rm -rf /'], ['acme`x', 'acme-uat1'], ["acme'", 'acme-uat1']]) {
            const plan = loadPlan('db', { role: 'database', engine: 'mysql', dump: {} }, from!, to!)
            assert.ok(plan && 'problem' in plan, `${from} -> ${to}`)
        }
    })
})

describe('postgresLoadErrors', () => {
    it('keeps real errors and drops role and database "already exists"', () => {
        const stderr = [
            'psql:<stdin>:14: ERROR:  role "postgres" already exists',
            'psql:<stdin>:20: ERROR:  database "template1" already exists',
            'psql:<stdin>:88: ERROR:  relation "public.users" does not exist',
            'psql:<stdin>:90: NOTICE:  something',
            'psql:<stdin>:91: ERROR:  syntax error at or near "x"',
        ].join('\n')
        assert.deepEqual(postgresLoadErrors(stderr), [
            'psql:<stdin>:88: ERROR:  relation "public.users" does not exist',
            'psql:<stdin>:91: ERROR:  syntax error at or near "x"',
        ])
        assert.deepEqual(postgresLoadErrors(''), [])
    })
})
