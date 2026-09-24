import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable, Writable } from 'node:stream'

import { copyRefusal, removeInterruptedStaging, runCopy, stagingOf, COPY_MIN_FREE_BYTES, type CopyDeps, type CopyFs } from './copy-run.ts'
import type { ContainerSummary, DockerApi, ExecResult } from './docker.ts'
import type { Runner, RunResult } from './compose.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { CopyRecord } from '../shared/protocol.ts'
import { loadPlan } from './copy-plans.ts'

const YAML = `projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
      worker: { role: site }
      db: { role: database, engine: postgres }
      cache: { role: database, engine: redis }
      files: { role: database, engine: sqlite, file: data/app.db }
    storage: { uploads: { path: storage/uploads, mode: rw } }
    capabilities: [provision]
    environments:
      live: { dir: /var/www/acme/live, branch: main, port: 5010 }
      uat1: { dir: /var/www/acme/uat1, branch: develop, port: 5011 }
`
const project = (yaml = YAML): ProjectEntry => {
    const registry = parseRegistry(yaml)
    const entry = registry.projects.get('acme')
    assert.ok(entry, JSON.stringify([...registry.invalid]))
    return entry
}

const RUN = 'abcdef012345'
const STAGING = `/var/www/acme/.copy/${RUN}`
const LIVE = '/var/www/acme/live'
const ENV = '/var/www/acme/uat1'
const GIB = 1024 ** 3

// Every container of both compose projects, with a hex id each that says whose it is
const ids: Record<string, string> = {}
const idOf = (compose: string, service: string): string => {
    const key = `${compose}/${service}`
    ids[key] ??= (Object.keys(ids).length + 1).toString(16).padStart(64, '0')
    return ids[key]!
}
const whose = (id: string): string => Object.entries(ids).find(([, value]) => value === id)?.[0] ?? id

const POSTGRES_DUMP = [
    'CREATE ROLE acme;',
    'CREATE DATABASE acme WITH OWNER = acme;',
    '\\connect acme',
    'COPY public.notes (body) FROM stdin;',
    'CREATE DATABASE acme is only data here',
    '\\.',
    'CREATE DATABASE analytics WITH OWNER = acme;',
    '\\connect analytics',
    '',
].join('\n')
// The wipe the postgres load runs first, as copy-plans.ts builds it
const PG_WIPE = (() => {
    const plan = loadPlan('db', { role: 'database', engine: 'postgres', dump: {} }, 'acme', 'acme-uat1')
    assert.ok(plan && 'before' in plan && plan.before)
    return plan.before.at(-1)!
})()
const PG_LOAD = 'psql -U "$POSTGRES_USER" -d postgres'
const PG_READY = 'pg_isready -U "$POSTGRES_USER"'
const REDIS_READY = '[ "$(redis-cli ping)" = PONG ]'

type Options = {
    // compose name -> service -> container state
    states?: Record<string, Record<string, string>>
    execFail?: (who: string, argv: string[]) => ExecResult | null
    stderr?: (who: string, argv: string[]) => string
    runFail?: (command: string, args: string[]) => Partial<RunResult> | null
    free?: number
    sizes?: Record<string, number>
    paths?: string[]
    // Services that never reach running after an up
    neverStart?: string[]
    appendonly?: string
}

