import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
    dumpFolderOf, removeInterruptedRestoreStaging, restoreRefusal, runRestore, stagingOf, storageFolderOf,
    type RestoreDeps, type RestoreFs,
} from './restore-run.ts'
import type { ContainerSummary } from './docker.ts'
import type { Runner, RunResult } from './compose.ts'
import { parseRegistry, type ProjectEntry, type Registry } from '../shared/registry.ts'
import type { BackupRecord } from '../shared/backups.ts'
import type { RestoreRecord } from '../shared/protocol.ts'
import { loadPlan } from './copy-plans.ts'
import { mkdirArgv, renameArgv, type HelperMount, type IoHelper } from './io-helper.ts'

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
    capabilities: [backups]
    environments:
      live: { dir: /var/www/acme/live, branch: main, port: 5010 }
`
const registryOf = (yaml = YAML): Registry => parseRegistry(yaml)
const project = (yaml = YAML): ProjectEntry => {
    const registry = registryOf(yaml)
    const entry = registry.projects.get('acme')
    assert.ok(entry, JSON.stringify([...registry.invalid]))
    return entry
}

const RUN = 'abcdef012345'
const SNAPSHOT = '0123abcd'
const STAGING = `/var/www/acme/.restore/${RUN}`
const LIVE = '/var/www/acme/live'
const BACKUP_DIR = '/backups'
// The backup run's own staging folder, as the snapshot captured it
const DUMPS = `${BACKUP_DIR}/.staging/acme/feedface0001`
const GIB = 1024 ** 3
const POSTGRES_DUMP = 'CREATE DATABASE acme WITH OWNER = acme;\n\\connect acme\nCOPY public.notes (body) FROM stdin;\nhello\n\\.\n'

const PG_WIPE = (() => {
    const plan = loadPlan('db', { role: 'database', engine: 'postgres', dump: {} }, 'acme', 'acme')
    assert.ok(plan && 'before' in plan && plan.before)
    return plan.before.at(-1)!
})()
const PG_LOAD = 'psql -U "$POSTGRES_USER" -d postgres'

const safetyOk: BackupRecord = {
    run: 'safe00000001', tag: 'manual', actor: 'admin', startedAt: '2026-10-10T00:00:00.000Z', durationMs: 1000,
    outcome: 'ok', snapshot: 'fe11a5afe0000000000000000000000000000000000000000000000000000000', reason: null, disruptive: false,
}

type Options = {
    safety?: BackupRecord
    free?: number
    size?: number
    // What the snapshot captured; by default the dump folder and the storage folder
    snapshotPaths?: string[]
    // Dumps restic writes back out, by service; by default all three
    dumps?: string[]
    // Whether the snapshot's storage folder has anything in it once restored
    storageRestored?: boolean
    execFail?: (who: string, command: string) => boolean
    moveFail?: (from: string, to: string) => boolean
    links?: Record<string, string>
    restoreFail?: boolean
}

function setup(options: Options = {}) {
    const calls: string[] = []
    const loaded: Record<string, string> = {}
    const states: Record<string, string> = { web: 'running', worker: 'running', db: 'running', cache: 'running' }
    const paths = new Set<string>([LIVE, `${LIVE}/data/app.db`, `${LIVE}/data/app.db-wal`, `${LIVE}/storage/uploads/old.png`])
    const files = new Map<string, string>()
    const dirs = new Set<string>([LIVE, `${LIVE}/data`, `${LIVE}/storage`, `${LIVE}/storage/uploads`])
    const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
    const exists = (path: string) => [...paths, ...files.keys(), ...dirs].some(entry => under(entry, path))
    const links = new Map(Object.entries(options.links ?? {}))

    const id = (service: string) => service.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a')
    const whose = (container: string) => Object.keys(states).find(service => id(service) === container) ?? container

    const dockerApi: RestoreDeps['dockerApi'] = {
        listProjectContainers: async name => {
            calls.push(`list ${name}`)
            return Object.entries(states).map(([service, state]): ContainerSummary => ({
                Id: id(service), State: state, Labels: { 'com.docker.compose.service': service },
            }))
        },
        exec: async (container, argv, onStdout, stdin) => {
            const who = whose(container)
            const command = argv.at(-1)!
            calls.push(`exec ${who} ${command}`)
            if (stdin) {
                const chunks: Buffer[] = []
                for await (const chunk of stdin) chunks.push(chunk as Buffer)
                loaded[who] = Buffer.concat(chunks).toString('latin1')
            }
            if (options.execFail?.(who, command)) return { exitCode: 1, stderr: 'it failed' }
            if (who === 'cache' && command.includes('CONFIG GET dir')) await onStdout(Buffer.from('dir\n/data\n'))
            if (who === 'cache' && command.includes('CONFIG GET appendonly')) await onStdout(Buffer.from('appendonly\nno\n'))
            if (who === 'cache' && command.includes('CONFIG GET dbfilename')) await onStdout(Buffer.from('dbfilename\ndump.rdb\n'))
            return { exitCode: 0, stderr: '' }
        },
    }

    const runner: Runner = async (command, args) => {
        const ok: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (command === 'docker' && args[0] === 'compose') {
            const name = args[args.indexOf('--project-name') + 1]!
            const rest = args.slice(args.lastIndexOf('-f') + 2)
            calls.push(`compose ${name} ${rest.join(' ')}`)
            if (rest[0] === 'config') {
                return { ...ok, stdout: JSON.stringify({ name, services: { web: {}, worker: {}, db: {}, cache: {} } }) }
            }
            for (const service of rest.slice(1).filter(word => !word.startsWith('-') && word !== 'never')) {
                if (rest[0] === 'stop') states[service] = 'exited'
                if (rest[0] === 'up' || rest[0] === 'start') states[service] = 'running'
            }
            return ok
        }
        calls.push(`${command} ${args.map(arg => arg.replace(/^([0-9a-f]{64}):/, (_, container: string) => `${whose(container)}:`)).join(' ')}`)
        return ok
    }

    const move = (from: string, to: string) => {
        calls.push(`move ${from} -> ${to}`)
        if (options.moveFail?.(from, to)) throw new Error('it failed')
        if (!exists(from)) throw new Error(`ENOENT: ${from}`)
        for (const entry of [...paths]) if (under(entry, from)) { paths.delete(entry); paths.add(to + entry.slice(from.length)) }
        for (const [entry, text] of [...files]) if (under(entry, from)) { files.delete(entry); files.set(to + entry.slice(from.length), text) }
        for (const entry of [...dirs]) if (under(entry, from)) { dirs.delete(entry); dirs.add(to + entry.slice(from.length)) }
    }

    const helperRuns: Array<{ mounts: HelperMount[], argv: string[] }> = []
    const helper: IoHelper = async (mounts, argv) => {
        helperRuns.push({ mounts, argv })
        const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        for (const path of argv.slice(3)) {
            if (path.startsWith('/')) assert.ok(mounts.some(mount => under(path, mount.target)), `${path} is not in any mount of the helper`)
        }
        if (argv[2] === renameArgv('', '')[2]) {
            try {
                move(argv[3]!, argv[4]!)
                return ok
            } catch (error) {
                return { ...ok, exitCode: 1, stderr: (error as Error).message }
            }
        }
        if (argv[2] === mkdirArgv('', { uid: 0, gid: 0, mode: 0 })[2]) {
            calls.push(`mkdir ${argv[3]} in the helper`)
            dirs.add(argv[3]!)
            return ok
        }
        throw new Error(`the fake helper does not know ${JSON.stringify(argv)}`)
    }

    const fs: RestoreFs = {
        mkdir: async (dir, mkdirOptions) => { calls.push(`mkdir ${dir}${mkdirOptions?.private ? ' private' : ''}`); dirs.add(dir) },
        rmdir: async dir => {
            calls.push(`rmdir ${dir}`)
            for (const entry of [...paths]) if (under(entry, dir)) paths.delete(entry)
            for (const entry of [...files.keys()]) if (under(entry, dir)) files.delete(entry)
            for (const entry of [...dirs]) if (under(entry, dir)) dirs.delete(entry)
        },
        exists: async path => exists(path),
        lkind: async path => {
            if (links.has(path)) return 'link'
            if (!exists(path)) return 'none'
            return dirs.has(path) || [...paths, ...files.keys()].some(entry => entry !== path && under(entry, path)) ? 'dir' : 'file'
        },
        realpath: async path => {
            for (const [link, to] of links) if (under(path, link)) return to + path.slice(link.length)
            return path
        },
        owner: async () => ({ uid: 33, gid: 33, mode: 0o644 }),
        chown: async (path, uid, gid) => { calls.push(`chown ${path} ${uid}:${gid}`) },
        chmod: async (path, mode) => { calls.push(`chmod ${path} ${mode.toString(8)}`) },
        readStream: path => {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return Readable.from([Buffer.from(text, 'latin1')])
        },
        freeBytes: async () => options.free ?? 100 * GIB,
    }

    const snapshotPaths = options.snapshotPaths ?? [DUMPS, `${LIVE}/storage/uploads`]
    const restic: RestoreDeps['restic'] = {
        restoreSize: async (repo, snapshot) => {
            calls.push(`restic stats ${repo} ${snapshot}`)
            return { ok: true, bytes: options.size ?? GIB }
        },
        paths: async (repo, snapshot) => {
            calls.push(`restic paths ${repo} ${snapshot}`)
            return { ok: true, paths: snapshotPaths }
        },
        restore: async (repo, snapshot, target) => {
            calls.push(`restic restore ${repo} ${snapshot} ${target}`)
            if (options.restoreFail) return { ok: false, reason: 'restic restore exited with code 1', output: 'pack missing' }
            const dumps = options.dumps ?? ['db', 'cache', 'files']
            if (dumps.includes('db')) files.set(`${target}${DUMPS}/db/db/dump.sql`, POSTGRES_DUMP)
            if (dumps.includes('cache')) files.set(`${target}${DUMPS}/db/cache/dump.rdb`, 'REDIS0011 backed up')
            if (dumps.includes('files')) files.set(`${target}${DUMPS}/db/files/dump.db`, 'SQLite format 3')
            if (options.storageRestored ?? true) {
                for (const path of snapshotPaths.filter(path => path !== DUMPS)) paths.add(`${target}${path}/new.png`)
            }
            return { ok: true }
        },
    }

    const records: RestoreRecord[] = []
    const logged: string[] = []
    let clock = Date.parse('2026-10-10T00:00:00.000Z')
    const deps: RestoreDeps = {
        dockerApi, runner, fs, helper, restic, backupDir: BACKUP_DIR,
        store: {
            start: async record => { records.push(record) },
            finish: async record => { records.push(record) },
        },
        log: message => { logged.push(message) },
        now: () => { clock += 1000; return clock },
        sleep: async () => {},
    }
    const request = { snapshot: SNAPSHOT, run: RUN, actor: 'koda@horizons.gg', safety: Promise.resolve(options.safety ?? safetyOk) }
    return { deps, request, calls, loaded, states, files, paths, dirs, records, logged, helperRuns }
}

describe('restoreRefusal', () => {
    it('lets an ordinary nested project restore', () => {
        assert.equal(restoreRefusal(project()), null)
    })

    it('refuses a generic database, which it has no way to load', () => {
        const yaml = YAML.replace('cache: { role: database, engine: redis }', 'cache: { role: database, engine: generic }')
        assert.equal(restoreRefusal(project(yaml)), 'cache uses the generic engine, which a restore cannot load; put it back by hand')
    })

    it('refuses a flat site, which has nowhere outside the checkout to stage', () => {
        const yaml = YAML.replace('/var/www/acme/live', '/var/www/acme').replace('file: data/app.db', 'file: data/app.db')
        assert.match(restoreRefusal(project(yaml)) ?? '', /flat site/)
    })
})

describe('finding things in a snapshot', () => {
    it('finds the backup run\'s own staging folder among the paths it captured', () => {
        assert.equal(dumpFolderOf(['/var/www/acme/live/storage/uploads', DUMPS], BACKUP_DIR, 'acme'), DUMPS)
        assert.equal(dumpFolderOf(['/var/www/acme/live/storage/uploads'], BACKUP_DIR, 'acme'), null)
        // Another project's staging, or something that is not a run id, is not it
        assert.equal(dumpFolderOf([`${BACKUP_DIR}/.staging/other/feedface0001`, `${BACKUP_DIR}/.staging/acme/../x`], BACKUP_DIR, 'acme'), null)
    })

    it('finds a storage folder where the registry has it now, or where it was before the site was nested', () => {
        const storage = { path: 'storage/uploads', absolute: `${LIVE}/storage/uploads` }
        assert.equal(storageFolderOf([DUMPS, `${LIVE}/storage/uploads`], storage, '/var/www/acme'), `${LIVE}/storage/uploads`)
        assert.equal(storageFolderOf([DUMPS, '/var/www/acme/storage/uploads'], storage, '/var/www/acme'), '/var/www/acme/storage/uploads')
        assert.equal(storageFolderOf([DUMPS], storage, '/var/www/acme'), null)
        // Another site's folder of the same name is never taken for it
        assert.equal(storageFolderOf(['/var/www/other/live/storage/uploads'], storage, '/var/www/acme'), null)
    })
})

describe('runRestore', () => {
    it('takes the safety backup, unpacks the snapshot, loads every database, puts the files back and starts live again', async () => {
        const { deps, request, calls, loaded, states, files, paths, records } = setup()
        const record = await runRestore(project(), request, deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        assert.equal(record.step, null)
        assert.equal(record.safety, 'fe11a5af')
        assert.equal(record.snapshot, SNAPSHOT)
        assert.equal(record.environment, 'live')
        assert.equal(record.actor, 'koda@horizons.gg')

        // Every step said on the record as it began, in order
        assert.deepEqual(records.map(entry => entry.step), [
            'safety', 'space', 'extract', 'prepare', 'load:db', 'load:cache', 'sqlite:files', 'storage:storage/uploads', null,
        ])
        assert.deepEqual(records.at(-1), record)

        const index = (line: string) => {
            const found = calls.findIndex(call => call.startsWith(line))
            assert.ok(found >= 0, `${line} never happened:\n${calls.join('\n')}`)
            return found
        }
        // Nothing of live is touched until the snapshot is out and every dump found
        assert.ok(index(`restic restore /backups/acme ${SNAPSHOT} ${STAGING}`) < index('compose acme stop web worker'))
        // live's own database is wiped and loaded under its own name, with nothing renamed
        assert.ok(index(`exec db ${PG_WIPE}`) < calls.indexOf(`exec db ${PG_LOAD}`))
        assert.equal(loaded.db, POSTGRES_DUMP)
        // redis gets its rdb file while stopped
        assert.ok(index('compose acme stop cache') < index(`docker cp ${STAGING}${DUMPS}/db/cache/dump.rdb cache:/data/dump.rdb`))
        assert.ok(index('docker cp') < index('compose acme start cache'))
        // sqlite's copy is owned like live's file, live's file and its journal go aside, and the copy goes in
        index(`chown ${STAGING}${DUMPS}/db/files/dump.db 33:33`)
        index(`move ${LIVE}/data/app.db -> ${STAGING}/old/sqlite/files/app.db`)
        index(`move ${LIVE}/data/app.db-wal -> ${STAGING}/old/sqlite/files/app.db-wal`)
        index(`move ${STAGING}${DUMPS}/db/files/dump.db -> ${LIVE}/data/app.db`)
        // storage: live's folder aside, the backup's in its place
        index(`move ${LIVE}/storage/uploads -> ${STAGING}/old/storage/storage/uploads`)
        index(`move ${STAGING}${LIVE}/storage/uploads -> ${LIVE}/storage/uploads`)
        // live's services are started again, and staging goes last
        assert.ok(index('compose acme start web worker') < index(`rmdir ${STAGING}`))

        assert.equal(files.get(`${LIVE}/data/app.db`), 'SQLite format 3')
        assert.ok(paths.has(`${LIVE}/storage/uploads/new.png`))
        assert.ok(!paths.has(`${LIVE}/storage/uploads/old.png`))
        assert.deepEqual(states, { web: 'running', worker: 'running', db: 'running', cache: 'running' })
    })

    it('does every write into live in the helper, with only the site folder mounted', async () => {
        const { deps, request, helperRuns } = setup()
        await runRestore(project(), request, deps)
        assert.ok(helperRuns.length > 0)
        for (const run of helperRuns) assert.deepEqual(run.mounts, [{ source: '/var/www/acme', target: '/var/www/acme' }])
    })

    it('changes nothing when the safety backup did not work', async () => {
        const { deps, request, calls, records } = setup({ safety: { ...safetyOk, outcome: 'failed', snapshot: null, reason: 'the backup disk has less than 10% free' } })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'safety')
        assert.equal(record.safety, null)
        assert.equal(record.reason, 'the safety backup of live did not work, so nothing was restored: the backup disk has less than 10% free')
        assert.deepEqual(calls.filter(call => /^(compose|exec|move|restic)/.test(call)), [])
        assert.deepEqual(records.map(entry => entry.step), ['safety', 'safety'])
    })

    it('refuses to start without room for the snapshot', async () => {
        const { deps, request, calls } = setup({ free: 10 * GIB, size: 2 * GIB })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.step, 'space')
        assert.match(record.reason ?? '', /^only 10\.0 GiB is free under \/var\/www\/acme; a restore needs 10 GiB plus the size of the backup \(2\.0 GiB\)$/)
        assert.deepEqual(calls.filter(call => /^(compose|move|restic restore)/.test(call)), [])
    })

    it('fails before touching live when the backup has no dump of a database', async () => {
        const { deps, request, calls } = setup({ dumps: ['db', 'files'] })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.step, 'extract')
        assert.equal(record.reason, 'the backup holds no dump of cache: it was taken before cache was a registered database, so it cannot put it back')
        assert.deepEqual(calls.filter(call => /^(compose|exec|move)/.test(call)), [])
        assert.equal(calls.at(-1), `rmdir ${STAGING}`)
    })

    it('fails before touching live when restic cannot unpack the snapshot', async () => {
        const { deps, request, calls } = setup({ restoreFail: true })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.step, 'extract')
        assert.equal(record.reason, 'restic restore exited with code 1: pack missing')
        assert.deepEqual(calls.filter(call => /^(compose|exec|move)/.test(call)), [])
    })

    it('leaves a storage folder the backup does not hold as live has it', async () => {
        const { deps, request, calls, logged, paths } = setup({ snapshotPaths: [DUMPS] })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        assert.ok(!calls.some(call => call.startsWith(`move ${LIVE}/storage/uploads`)))
        assert.ok(paths.has(`${LIVE}/storage/uploads/old.png`))
        assert.ok(logged.includes('restore acme: the backup does not hold storage/uploads, so live\'s is left as it is'))
    })

    it('puts live\'s services back and names the safety backup when a load fails', async () => {
        const { deps, request, calls, states } = setup({ execFail: (who, command) => who === 'db' && command === PG_LOAD })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.step, 'load:db')
        assert.match(record.reason ?? '', /^db: the load exited with code 1: it failed Live may be partly restored; the safety backup fe11a5af holds it as it was before\.$/)
        assert.ok(calls.includes('compose acme start web worker'))
        assert.equal(calls.at(-1), `rmdir ${STAGING}`)
        assert.deepEqual(states, { web: 'running', worker: 'running', db: 'running', cache: 'running' })
    })

    it('puts live\'s storage folder back when the backup\'s cannot be moved in', async () => {
        const { deps, request, paths } = setup({ moveFail: from => from === `${STAGING}${LIVE}/storage/uploads` })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.step, 'storage:storage/uploads')
        assert.ok(paths.has(`${LIVE}/storage/uploads/old.png`))
    })

    it('refuses to write through a symlink in live that leads out of live', async () => {
        const { deps, request, calls } = setup({ links: { [`${LIVE}/storage`]: '/var/www/other/live/storage' } })
        const record = await runRestore(project(), request, deps)
        assert.equal(record.step, 'storage:storage/uploads')
        assert.match(record.reason ?? '', /resolves outside live's folder/)
        assert.ok(!calls.some(call => call.startsWith(`move ${STAGING}${LIVE}/storage/uploads`)))
    })
})

describe('staging', () => {
    it('stages only under the site\'s own .restore folder', () => {
        assert.equal(stagingOf(project(), RUN), STAGING)
        assert.equal(stagingOf(project(), '../../etc'), null)
    })

    it('removes what an interrupted restore staged, at boot', async () => {
        const removed: string[] = []
        const logged: string[] = []
        const record = { project: 'acme', run: RUN } as RestoreRecord
        await removeInterruptedRestoreStaging([record, { ...record, project: 'gone' }], registryOf(), { rmdir: async dir => { removed.push(dir) } }, message => logged.push(message))
        assert.deepEqual(removed, [STAGING])
        assert.equal(logged.length, 2)
        assert.match(logged[1]!, /^WARN restore gone/)
    })
})
