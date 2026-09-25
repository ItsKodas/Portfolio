// One backup run, end to end. Never throws: a failure is a record saying so, because the run has already
// happened by the time anything can react to it.
//
// Live only. Every path here comes from environmentOf(project, 'live') or project.storage, both of which
// the registry derived; nothing a request carried ever becomes a path. A path under the site is resolved
// before it is read and must stay in live's (or, for a bind mount, the site's) folder: a symlink in the
// checkout is the client's own content and could point at another site.

import { once } from 'node:events'
import { posix } from 'node:path'
import type { Writable } from 'node:stream'

import { clampKeep, diskProblem, type BackupRecord, type BackupTag } from '../shared/backups.ts'
import { describeError, isWithin } from '../shared/formats.ts'
import { siteOf } from '../shared/layout.ts'
import { environmentOf, type Keep, type ProjectEntry } from '../shared/registry.ts'
import type { DiskUsage } from '../shared/system.ts'
import { composeBase, resolveCompose, tail, type Runner } from './compose.ts'
import { pickPerService, type DockerApi } from './docker.ts'
import { dumpPlans, type DumpPlan } from './backup-dumps.ts'
import { repoPath, stagingPath, type Restic } from './restic.ts'

export const LIFECYCLE_TIMEOUT_MS = 120_000

export type BackupFs = {
    mkdir(dir: string): Promise<void>
    // A sink to stream a dump into, and a promise that resolves once it is on disk. Streamed, never
    // buffered: a dump is as large as the database.
    writeStream(path: string): { sink: Writable, done: Promise<void> }
    remove(path: string): Promise<void>
    copy(from: string, to: string): Promise<void>
    exists(path: string): Promise<boolean>
    // Where a path really is, every symlink along it followed
    realpath(path: string): Promise<string>
    // lstat: what is at the path itself, a symlink (dangling or not) never followed
    lkind(path: string): Promise<'none' | 'link' | 'dir' | 'file' | 'other'>
}

// Where client sites live: a bind mount under it (or resolving into it) must stay in its own site's folder
const WWW = '/var/www'

export type BackupDeps = {
    backupDir: string
    restic: Restic
    docker: DockerApi
    runner: Runner
    fs: BackupFs
    disk: () => Promise<DiskUsage | null>
    now: () => number
    log(message: string): void
}

// One chunk of a dump into its file, waiting for the file to take it when it is behind. A write that fails
// (a full disk) never drains, so the wait is on drain, error or close, whichever comes first: the dump then
// fails rather than waiting forever with the database's dump process blocked behind it.
export async function writeChunk(sink: Writable, chunk: Buffer): Promise<void> {
    if (sink.errored) throw sink.errored
    if (sink.destroyed || sink.writableEnded) throw new Error('the dump file was closed while the dump was still being written')
    if (sink.write(chunk)) return
    const stop = new AbortController()
    try {
        await Promise.race([
            // once rejects on error
            once(sink, 'drain', { signal: stop.signal }),
            once(sink, 'close', { signal: stop.signal }).then(() => {
                throw sink.errored ?? new Error('the dump file was closed while the dump was still being written')
            }),
        ])
    } finally {
        stop.abort()
    }
}

// sqlite3 opens these beside the database file itself, by name, so resolving the database's own path
// does not confine them: a symlink at any of them could have sqlite3 read (or, for a hot journal, write)
// another site's file. The first one beside source that is a symlink, dangling or not, or null.
export const SQLITE_SIDE_FILES = ['-wal', '-shm', '-journal'] as const
export async function linkedSideFile(source: string, fs: Pick<BackupFs, 'lkind'>): Promise<string | null> {
    for (const suffix of SQLITE_SIDE_FILES) {
        if ((await fs.lkind(`${source}${suffix}`)) === 'link') return `${source}${suffix}`
    }
    return null
}

export type BackupRequest = { tag: BackupTag, actor: string, run: string, keep: Keep | null }