function setup(options: Options = {}) {
    const calls: string[] = []
    const loaded: Record<string, string> = {}
    const states: Record<string, Record<string, string>> = structuredClone(options.states ?? {
        acme: { web: 'running', worker: 'running', db: 'running', cache: 'running' },
        'acme-uat1': { web: 'running', worker: 'exited', db: 'exited', cache: 'running' },
    })
    const files = new Map<string, string>()
    // The environment's postgres server, as far as which databases it holds
    const databases = new Set(['postgres', 'template0', 'template1'])
    const paths = new Set(options.paths ?? [
        LIVE, ENV, `${LIVE}/data/app.db`, `${ENV}/data/app.db`, `${ENV}/data/app.db-wal`, `${LIVE}/storage/uploads`, `${ENV}/storage/uploads`,
    ])
    const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
    const exists = (path: string) => [...paths, ...files.keys()].some(entry => under(entry, path))

    const dockerApi: CopyDeps['dockerApi'] = {
        listProjectContainers: async name => {
            calls.push(`list ${name}`)
            return Object.entries(states[name] ?? {}).map(([service, state]): ContainerSummary => ({
                Id: idOf(name, service), State: state, Labels: { 'com.docker.compose.service': service },
            }))
        },
        exec: async (id, argv, onStdout, stdin, onStderr) => {
            const who = whose(id)
            calls.push(`exec ${who} ${argv.at(-1)}`)
            if (stdin) {
                const chunks: Buffer[] = []
                for await (const chunk of stdin) chunks.push(chunk as Buffer)
                loaded[who] = Buffer.concat(chunks).toString('latin1')
            }
            const failed = options.execFail?.(who, argv)
            if (failed) return failed
            const noise = options.stderr?.(who, argv)
            if (noise) onStderr?.(Buffer.from(noise))
            if (who === 'acme-uat1/db' && argv.at(-1)!.includes('pg_terminate_backend')) {
                for (const name of [...databases]) if (!['postgres', 'template0', 'template1'].includes(name)) databases.delete(name)
            }
            // What psql says about a dump that creates a database the server already has, and its tables
            if (who === 'acme-uat1/db' && stdin) {
                for (const line of loaded[who]!.split('\n')) {
                    const created = /^CREATE DATABASE "?([^" ;]+)"?[ ;].*;$/.exec(line)
                    if (!created) continue
                    if (databases.has(created[1]!)) onStderr?.(Buffer.from(`ERROR:  database "${created[1]}" already exists\nERROR:  relation "notes" already exists\n`))
                    databases.add(created[1]!)
                }
            }
            if (who === 'acme/db') await onStdout(Buffer.from(POSTGRES_DUMP))
            if (who === 'acme/cache') await onStdout(Buffer.from('REDIS0011 live cache'))
            if (who === 'acme-uat1/cache' && argv.at(-1)!.includes('CONFIG GET dir')) await onStdout(Buffer.from('dir\n/data\n'))
            if (who === 'acme-uat1/cache' && argv.at(-1)!.includes('CONFIG GET appendonly')) await onStdout(Buffer.from(`appendonly\n${options.appendonly ?? 'no'}\n`))
            return { exitCode: 0, stderr: '' }
        },
    }

    const runner: Runner = async (command, args) => {
        let line: string
        if (command === 'docker' && args[0] === 'compose') {
            const name = args[args.indexOf('--project-name') + 1]!
            const rest = args.slice(args.lastIndexOf('-f') + 2)
            line = `compose ${name} ${rest.join(' ')}`
            const services = rest.slice(1).filter(word => !word.startsWith('-') && word !== 'never')
            const failed = options.runFail?.(command, args)
            calls.push(line)
            if (failed) return { exitCode: 1, stdout: '', stderr: 'compose failed', timedOut: false, ...failed }
            for (const service of services) {
                if (rest[0] === 'stop') states[name]![service] = 'exited'
                if ((rest[0] === 'up' || rest[0] === 'start') && !options.neverStart?.includes(service)) states[name]![service] = 'running'
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        }
        line = `${command} ${args.map(arg => whose(arg.split(':')[0]!) === arg.split(':')[0] ? arg : `${whose(arg.split(':')[0]!)}:${arg.split(':')[1]}`).join(' ')}`
        calls.push(line)
        const failed = options.runFail?.(command, args)
        if (failed) return { exitCode: 1, stdout: '', stderr: 'it failed', timedOut: false, ...failed }
        if (command === 'sqlite3') paths.add(args[1]!.replace('.backup ', ''))
        if (command === 'cp') paths.add(args[2]!)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }

    const fs: CopyFs = {
        mkdir: async (dir, mkdirOptions) => { calls.push(`mkdir ${dir}${mkdirOptions?.private ? ' private' : ''}`); paths.add(dir) },
        move: async (from, to) => {
            calls.push(`move ${from} -> ${to}`)
            if (!exists(from)) throw new Error(`ENOENT: ${from}`)
            for (const entry of [...paths]) if (under(entry, from)) { paths.delete(entry); paths.add(to + entry.slice(from.length)) }
            for (const [entry, text] of [...files]) if (under(entry, from)) { files.delete(entry); files.set(to + entry.slice(from.length), text) }
        },
        rmdir: async dir => {
            calls.push(`rmdir ${dir}`)
            for (const entry of [...paths]) if (under(entry, dir)) paths.delete(entry)
            for (const entry of [...files.keys()]) if (under(entry, dir)) files.delete(entry)
        },
        exists: async path => exists(path),
        owner: async () => ({ uid: 33, gid: 33, mode: 0o755 }),
        own: async (dir, like) => { calls.push(`own ${dir} ${like.uid}`) },
        chown: async (path, uid, gid) => { calls.push(`chown ${path} ${uid}:${gid}`) },
        chmod: async (path, mode) => { calls.push(`chmod ${path} ${mode.toString(8)}`) },
        writeStream: path => {
            const sink = new PassThrough()
            const chunks: Buffer[] = []
            sink.on('data', chunk => chunks.push(chunk))
            const done = new Promise<void>(resolve => sink.on('end', () => { files.set(path, Buffer.concat(chunks).toString('latin1')); resolve() }))
            return { sink, done }
        },
        readStream: path => {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return Readable.from([Buffer.from(text, 'latin1')])
        },
        freeBytes: async () => options.free ?? 100 * GIB,
        sizeOf: async path => options.sizes?.[path] ?? 0,
    }

    const started: CopyRecord[] = []
    const finished: CopyRecord[] = []
    let clock = Date.parse('2026-09-25T10:00:00.000Z')
    const deps: CopyDeps = {
        dockerApi, runner, fs,
        store: {
            start: async record => { started.push(record) },
            finish: async record => { finished.push(record) },
        },
        log: () => {},
        now: () => { clock += 1000; return clock },
        sleep: async () => {},
    }
    return { deps, calls, loaded, states, files, paths, started, finished, databases }
}

