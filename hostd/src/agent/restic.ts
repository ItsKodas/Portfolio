// Every restic command the agent runs, and the argv that builds them. Two adapters, for two reasons: most
// commands produce a few kilobytes of JSON and go through Runner, which captures output as text, while a
// dump is a tar of the whole snapshot and goes through SpawnStream, which never holds it in memory.
//
// RESTIC_PASSWORD is never passed as an argument and never logged. restic reads it from a carefully
// scoped child environment that includes only what restic needs, passed via childEnv(RESTIC_ENV_KEYS).

import { spawn as nodeSpawn } from 'node:child_process'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'

import { childEnv, createSpawnRunner, tail, type Runner } from './compose.ts'
import type { Keep } from '../shared/registry.ts'
import type { BackupTag, Snapshot } from '../shared/backups.ts'

// restic needs its repository password and nothing docker-specific. It never runs compose, so
// unlike the docker allowlist nothing here can be interpolated into a client's own compose file.
export const RESTIC_ENV_KEYS = ['PATH', 'HOME', 'TZ', 'RESTIC_PASSWORD'] as const

// Every restic command except dump runs through this, not through the docker runner: it is the only
// Runner whose children are given RESTIC_PASSWORD. Wiring builds the restic adapter with this, and a
// plain createSpawnRunner() would leave restic with no password and fail every command.
export const createResticRunner = (spawn: typeof nodeSpawn = nodeSpawn): Runner =>
    createSpawnRunner(spawn, RESTIC_ENV_KEYS)

// A backup of a large site is minutes, and a prune of a large repository can be longer. Nothing here is
// on a request's critical path: the run was started, not awaited.
export const RESTIC_TIMEOUT_MS = 60 * 60_000
export const OUTPUT_TAIL = 500
// How much of a streamed command's stderr is kept. A dump that fails carries this tail in the error the
// download body throws, so it has to be enough to name the repository and restic's own complaint, and
// bounded because a repository that is broken on every pack writes a line per pack.
export const STREAM_STDERR_CAP = 4096

export const repoPath = (backupDir: string, id: string): string => posix.join(backupDir, id)
export const stagingPath = (backupDir: string, id: string, run: string): string => posix.join(backupDir, '.staging', id, run)

const base = (repo: string): string[] => ['-r', repo]

export const initArgv = (repo: string): string[] => [...base(repo), 'init']
export const backupArgv = (repo: string, paths: string[], tag: BackupTag): string[] =>
    [...base(repo), 'backup', '--json', '--tag', tag, ...paths]
export const snapshotsArgv = (repo: string): string[] => [...base(repo), 'snapshots', '--json']
export const forgetArgv = (repo: string, snapshot: string): string[] => [...base(repo), 'forget', snapshot]
// scheduled only: a manual snapshot is kept until the client deletes it, and retention must never take one.
export const retentionArgv = (repo: string, keep: Keep): string[] => [
    ...base(repo), 'forget', '--tag', 'scheduled',
    // --group-by '' is load-bearing, not noise. restic's default is --group-by host,paths: it partitions
    // snapshots by host and by the exact set of paths captured, then applies the keep policy inside each
    // group. Every run captures its own staging directory, whose path carries that run's id, and the
    // agent's hostname changes whenever its image is rebuilt, so with the default every snapshot lands in
    // a group of one and the policy keeps it. Forgetting nothing, on a disk shared by every project, is
    // not visible until backups are refused for everyone at 10% free. An empty group-by puts every
    // scheduled snapshot of this repository in one group, which is the only way the policy applies.
    '--group-by', '',
    '--keep-daily', String(keep.daily), '--keep-weekly', String(keep.weekly), '--keep-monthly', String(keep.monthly),
]
export const pruneArgv = (repo: string): string[] => [...base(repo), 'prune']
export const dumpArgv = (repo: string, snapshot: string): string[] => [...base(repo), 'dump', '--archive', 'tar', snapshot, '/']

export type StreamHandle = { stdout: Readable, exit: Promise<{ exitCode: number | null, stderr: string }> }
export type SpawnStream = (command: string, args: string[]) => StreamHandle

