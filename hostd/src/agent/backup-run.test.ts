import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import { runBackup, type BackupDeps, type BackupFs } from './backup-run.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Restic } from './restic.ts'

const YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      media: { path: uploads, mode: rw }
`

const project = () => parseRegistry(YAML).projects.get('acme')!

function setup(over: Partial<BackupDeps> = {}) {
    const written = new Map<string, string>()
    const removed: string[] = []
    const made: string[] = []
    const fs: BackupFs = {
        mkdir: async dir => { made.push(dir) },
        writeStream: path => {
            const sink = new PassThrough()
            let text = ''
            sink.on('data', (chunk: Buffer) => { text += chunk.toString() })
            const done = new Promise<void>(resolve => sink.on('finish', () => { written.set(path, text); resolve() }))
            return { sink, done }
        },
        remove: async path => { removed.push(path) },
        copy: async (from, to) => { written.set(to, `copy of ${from}`) },
        exists: async () => true,
        realpath: async path => path,
    }
    const backups: Array<{ paths: string[], tag: string }> = []
    const restic: Restic = {
        init: async () => ({ ok: true }),
        backup: async (_repo, paths, tag) => {
            backups.push({ paths, tag })
            return { ok: true, snapshot: 'deadbeef', sizeBytes: 100 }
        },
        snapshots: async () => ({ ok: true, snapshots: [] }),
        forget: async () => ({ ok: true }),
        retention: async () => ({ ok: true }),
        prune: async () => ({ ok: true }),
        dump: () => { throw new Error('not used') },
    }
    const execs: Array<{ id: string, argv: string[] }> = []
    const deps: BackupDeps = {
        backupDir: '/backups',
        restic,
        docker: {
            ping: async () => true,
            listProjectContainers: async () => [{ Id: 'c'.repeat(64), State: 'running', Labels: { 'com.docker.compose.service': 'db' } }],
            listAllContainers: async () => [],
            inspect: async () => { throw new Error('not used') },
            logs: async () => { throw new Error('not used') },
            exec: async (id, argv, onStdout) => {
                execs.push({ id, argv })
                await onStdout(Buffer.from('CREATE TABLE one;'))
                return { exitCode: 0, stderr: '' }
            },
        },
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        fs,
        disk: async () => ({ path: '/backups', totalBytes: 1000, usedBytes: 500, freeBytes: 500 }),
        now: () => Date.parse('2026-09-21T02:00:00.000Z'),
        log: () => {},
        ...over,
    }
    return { deps, written, removed, made, backups, execs }
}

describe('runBackup', () => {
    it('dumps the database into staging, captures staging and storage, and records the snapshot', async () => {
        const { deps, written, backups, execs, removed } = setup()
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)

        assert.equal(record.outcome, 'ok')
        assert.equal(record.snapshot, 'deadbeef')
        assert.equal(record.disruptive, false)
        assert.equal(written.get('/backups/.staging/acme/run1/db/db/dump.sql'), 'CREATE TABLE one;')
        assert.deepEqual(execs[0]?.argv, ['sh', '-c', 'pg_dumpall -U "$POSTGRES_USER"'])
        assert.deepEqual(backups, [{ paths: ['/backups/.staging/acme/run1', '/var/www/acme/uploads'], tag: 'manual' }])
        assert.ok(removed.includes('/backups/.staging/acme/run1'), 'staging is always cleared')
    })

    it('refuses before touching anything when the disk is nearly full', async () => {
        const { deps, execs } = setup({ disk: async () => ({ path: '/backups', totalBytes: 1000, usedBytes: 950, freeBytes: 50 }) })
        const record = await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /10% free/)
        assert.equal(execs.length, 0)
    })

    it('fails the whole run when a dump fails, and records no snapshot', async () => {
        const { deps, backups } = setup()
        deps.docker.exec = async () => ({ exitCode: 1, stderr: 'could not connect to server' })
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.snapshot, null)
        assert.match(record.reason ?? '', /could not connect to server/)
        assert.deepEqual(backups, [], 'nothing is captured when a dump failed')
    })

    it('fails the run rather than waiting forever when the staging disk fills up mid-dump', { timeout: 5000 }, async () => {
        const { deps, backups, removed } = setup()
        deps.fs.writeStream = () => {
            // The first write is taken but not flushed, and fails as a real one does, so drain never comes
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
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /ENOSPC/)
        assert.deepEqual(backups, [])
        assert.ok(removed.includes('/backups/.staging/acme/run1'), 'staging is still cleared')
    })

    it('applies the client retention after a scheduled run only', async () => {
        const retentions: unknown[] = []
        const { deps } = setup()
        deps.restic.retention = async (_repo, keep) => { retentions.push(keep); return { ok: true } }
        await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [])
        await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run2', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [{ daily: 7, weekly: 4, monthly: 3 }])
    })

    it('clamps a scheduled run\'s retention to the project\'s own registry ceiling, not whatever api sent', async () => {
        const retentions: unknown[] = []
        const { deps } = setup()
        deps.restic.retention = async (_repo, keep) => { retentions.push(keep); return { ok: true } }
        // The fixture project sets no backups.maxKeep, so it falls back to the registry default of
        // { daily: 14, weekly: 8, monthly: 12 }; every figure here is asked above that ceiling.
        await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run1', keep: { daily: 30, weekly: 20, monthly: 20 } }, deps)
        assert.deepEqual(retentions, [{ daily: 14, weekly: 8, monthly: 12 }])
    })

    it('marks a generic dump disruptive and puts the service back up', async () => {
        const commands: string[][] = []
        const { deps } = setup({ runner: async (command, args) => { commands.push([command, ...args]); return { exitCode: 0, stdout: '{"name":"acme","services":{"db":{"volumes":[{"type":"bind","source":"/var/www/acme/dbdata"}]}}}', stderr: '', timedOut: false } } })
        const generic = parseRegistry(YAML.replace('engine: postgres', 'engine: generic')).projects.get('acme')!
        const record = await runBackup(generic, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok')
        assert.equal(record.disruptive, true)
        const joined = commands.map(command => command.join(' '))
        assert.ok(joined.some(line => line.includes('stop db')), 'the service is stopped')
        assert.ok(joined.some(line => line.includes('start db')), 'and started again')
    })

    it('creates the repository when it does not already exist, and the run still succeeds', async () => {
        const { deps } = setup()
        const inits: string[] = []
        deps.fs.exists = async () => false
        deps.restic.init = async repo => { inits.push(repo); return { ok: true } }
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok')
        assert.deepEqual(inits, ['/backups/acme'])
    })

    it('fails the run and never calls restic backup when restic init fails', async () => {
        const { deps, backups } = setup()
        deps.fs.exists = async () => false
        deps.restic.init = async () => ({ ok: false, reason: 'restic init exited with code 1', output: 'no such directory' })
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /restic init exited with code 1/)
        assert.deepEqual(backups, [])
    })
})

describe('runBackup and symlinks in the site\'s checkout', () => {
    // Symlinks: a path, and the path it resolves to, as realpath answers
    const linked = (links: Record<string, string>) => async (path: string) => {
        for (const [link, to] of Object.entries(links)) if (path === link || path.startsWith(`${link}/`)) return to + path.slice(link.length)
        return path
    }
    const SQLITE = YAML.replace('db: { role: database, engine: postgres }', 'db: { role: database, engine: sqlite, file: data/app.db }')
    const GENERIC = YAML.replace('engine: postgres', 'engine: generic')
    const bindTo = (source: string, commands: string[][]) => async (command: string, args: string[]) => {
        commands.push([command, ...args])
        return { exitCode: 0, stdout: JSON.stringify({ name: 'acme', services: { db: { volumes: [{ type: 'bind', source }] } } }), stderr: '', timedOut: false }
    }

    it('refuses to read a sqlite file through a symlink out of live\'s folder, and says so', async () => {
        const commands: string[][] = []
        const { deps, backups } = setup({ runner: async (command, args) => { commands.push([command, ...args]); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } })
        deps.fs.realpath = linked({ '/var/www/acme/data': '/var/www/other/data' })
        const record = await runBackup(parseRegistry(SQLITE).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.reason, 'db: data/app.db resolves outside live\'s folder (to /var/www/other/data/app.db), so the backup will not read it')
        assert.deepEqual(commands.filter(([command]) => command === 'sqlite3'), [])
        assert.deepEqual(backups, [])
    })

    it('reads a sqlite file at its resolved path when a symlink keeps it inside live\'s folder', async () => {
        const commands: string[][] = []
        const { deps } = setup({ runner: async (command, args) => { commands.push([command, ...args]); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } })
        deps.fs.realpath = linked({ '/var/www/acme/data': '/var/www/acme/var/data' })
        const record = await runBackup(parseRegistry(SQLITE).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        assert.deepEqual(commands.find(([command]) => command === 'sqlite3')?.[1], '/var/www/acme/var/data/app.db')
    })

    it('refuses a generic bind mount under /var/www that resolves into another site, before stopping anything', async () => {
        const commands: string[][] = []
        const { deps, written, backups } = setup({ runner: bindTo('/var/www/acme/dbdata', commands) })
        deps.fs.realpath = linked({ '/var/www/acme/dbdata': '/var/www/other/live/dbdata' })
        const record = await runBackup(parseRegistry(GENERIC).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.reason, 'db: its bind mount /var/www/acme/dbdata resolves outside the site\'s folder /var/www/acme (to /var/www/other/live/dbdata), so the backup will not read it')
        assert.equal(commands.some(command => command.includes('stop')), false, 'the service is never stopped')
        assert.equal([...written.keys()].some(path => path.includes('dbdata')), false)
        assert.deepEqual(backups, [])
    })

    it('refuses a generic bind mount outside /var/www that resolves into it', async () => {
        const commands: string[][] = []
        const { deps } = setup({ runner: bindTo('/srv/escape', commands) })
        deps.fs.realpath = linked({ '/srv/escape': '/var/www/other/live/dbdata' })
        const record = await runBackup(parseRegistry(GENERIC).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /resolves outside the site's folder/)
    })

    it('leaves a generic bind mount outside /var/www alone', async () => {
        const commands: string[][] = []
        const { deps, written } = setup({ runner: bindTo('/srv/dbdata', commands) })
        deps.fs.realpath = linked({})
        const record = await runBackup(parseRegistry(GENERIC).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        assert.ok([...written.values()].includes('copy of /srv/dbdata'))
    })

    it('refuses a storage folder whose parent is a symlink out of live\'s folder, before dumping anything', async () => {
        const { deps, backups, execs } = setup()
        deps.fs.realpath = linked({ '/var/www/acme/public': '/var/www/other/live/public' })
        const nested = YAML.replace('path: uploads', 'path: public/uploads')
        const record = await runBackup(parseRegistry(nested).projects.get('acme')!, { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.reason, 'storage public/uploads resolves outside live\'s folder (through /var/www/acme/public, to /var/www/other/live/public), so the backup will not read it')
        assert.deepEqual(execs, [])
        assert.deepEqual(backups, [])
    })

    it('hands restic a storage folder that is itself a symlink as it is, which restic stores as a link', async () => {
        const { deps, backups } = setup()
        deps.fs.realpath = linked({ '/var/www/acme/uploads': '/var/www/other/live/uploads' })
        const record = await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: null }, deps)
        assert.equal(record.outcome, 'ok', JSON.stringify(record))
        assert.deepEqual(backups[0]?.paths, ['/backups/.staging/acme/run1', '/var/www/acme/uploads'])
    })
})