const RESTORE = ['compose acme-uat1 start web', 'compose acme-uat1 stop db']

// A dump file on a disk that has just filled up: the first write is taken but not flushed, and fails as
// a real one does, so drain never comes
function fullDisk(): { sink: Writable, done: Promise<void> } {
    const sink = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
            setImmediate(() => callback(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })))
        },
    })
    const done = new Promise<void>((resolve, reject) => {
        sink.on('finish', resolve)
        sink.on('error', reject)
    })
    return { sink, done }
}

describe('runCopy', () => {
    it('copies every database and storage folder in the seven steps, in order', async () => {
        const { deps, calls, finished, started } = setup()
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        assert.deepEqual(calls, [
            // 1 and 2: the block is the agent's; the dump reads live only
            `mkdir ${STAGING} private`,
            'list acme',
            `mkdir ${STAGING}/db private`,
            'exec acme/db pg_dumpall -U "$POSTGRES_USER"',
            `mkdir ${STAGING}/cache private`,
            'exec acme/cache redis-cli --rdb /tmp/hostd-dump.rdb >/dev/null && cat /tmp/hostd-dump.rdb; s=$?; rm -f /tmp/hostd-dump.rdb; exit $s',
            // 3: prepare
            'list acme-uat1',
            'compose acme-uat1 stop web worker',
            'compose acme-uat1 up -d --no-build --pull never db',
            'list acme-uat1',
            // running is not ready
            `exec acme-uat1/db ${PG_READY}`,
            // 4: load, every database of the environment's server wiped first
            `exec acme-uat1/db ${PG_WIPE}`,
            `exec acme-uat1/db ${PG_LOAD}`,
            'exec acme-uat1/cache redis-cli CONFIG GET dir',
            'exec acme-uat1/cache redis-cli CONFIG GET appendonly',
            'compose acme-uat1 stop cache',
            `docker cp ${STAGING}/cache/dump.rdb acme-uat1/cache:/data/dump.rdb`,
            'compose acme-uat1 start cache',
            `exec acme-uat1/cache ${REDIS_READY}`,
            // 5: sqlite and storage, the sqlite file owned and moded like the one it replaces
            `sqlite3 ${LIVE}/data/app.db .backup ${ENV}/data/app.db.hostd-copy`,
            `chown ${ENV}/data/app.db.hostd-copy 33:33`,
            `chmod ${ENV}/data/app.db.hostd-copy 755`,
            `mkdir ${STAGING}/old/sqlite/files private`,
            `move ${ENV}/data/app.db -> ${STAGING}/old/sqlite/files/app.db`,
            `move ${ENV}/data/app.db-wal -> ${STAGING}/old/sqlite/files/app.db-wal`,
            `move ${ENV}/data/app.db.hostd-copy -> ${ENV}/data/app.db`,
            `cp -a ${LIVE}/storage/uploads ${ENV}/storage/uploads.hostd-copy`,
            `mkdir ${STAGING}/old/storage private`,
            `move ${ENV}/storage/uploads -> ${STAGING}/old/storage/uploads`,
            `move ${ENV}/storage/uploads.hostd-copy -> ${ENV}/storage/uploads`,
            `own ${ENV}/storage/uploads 33`,
            // 6: the environment as it was: web was running, the worker was not, db was started by the copy
            ...RESTORE,
            // 7
            `rmdir ${STAGING}`,
        ])
        assert.equal(started.length, 1)
        assert.deepEqual({ ...started[0], startedAt: undefined }, {
            project: 'acme', environment: 'uat1', run: RUN, actor: 'koda', startedAt: undefined, durationMs: 0,
            outcome: 'running', step: null, reason: null, services: ['db', 'cache', 'files'], storage: ['storage/uploads'],
        })
        assert.deepEqual(finished, [record])
        assert.equal(record.step, null)
        assert.equal(record.reason, null)
        assert.ok(record.durationMs > 0)
    })

    it('renames the database in the postgres stream only, and never a data line', async () => {
        const { deps, loaded } = setup()
        await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(loaded['acme-uat1/db'], [
            'CREATE ROLE acme;',
            'CREATE DATABASE "acme-uat1" WITH OWNER = acme;',
            '\\connect "acme-uat1"',
            'COPY public.notes (body) FROM stdin;',
            'CREATE DATABASE acme is only data here',
            '\\.',
            'CREATE DATABASE analytics WITH OWNER = acme;',
            '\\connect analytics',
            '',
        ].join('\n'))
        // redis is copied in as a file, never streamed through a rename
        assert.equal(loaded['acme-uat1/cache'], undefined)
    })

    it('leaves a never started environment stopped, and starts no site service', async () => {
        const { deps, calls, states } = setup({
            states: { acme: { web: 'running', db: 'running', cache: 'running' }, 'acme-uat1': {} },
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        assert.ok(calls.includes('compose acme-uat1 up -d --no-build --pull never db cache'))
        assert.equal(calls.filter(call => call.startsWith('compose acme-uat1 start web')).length, 0)
        assert.ok(calls.includes('compose acme-uat1 stop db cache'))
        assert.equal(states['acme-uat1']!.db, 'exited')
        assert.equal(states['acme-uat1']!.cache, 'exited')
        assert.equal(states['acme-uat1']!.web, 'exited')
    })

    it('never stops or writes anything of live', async () => {
        const { deps, calls } = setup()
        await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.deepEqual(calls.filter(call => call.startsWith('compose acme ')), [])
        assert.deepEqual(calls.filter(call => /^(move|rmdir|mkdir|own) \/var\/www\/acme\/live/.test(call)), [])
        assert.deepEqual(calls.filter(call => call.startsWith('exec acme/') && !/pg_dumpall|redis-cli --rdb/.test(call)), [])
    })

    it('fails at the dump, still puts nothing back it did not change, and removes staging', async () => {
        const { deps, calls, finished } = setup({
            execFail: (who, argv) => (who === 'acme/db' && argv.at(-1)!.includes('pg_dumpall') ? { exitCode: 1, stderr: 'connection refused' } : null),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'dump')
        assert.match(record.reason ?? '', /db: the dump exited with code 1: connection refused/)
        assert.equal(calls.filter(call => call.startsWith('compose')).length, 0)
        assert.equal(calls.at(-1), `rmdir ${STAGING}`)
        assert.deepEqual(finished, [record])
    })

    it('fails the dump rather than waiting forever when the staging disk fills up', { timeout: 5000 }, async () => {
        const { deps, calls, finished } = setup()
        deps.fs.writeStream = () => fullDisk()
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'dump')
        assert.match(record.reason ?? '', /ENOSPC/)
        assert.equal(calls.filter(call => call.startsWith('compose')).length, 0)
        assert.equal(calls.at(-1), `rmdir ${STAGING}`)
        assert.deepEqual(finished, [record])
    })

    it('fails a load, still restores the environment state and removes staging', async () => {
        const { deps, calls } = setup({
            stderr: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_LOAD
                ? 'psql:<stdin>:1: ERROR:  role "acme" already exists\npsql:<stdin>:9: ERROR:  relation "notes" does not exist\n'
                : ''),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'load:db')
        assert.match(record.reason ?? '', /relation "notes" does not exist/)
        assert.doesNotMatch(record.reason ?? '', /already exists/)
        assert.match(record.reason ?? '', /partly copied/)
        assert.deepEqual(calls.slice(-3), [...RESTORE, `rmdir ${STAGING}`])
        // Nothing after the failed load ran
        assert.equal(calls.some(call => call.startsWith('sqlite3') || call.startsWith('cp ')), false)
    })

    it('does not fail a postgres load on a role or database that already exists', async () => {
        const { deps } = setup({
            stderr: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_LOAD
                ? 'psql:<stdin>:1: ERROR:  role "acme" already exists\npsql:<stdin>:2: ERROR:  database "acme-uat1" already exists\n'
                : ''),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
    })

    it('fails a load whose command exits non-zero', async () => {
        const { deps } = setup({
            execFail: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_LOAD ? { exitCode: 2, stderr: 'FATAL: password authentication failed' } : null),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'load:db')
        assert.match(record.reason ?? '', /exited with code 2: FATAL: password authentication failed/)
    })

    it('starts a redis again when its load fails after stopping it', async () => {
        const { deps, calls, states } = setup({
            runFail: (command, args) => (command === 'docker' && args[0] === 'cp' ? { exitCode: 1 } : null),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'load:cache')
        assert.equal(states['acme-uat1']!.cache, 'running')
        assert.deepEqual(calls.slice(-3), ['compose acme-uat1 start web cache', 'compose acme-uat1 stop db', `rmdir ${STAGING}`])
    })

    it('fails at storage, still restores the environment state and removes staging', async () => {
        const { deps, calls, paths } = setup({
            runFail: command => (command === 'cp' ? { exitCode: 1, stderr: 'No space left on device' } : null),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'storage:storage/uploads')
        assert.match(record.reason ?? '', /No space left on device/)
        assert.deepEqual(calls.slice(-3), [...RESTORE, `rmdir ${STAGING}`])
        // The environment's own folder is where it was
        assert.ok(paths.has(`${ENV}/storage/uploads`))
    })

    it('fails the prepare step when a database does not come up, and stops what it started', async () => {
        const { deps, calls } = setup({ neverStart: ['db'] })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'prepare')
        assert.match(record.reason ?? '', /db did not start/)
        assert.deepEqual(calls.slice(-3), [...RESTORE, `rmdir ${STAGING}`])
    })

    it('records a failure to put the environment back', async () => {
        const { deps } = setup({
            runFail: (command, args) => (command === 'docker' && args.includes('start') && args.includes('web') ? { exitCode: 1 } : null),
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'restore-state')
        assert.match(record.reason ?? '', /web/)
    })

    it('records a staging folder that could not be removed', async () => {
        const { deps } = setup()
        deps.fs.rmdir = async () => { throw new Error('EBUSY') }
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'clean')
        assert.match(record.reason ?? '', /EBUSY/)
    })

    it('never deletes anything recursively when the run id would put staging somewhere else', async () => {
        const { deps, calls } = setup()
        const record = await runCopy(project(), 'uat1', '../../live', 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'dump')
        assert.deepEqual(calls.filter(call => call.startsWith('rmdir') || call.startsWith('mkdir')), [])
    })

    it('checks the disk first, and fails the run before anything is staged when it is short', async () => {
        const { deps, calls, finished } = setup({ free: 12 * GIB, sizes: { [`${LIVE}/storage/uploads`]: 5 * GIB } })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'space')
        assert.match(record.reason ?? '', /only 12\.0 GiB is free under \/var\/www\/acme; a copy needs 10 GiB plus the size of live's storage \(5\.0 GiB\)/)
        // Nothing staged; the clean step's removal of a folder that is not there is all that ran
        assert.deepEqual(calls, [`rmdir ${STAGING}`])
        assert.deepEqual(finished, [record])
        const enough = setup({ free: 15 * GIB, sizes: { [`${LIVE}/storage/uploads`]: 5 * GIB } })
        assert.equal((await runCopy(project(), 'uat1', RUN, 'koda', enough.deps)).outcome, 'ok')
    })

    it('loads cleanly a second time into an environment that already holds more than one database', async () => {
        const { deps, databases } = setup()
        const first = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(first.outcome, 'ok', JSON.stringify(first))
        assert.deepEqual([...databases].sort(), ['acme-uat1', 'analytics', 'postgres', 'template0', 'template1'])
        const second = await runCopy(project(), 'uat1', 'fedcba987654', 'koda', deps)
        assert.equal(second.outcome, 'ok', JSON.stringify(second))
    })

    it('fails a load whose server has databases left over when the wipe did not run', async () => {
        const { deps } = setup({ execFail: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_WIPE ? { exitCode: 0, stderr: '' } : null) })
        assert.equal((await runCopy(project(), 'uat1', RUN, 'koda', deps)).outcome, 'ok')
        // The same server, now skipping the wipe: its databases collide, which is what the wipe prevents
        const second = await runCopy(project(), 'uat1', 'fedcba987654', 'koda', deps)
        assert.equal(second.step, 'load:db')
        assert.match(second.reason ?? '', /relation "notes" already exists/)
    })

    it('fails a load when clearing the environment\'s databases fails', async () => {
        const { deps } = setup({ execFail: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_WIPE ? { exitCode: 1, stderr: 'permission denied' } : null) })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'load:db')
        assert.match(record.reason ?? '', /clearing the environment's databases exited with code 1: permission denied/)
    })

    it('waits for a database it started to be ready, and fails prepare when it never is', async () => {
        let asked = 0
        const ready = setup({ execFail: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_READY && ++asked < 3 ? { exitCode: 2, stderr: 'no response' } : null) })
        assert.equal((await runCopy(project(), 'uat1', RUN, 'koda', ready.deps)).outcome, 'ok')
        assert.equal(ready.calls.filter(call => call === `exec acme-uat1/db ${PG_READY}`).length, 3)

        const never = setup({ execFail: (who, argv) => (who === 'acme-uat1/db' && argv.at(-1) === PG_READY ? { exitCode: 2, stderr: 'no response' } : null) })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', never.deps)
        assert.equal(record.step, 'prepare')
        assert.match(record.reason ?? '', /db did not become ready in the environment within 60 seconds: no response/)
        assert.equal(never.calls.filter(call => call === `exec acme-uat1/db ${PG_READY}`).length, 30)
        assert.deepEqual(never.calls.slice(-3), [...RESTORE, `rmdir ${STAGING}`])
    })

    it('fails the redis load when redis runs with appendonly, touching nothing', async () => {
        const { deps, calls } = setup({ appendonly: 'yes' })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'load:cache')
        assert.match(record.reason ?? '', /^cache runs redis with appendonly, so replacing dump\.rdb would not take effect; copy it by hand/)
        assert.equal(calls.some(call => call.includes('stop cache') || call.startsWith('docker cp')), false)
    })

    it('fails the redis load when redis does not answer after its restart', async () => {
        const { deps } = setup({ execFail: (who, argv) => (who === 'acme-uat1/cache' && argv.at(-1) === REDIS_READY ? { exitCode: 1, stderr: '' } : null) })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'load:cache')
        assert.match(record.reason ?? '', /cache did not become ready/)
    })

    it('puts the environment\'s sqlite files back when the copy cannot be moved into place', async () => {
        const { deps, paths, calls } = setup()
        const move = deps.fs.move
        deps.fs.move = async (from, to) => {
            if (from === `${ENV}/data/app.db.hostd-copy`) throw new Error('EIO')
            return move(from, to)
        }
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.step, 'sqlite:files')
        assert.match(record.reason ?? '', /EIO/)
        assert.ok(paths.has(`${ENV}/data/app.db`))
        assert.ok(paths.has(`${ENV}/data/app.db-wal`))
        assert.ok(calls.includes(`move ${STAGING}/old/sqlite/files/app.db -> ${ENV}/data/app.db`))
        assert.equal(calls.at(-1), `rmdir ${STAGING}`)
    })

    it('moves a leftover copy of a storage folder into staging rather than copying into it', async () => {
        const { deps, calls } = setup({
            paths: [LIVE, ENV, `${LIVE}/data/app.db`, `${LIVE}/storage/uploads`, `${ENV}/storage/uploads.hostd-copy`],
        })
        const record = await runCopy(project(), 'uat1', RUN, 'koda', deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        const at = calls.indexOf(`move ${ENV}/storage/uploads.hostd-copy -> ${STAGING}/leftover/storage/uploads`)
        assert.ok(at !== -1 && at < calls.findIndex(call => call.startsWith('cp -a')), calls.join('\n'))
        // No folder of its own to set aside
        assert.equal(calls.some(call => call.includes(`${STAGING}/old/storage`)), false)
        // The folder the sqlite file goes in is made, and owned like the environment's tree
        const made = calls.indexOf(`mkdir ${ENV}/data`)
        assert.ok(made !== -1 && calls[made + 1] === `own ${ENV}/data 33`, calls.join('\n'))
    })
})