export async function runBackup(project: ProjectEntry, request: BackupRequest, deps: BackupDeps): Promise<BackupRecord> {
    const startedAt = deps.now()
    let disruptive = false

    const record = (outcome: 'ok' | 'failed', snapshot: string | null, reason: string | null): BackupRecord => ({
        run: request.run, tag: request.tag, actor: request.actor,
        startedAt: new Date(startedAt).toISOString(), durationMs: deps.now() - startedAt,
        outcome, snapshot, reason, disruptive,
    })

    const problem = diskProblem(await deps.disk())
    if (problem) return record('failed', null, problem)

    const live = environmentOf(project, 'live')
    if (!live) return record('failed', null, `${project.id} has no live environment`)

    const staging = stagingPath(deps.backupDir, project.id, request.run)
    const repo = repoPath(deps.backupDir, project.id)

    try {
        const planned = dumpPlans(project)
        if (!planned.ok) return record('failed', null, planned.problem)
        const outside = await storageOutside(project, live.dir, deps.fs)
        if (outside) return record('failed', null, outside)

        await deps.fs.mkdir(staging)
        // restic init on an existing repository exits non-zero, which is why this asks first rather than
        // treating a failure as proof it was already there.
        if (!(await deps.fs.exists(posix.join(repo, 'config')))) {
            const started = await deps.restic.init(repo)
            if (!started.ok) return record('failed', null, `${started.reason}: ${started.output}`)
        }

        const containers = pickPerService(await deps.docker.listProjectContainers(project.id))
        for (const plan of planned.plans) {
            const target = posix.join(staging, 'db', plan.service)
            await deps.fs.mkdir(target)
            // A generic dump stops the service to copy it, so the run is disruptive from the moment it
            // starts, whether or not the copy then succeeds.
            if (plan.kind === 'generic') disruptive = true
            const failure = await dump(plan, posix.join(target, plan.file), project, live.dir, containers, deps)
            if (failure) return record('failed', null, failure)
        }

        // One capture of staging and every storage directory, whatever its mode: hidden storage is backed
        // up and simply never exposed through the file API.
        const paths = [staging, ...Object.values(project.storage).map(entry => entry.absolute)]
        const captured = await deps.restic.backup(repo, paths, request.tag)
        if (!captured.ok) return record('failed', null, `${captured.reason}: ${captured.output}`)

        // Retention is the client's, and applies to scheduled snapshots only. A manual snapshot is kept
        // until the client deletes it.
        if (request.tag === 'scheduled' && request.keep) {
            // The client's retention, bounded by the operator's registry ceiling. api clamps it too, but the
            // agent never lets api's word stand in for its own: this is the only place it is applied.
            const keep = clampKeep(request.keep, project.backups.maxKeep)
            const forgotten = await deps.restic.retention(repo, keep)
            if (!forgotten.ok) deps.log(`WARN backup ${project.id}: retention failed: ${forgotten.reason}`)
        }

        return record('ok', captured.snapshot, null)
    } catch (error) {
        return record('failed', null, describeError(error))
    } finally {
        // Whatever happened: a dump left behind is a copy of the client's database sitting outside the
        // repository, and the next run would capture it again. Safe even when staging was never created,
        // since dumpPlans can fail before the mkdir above runs.
        await deps.fs.remove(staging).catch(error => deps.log(`WARN backup ${project.id}: staging could not be cleared: ${describeError(error)}`))
    }
}

// A symlink in live's checkout (committed to the repo, say, as public -> /var/www/<other site>/live/public)
// could lead a storage path out of live's folder, and restic would then capture another site's files into
// this one's repository. restic reads each path it is given with lstat, so a storage folder that is itself
// a symlink is stored as the link and nothing it points at is read: only the folders above it are resolved
// here. One that is not there is left to restic, which reports a missing path as it always has. Null when
// every storage folder stays inside live's folder (or there is none, when live's folder is not even
// looked at), or why the backup will not run.
async function storageOutside(project: ProjectEntry, dir: string, fs: BackupFs): Promise<string | null> {
    if (Object.keys(project.storage).length === 0) return null
    let root: string
    try {
        root = await fs.realpath(dir)
    } catch (error) {
        return `live's folder ${dir} could not be resolved (${describeError(error)}), so its storage will not be read`
    }
    for (const entry of Object.values(project.storage)) {
        const parent = posix.dirname(entry.absolute)
        let real: string
        try {
            real = await fs.realpath(parent)
        } catch {
            continue
        }
        if (!isWithin(root, real)) return `storage ${entry.path} resolves outside live's folder (through ${parent}, to ${real}), so the backup will not read it`
    }
    return null
}

