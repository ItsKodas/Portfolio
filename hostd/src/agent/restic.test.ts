import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { backupArgv, createRestic, createResticRunner, dumpArgv, nodeSpawnStream, repoPath, RESTIC_ENV_KEYS, retentionArgv, snapshotsArgv, stagingPath, type SpawnStream } from './restic.ts'
import type { Runner, RunResult } from './compose.ts'
import { spawn as nodeSpawn } from 'node:child_process'

const REPO = '/backups/acme'

describe('argv builders', () => {
    it('puts the repository behind -r and never names a password', () => {
        assert.deepEqual(repoPath('/backups', 'acme'), '/backups/acme')
        assert.deepEqual(stagingPath('/backups', 'acme', 'run1'), '/backups/.staging/acme/run1')
        assert.deepEqual(backupArgv(REPO, ['/backups/.staging/acme/run1', '/var/www/acme/uploads'], 'manual'), [
            '-r', REPO, 'backup', '--json', '--tag', 'manual', '/backups/.staging/acme/run1', '/var/www/acme/uploads',
        ])
        assert.deepEqual(snapshotsArgv(REPO), ['-r', REPO, 'snapshots', '--json'])
        assert.deepEqual(dumpArgv(REPO, 'deadbeef'), ['-r', REPO, 'dump', '--archive', 'tar', 'deadbeef', '/'])
        assert.equal(backupArgv(REPO, [], 'manual').join(' ').includes('password'), false)
    })

    it('forgets scheduled snapshots only, by the client retention, in one group' , () => {
        // --group-by '' is asserted here on purpose: restic's default of host,paths puts every snapshot in
        // a group of its own, because each run's captured staging path carries that run's id, and a policy
        // applied per group of one forgets nothing at all.
        assert.deepEqual(retentionArgv(REPO, { daily: 7, weekly: 4, monthly: 3 }), [
            '-r', REPO, 'forget', '--tag', 'scheduled', '--group-by', '',
            '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '3',
        ])
    })
})

function setup(results: Record<string, Partial<RunResult>>) {
    const calls: Array<{ command: string, args: string[] }> = []
    const run: Runner = async (command, args) => {
        calls.push({ command, args })
        const key = args.find(arg => ['backup', 'snapshots', 'forget', 'prune', 'init'].includes(arg)) ?? ''
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results[key] ?? {}) }
    }
    return { run, calls }
}