describe('copyRefusal', () => {
    const refusal = async (overrides: { yaml?: string, environment?: string } & Options = {}) => {
        const context = setup(overrides)
        const problem = await copyRefusal(project(overrides.yaml), overrides.environment ?? 'uat1', context.deps)
        return { problem, calls: context.calls }
    }
    const readsOnly = (calls: string[]) => assert.deepEqual(calls.filter(call => !call.startsWith('list ')), [])

    it('lets a copy start when nothing is in the way', async () => {
        const { problem, calls } = await refusal()
        assert.equal(problem, null)
        readsOnly(calls)
    })

    it('refuses to copy into live', async () => {
        const { problem, calls } = await refusal({ environment: 'live' })
        assert.match(problem ?? '', /never copied into/)
        readsOnly(calls)
    })

    it('refuses an environment the site does not have', async () => {
        const { problem } = await refusal({ environment: 'staging' })
        assert.equal(problem, 'acme has no staging environment')
    })

    it('refuses a generic database by name', async () => {
        const { problem, calls } = await refusal({ yaml: YAML.replace('cache: { role: database, engine: redis }', 'cache: { role: database, engine: generic }') })
        assert.equal(problem, 'cache uses the generic engine, which cannot be copied while live runs; give it a real engine in the registry')
        readsOnly(calls)
    })

    it('refuses a flat site', async () => {
        const flat = YAML.replace('/var/www/acme/live', '/var/www/acme').replace('/var/www/acme/uat1', '/var/www/acme-uat1')
        const { problem, calls } = await refusal({ yaml: flat })
        assert.match(problem ?? '', /flat/)
        readsOnly(calls)
    })

    it('refuses when a database has no running container in live', async () => {
        const { problem, calls } = await refusal({ states: { acme: { web: 'running', db: 'running', cache: 'exited' } } })
        assert.match(problem ?? '', /^cache has no running container in live/)
        readsOnly(calls)
    })

    it('leaves the disk to the run, so a start answers at once', async () => {
        assert.equal(COPY_MIN_FREE_BYTES, 10 * GIB)
        const { problem } = await refusal({ free: 0 })
        assert.equal(problem, null)
    })
})