export function nodeSpawnStream(spawn: typeof nodeSpawn = nodeSpawn): SpawnStream {
    return (command, args) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(RESTIC_ENV_KEYS) })
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < STREAM_STDERR_CAP) stderr += chunk.toString('utf8') })
        const exit = new Promise<{ exitCode: number | null, stderr: string }>(resolve => {
            child.on('close', code => resolve({ exitCode: code, stderr: stderr.trim() }))
            child.on('error', error => resolve({ exitCode: null, stderr: error.message }))
        })
        return { stdout: child.stdout!, exit }
    }
}

export type ResticFailure = { ok: false, reason: string, output: string }
export type Restic = {
    init(repo: string): Promise<{ ok: true } | ResticFailure>
    backup(repo: string, paths: string[], tag: BackupTag): Promise<{ ok: true, snapshot: string, sizeBytes: number | null } | ResticFailure>
    snapshots(repo: string): Promise<{ ok: true, snapshots: Snapshot[] } | ResticFailure>
    forget(repo: string, snapshot: string): Promise<{ ok: true } | ResticFailure>
    retention(repo: string, keep: Keep): Promise<{ ok: true } | ResticFailure>
    prune(repo: string): Promise<{ ok: true } | ResticFailure>
    dump(repo: string, snapshot: string): StreamHandle
}

type Summary = { message_type?: string, snapshot_id?: string, total_bytes_processed?: number }
type ResticSnapshot = { short_id?: string, id?: string, time?: string, tags?: string[] }

export function createRestic(run: Runner, spawnStream: SpawnStream): Restic {
    // Every failure is returned, never thrown, and carries the tail of stderr so a broken repository is
    // diagnosable from the portal. stderr from restic names paths and exit codes, never the password.
    const failed = (what: string, result: { exitCode: number | null, stderr: string, timedOut: boolean }): ResticFailure => ({
        ok: false,
        reason: result.timedOut ? `restic ${what} timed out` : `restic ${what} exited with code ${result.exitCode}`,
        output: tail(result.stderr.trim(), OUTPUT_TAIL),
    })

    async function simple(what: string, args: string[]): Promise<{ ok: true } | ResticFailure> {
        const result = await run('restic', args, RESTIC_TIMEOUT_MS)
        return result.exitCode === 0 && !result.timedOut ? { ok: true } : failed(what, result)
    }

    return {
        init: repo => simple('init', initArgv(repo)),
        forget: (repo, snapshot) => simple('forget', forgetArgv(repo, snapshot)),
        retention: (repo, keep) => simple('forget', retentionArgv(repo, keep)),
        prune: repo => simple('prune', pruneArgv(repo)),

        async backup(repo, paths, tag) {
            const result = await run('restic', backupArgv(repo, paths, tag), RESTIC_TIMEOUT_MS)
            if (result.exitCode !== 0 || result.timedOut) return failed('backup', result)
            // --json writes one object per line and ends with a summary. The summary is the only line that
            // names the snapshot, so a run whose output we cannot read is a failed run: without an id there
            // is nothing to record, delete or download.
            for (const line of result.stdout.split('\n').reverse()) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line) as Summary
                    if (parsed.message_type === 'summary' && parsed.snapshot_id) {
                        return { ok: true, snapshot: parsed.snapshot_id, sizeBytes: parsed.total_bytes_processed ?? null }
                    }
                } catch {
                    // Not JSON: restic writes progress lines too. Keep looking.
                }
            }
            return { ok: false, reason: 'restic backup did not report a snapshot id', output: tail(result.stdout.trim(), OUTPUT_TAIL) }
        },

        async snapshots(repo) {
            const result = await run('restic', snapshotsArgv(repo), RESTIC_TIMEOUT_MS)
            if (result.exitCode !== 0 || result.timedOut) return failed('snapshots', result)
            try {
                const parsed = JSON.parse(result.stdout) as ResticSnapshot[]
                const snapshots = parsed
                    .map(entry => ({
                        id: entry.short_id ?? entry.id ?? '',
                        at: new Date(entry.time ?? 0).toISOString(),
                        tag: (entry.tags ?? []).includes('manual') ? 'manual' as const : 'scheduled' as const,
                        sizeBytes: null,
                    }))
                    .filter(snapshot => snapshot.id !== '')
                    .sort((a, b) => b.at.localeCompare(a.at))
                return { ok: true, snapshots }
            } catch {
                return { ok: false, reason: 'restic snapshots returned unreadable output', output: '' }
            }
        },

        dump: (repo, snapshot) => spawnStream('restic', dumpArgv(repo, snapshot)),
    }
}
