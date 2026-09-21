import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

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

    it('applies the client retention after a scheduled run only', async () => {
        const retentions: unknown[] = []
        const { deps } = setup()
        deps.restic.retention = async (_repo, keep) => { retentions.push(keep); return { ok: true } }
        await runBackup(project(), { tag: 'manual', actor: 'client', run: 'run1', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [])
        await runBackup(project(), { tag: 'scheduled', actor: 'hostd', run: 'run2', keep: { daily: 7, weekly: 4, monthly: 3 } }, deps)
        assert.deepEqual(retentions, [{ daily: 7, weekly: 4, monthly: 3 }])
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
})