describe('after an agent restart', () => {
    const interrupted = (overrides: Partial<CopyRecord>): CopyRecord => ({
        project: 'acme', environment: 'uat1', run: RUN, actor: 'koda', startedAt: '2026-09-25T10:00:00.000Z', durationMs: 1,
        outcome: 'failed', step: null, reason: 'the agent restarted during the copy', services: [], storage: [],
        ...overrides,
    })

    it('names the staging folder of a run, and nothing for a run id or environment that would put it elsewhere', () => {
        assert.equal(stagingOf(project(), 'uat1', RUN), STAGING)
        assert.equal(stagingOf(project(), 'uat1', '../x'), null)
        assert.equal(stagingOf(project(), 'staging', RUN), null)
    })

    it('removes the staging folder of each interrupted run, and says what it could not', async () => {
        const removed: string[] = []
        const logged: string[] = []
        const registry = parseRegistry(YAML)
        await removeInterruptedStaging(
            [interrupted({}), interrupted({ environment: 'gone' }), interrupted({ run: 'not-a-run' })],
            registry, { rmdir: async dir => { removed.push(dir) } }, message => logged.push(message),
        )
        assert.deepEqual(removed, [STAGING])
        assert.equal(logged.filter(line => line.startsWith('WARN')).length, 2)
    })
})