// Returns null on success, or why the dump failed.
async function dump(
    plan: DumpPlan,
    target: string,
    project: ProjectEntry,
    dir: string,
    containers: ReadonlyMap<string, { Id: string, State: string }>,
    deps: BackupDeps,
): Promise<string | null> {
    if (plan.kind === 'sqlite') {
        // sqlite3's own .backup is safe against a concurrent writer, which copying the file is not. The file
        // is read at the path it resolves to, which must be inside live's folder: a symlink in live's
        // checkout could otherwise have this site's backup read another site's database.
        let source: string
        try {
            source = await deps.fs.realpath(posix.join(dir, plan.source))
        } catch (error) {
            return `${plan.service}: ${plan.source} could not be resolved: ${describeError(error)}`
        }
        const root = await deps.fs.realpath(dir)
        if (!isWithin(root, source)) return `${plan.service}: ${plan.source} resolves outside live's folder (to ${source}), so the backup will not read it`
        const linked = await linkedSideFile(source, deps.fs)
        if (linked) return `${plan.service}: ${linked} is a symlink, and sqlite3 would open it beside the database, so the backup will not read it`
        const result = await deps.runner('sqlite3', [source, `.backup ${target}`], LIFECYCLE_TIMEOUT_MS)
        return result.exitCode === 0 && !result.timedOut ? null : `${plan.service}: sqlite3 exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 500)}`
    }

    if (plan.kind === 'generic') {
        // The fallback for an engine with no dump method: stop it, copy what it has bind-mounted, start it
        // again. Briefly disruptive, and the caller marks the record so the portal can say so.
        await deps.fs.mkdir(target)
        const resolved = await resolveCompose({ dir, composePaths: project.composePaths, composeName: project.composeName }, deps.runner)
        if (!resolved.ok) return `${plan.service}: ${resolved.problem}`
        const sources = (resolved.resolved.services[plan.service]?.volumes ?? [])
            .filter(volume => volume.type === 'bind' && typeof volume.source === 'string')
            .map(volume => volume.source!)
        if (sources.length === 0) return `${plan.service}: a generic engine needs a bind-mounted data directory to copy`
        // Checked before anything is stopped: a bind mount under /var/www, or one that resolves into it,
        // must resolve inside this site's own folder, or a symlink in the checkout could have this site's
        // backup read another's. A bind mount elsewhere on the host is the compose file's own business.
        const site = await deps.fs.realpath(siteOf(dir))
        for (const source of sources) {
            let real: string
            try {
                real = await deps.fs.realpath(source)
            } catch (error) {
                if (isWithin(WWW, source)) return `${plan.service}: its bind mount ${source} could not be resolved: ${describeError(error)}`
                continue
            }
            if ((isWithin(WWW, source) || isWithin(WWW, real)) && !isWithin(site, real)) {
                return `${plan.service}: its bind mount ${source} resolves outside the site's folder ${siteOf(dir)} (to ${real}), so the backup will not read it`
            }
        }
        const base = composeBase({ dir, composePaths: project.composePaths, composeName: project.composeName })
        const stopped = await deps.runner('docker', [...base, 'stop', plan.service], LIFECYCLE_TIMEOUT_MS)
        if (stopped.exitCode !== 0) return `${plan.service}: could not be stopped to copy its data`
        try {
            for (const source of sources) await deps.fs.copy(source, posix.join(target, posix.basename(source)))
            return null
        } catch (error) {
            return `${plan.service}: ${describeError(error)}`
        } finally {
            const started = await deps.runner('docker', [...base, 'start', plan.service], LIFECYCLE_TIMEOUT_MS)
            if (started.exitCode !== 0) deps.log(`WARN backup ${project.id}: ${plan.service} did not start again after a generic dump`)
        }
    }

    const container = containers.get(plan.service)
    if (!container) return `${plan.service}: no container is running to dump from`
    if (container.State !== 'running') return `${plan.service}: the container is ${container.State}, so there is nothing to dump from`
    const { sink, done } = deps.fs.writeStream(target)
    // Handled from the start: a write that fails rejects this long before the exec below returns
    done.catch(() => {})
    try {
        const result = await deps.docker.exec(container.Id, plan.argv, chunk => writeChunk(sink, chunk))
        sink.end()
        await done
        if (result.exitCode !== 0) return `${plan.service}: the dump exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`
        return null
    } catch (error) {
        sink.end()
        // Waited the same as the success path, so the file is settled before staging is removed; a
        // problem here must not replace the dump's own failure reason with a stream one.
        await done.catch(() => {})
        return `${plan.service}: ${describeError(error)}`
    }
}