describe('createRestic', () => {
    it('reads the snapshot id out of restic\'s own json summary', async () => {
        const summary = JSON.stringify({ message_type: 'summary', snapshot_id: 'deadbeefcafe', total_bytes_processed: 2048 })
        const { run } = setup({ backup: { stdout: `{"message_type":"status"}\n${summary}\n` } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/backups/.staging/acme/run1'], 'manual')
        assert.deepEqual(result, { ok: true, snapshot: 'deadbeefcafe', sizeBytes: 2048 })
    })

    it('returns a failure with the tail of stderr rather than throwing', async () => {
        const { run } = setup({ backup: { exitCode: 1, stderr: 'repository is locked' } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/staging'], 'scheduled')
        assert.deepEqual(result, { ok: false, reason: 'restic backup exited with code 1', output: 'repository is locked' })
    })

    it('parses snapshots into the portal shape, newest first', async () => {
        const stdout = JSON.stringify([
            { short_id: 'aaaa1111', time: '2026-09-20T02:00:00.000000+10:00', tags: ['scheduled'] },
            { short_id: 'bbbb2222', time: '2026-09-21T02:00:00.000000+10:00', tags: ['manual'] },
        ])
        const { run } = setup({ snapshots: { stdout } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.snapshots(REPO)
        assert.equal(result.ok, true)
        assert.deepEqual(result.ok && result.snapshots.map(s => s.id), ['bbbb2222', 'aaaa1111'])
        assert.equal(result.ok && result.snapshots[0]?.tag, 'manual')
    })

    it('streams a dump without buffering it', async () => {
        const stdout = new PassThrough()
        const spawnStream: SpawnStream = (command, args) => {
            assert.equal(command, 'restic')
            assert.ok(args.includes('dump'))
            queueMicrotask(() => stdout.end(Buffer.from('tar bytes')))
            return { stdout, exit: Promise.resolve({ exitCode: 0, stderr: '' }) }
        }
        const { run } = setup({})
        const restic = createRestic(run, spawnStream)
        const chunks: Buffer[] = []
        const stream = restic.dump(REPO, 'deadbeef')
        for await (const chunk of stream.stdout) chunks.push(chunk as Buffer)
        assert.equal(Buffer.concat(chunks).toString(), 'tar bytes')
    })

    it('finds the snapshot id when a progress line comes after the summary', async () => {
        const summary = JSON.stringify({ message_type: 'summary', snapshot_id: 'cafecafe', total_bytes_processed: 1024 })
        const progress = JSON.stringify({ message_type: 'status', percent_done: 1.0 })
        const { run } = setup({ backup: { stdout: `${summary}\n${progress}\n` } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/staging'], 'manual')
        assert.deepEqual(result, { ok: true, snapshot: 'cafecafe', sizeBytes: 1024 })
    })

    it('returns a failure when the summary line has no snapshot_id', async () => {
        const summary = JSON.stringify({ message_type: 'summary', total_bytes_processed: 1024 })
        const { run } = setup({ backup: { stdout: `{"message_type":"status"}\n${summary}\n` } })
        const restic = createRestic(run, (() => { throw new Error('not used') }) as unknown as SpawnStream)
        const result = await restic.backup(REPO, ['/staging'], 'manual')
        assert.equal(result.ok, false)
        assert.ok(result.ok || result.reason.includes('snapshot id'))
    })
})

describe('nodeSpawnStream environment', () => {
    it('passes restic a child environment that contains RESTIC_PASSWORD and omits docker-specific keys', async () => {
        const original = { ...process.env }
        try {
            process.env.PATH = '/usr/bin'
            process.env.HOME = '/root'
            process.env.TZ = 'UTC'
            process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
            process.env.DOCKER_CONFIG = '/root/.docker'
            process.env.RESTIC_PASSWORD = 'super-secret'

            const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
            const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
                calls.push({ command, args, options })
                const child = Object.assign(new EventEmitter(), {
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                })
                setImmediate(() => child.emit('close', 0))
                return child
            }) as unknown as typeof nodeSpawn

            const spawnStream = nodeSpawnStream(fakeSpawn)
            const handle = spawnStream('restic', ['dump', 'snapshot', '/'])
            await handle.exit

            assert.equal(calls[0]?.options.shell, undefined)
            assert.deepEqual(calls[0]?.options.env, {
                PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', RESTIC_PASSWORD: 'super-secret',
            })
        } finally {
            process.env = original
        }
    })

    it('omits RESTIC_PASSWORD when process.env does not set it', async () => {
        const original = { ...process.env }
        try {
            process.env.PATH = '/usr/bin'
            process.env.HOME = '/root'
            delete process.env.TZ
            delete process.env.RESTIC_PASSWORD

            const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
            const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
                calls.push({ command, args, options })
                const child = Object.assign(new EventEmitter(), {
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                })
                setImmediate(() => child.emit('close', 0))
                return child
            }) as unknown as typeof nodeSpawn

            const spawnStream = nodeSpawnStream(fakeSpawn)
            const handle = spawnStream('restic', ['dump', 'snapshot', '/'])
            await handle.exit

            assert.deepEqual(calls[0]?.options.env, {
                PATH: '/usr/bin', HOME: '/root',
            })
        } finally {
            process.env = original
        }
    })
})

describe('createResticRunner', () => {
    it('passes a child environment with RESTIC_PASSWORD and omits docker-specific keys', async () => {
        const original = { ...process.env }
        try {
            process.env.PATH = '/usr/bin'
            process.env.HOME = '/root'
            process.env.TZ = 'UTC'
            process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
            process.env.DOCKER_CONFIG = '/root/.docker'
            process.env.RESTIC_PASSWORD = 'super-secret'

            const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
            const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
                calls.push({ command, args, options })
                const child = Object.assign(new EventEmitter(), {
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                })
                setImmediate(() => child.emit('close', 0))
                return child
            }) as unknown as typeof nodeSpawn

            const runner = createResticRunner(fakeSpawn)
            await runner('restic', ['init', '-r', '/repo'], 1000)

            assert.deepEqual(calls[0]?.options.env, {
                PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', RESTIC_PASSWORD: 'super-secret',
            })
        } finally {
            process.env = original
        }
    })
})
