// One backup put back over live, end to end. Never throws: a failure is a record saying which step failed
// and why.
//
// It is a copy (copy-run.ts) with its two ends changed: what is loaded comes out of a snapshot rather than
// out of live's running databases, and where it goes is live itself. So it borrows the copy's middle
// whole (prepare, load, restoreState): live's site services stopped while its databases are replaced, each
// dump loaded with the engine's own client, and the services put back as they were found.
//
// The steps, each recorded on the run as it starts so the portal can say where it is:
//   safety      a fresh backup of live, taken first and waited for. Nothing of live changes unless it
//               worked, so whatever the restore replaces can itself be put back.
//   space       room under the site for the snapshot's files, plus the margin a deploy keeps
//   extract     restic restore of the snapshot into <site>/.restore/<run>, and every dump the registry's
//               databases need found in it. Still nothing of live has changed.
//   prepare     live's other services stopped and its databases running (copy-run's prepare)
//   load:<service>, sqlite:<service>, storage:<path>
//               each database loaded, each sqlite file and storage folder renamed into place
//
// Staging is <site>/.restore/<run>, in the site's own folder, which no client container mounts (they mount
// the environments inside it): restic writes there as root, and nothing a client can change is on the way.
// It is removed whatever happens, and the path is checked against its exact shape before it is. Live's own
// files that a restore replaces go into staging first and are removed with it: the safety backup is what
// holds them.
//
// Every write into live's checkout runs in the io helper with only the site folder mounted, as a copy's
// writes into an environment do, so a symlink a client container swaps into its checkout can never lead a
// rename out of the site.

import { posix } from 'node:path'

import { describeError, isWithin } from '../shared/formats.ts'
import { isNestedDir, siteOf } from '../shared/layout.ts'
import type { BackupRecord } from '../shared/backups.ts'
import type { RestoreRecord } from '../shared/protocol.ts'
import { environmentOf, isComposeService, type EnvironmentEntry, type ProjectEntry, type Registry, type ServiceEntry } from '../shared/registry.ts'
import { tail, type Runner } from './compose.ts'
import type { DockerApi } from './docker.ts'
import { dumpPlan, isProblem } from './backup-dumps.ts'
import { loadPlan } from './copy-plans.ts'
import { COPY_MIN_FREE_BYTES, load, prepare, restoreState, type Changed, type CopyFs } from './copy-run.ts'
import { mkdirArgv, renameArgv, type IoHelper } from './io-helper.ts'
import { repoPath, type Restic } from './restic.ts'

// mkdir and rename in the helper: each is one system call
const HELPER_TIMEOUT_MS = 120_000
// Where a restore stages, and nowhere else: one site folder under /var/www, its .restore folder, and one
// run id
const STAGING_DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\.restore\/[0-9a-f]{8,32}$/
// A backup run's own staging folder as the snapshot captured it: the dumps are under it
const RUN_FOLDER = /^[0-9a-f]{8,32}$/

type Like = { uid: number, gid: number, mode: number }

export type RestoreFs = Pick<CopyFs, 'mkdir' | 'rmdir' | 'exists' | 'lkind' | 'realpath' | 'owner' | 'chown' | 'chmod' | 'readStream' | 'freeBytes'>

export type RestoreDeps = {
    dockerApi: Pick<DockerApi, 'exec' | 'listProjectContainers'>
    runner: Runner
    fs: RestoreFs
    helper: IoHelper
    restic: Pick<Restic, 'paths' | 'restoreSize' | 'restore'>
    backupDir: string
    store: { start(record: RestoreRecord): Promise<void>, finish(record: RestoreRecord): Promise<void> }
    log(message: string): void
    now(): number
    sleep?(ms: number): Promise<void>
}

// snapshot is the id as the project's own repository lists it, already looked up there. safety is the
// backup of live the agent started for this restore, under the backup runner's own locks.
export type RestoreRequest = { snapshot: string, run: string, actor: string, safety: Promise<BackupRecord> }

class StepFailed extends Error {}
function fail(reason: string): never {
    throw new StepFailed(reason)
}

const databasesOf = (project: ProjectEntry): Array<[string, ServiceEntry]> =>
    Object.entries(project.services).filter(([, entry]) => entry.role === 'database')
const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

// Why a restore of this project may not start, or null when it may. Reads only the registry entry, so a
// start answers at once. The agent refuses a busy project itself.
export function restoreRefusal(project: ProjectEntry): string | null {
    const live = environmentOf(project, 'live')
    if (!live) return `${project.id} has no live environment to restore into`
    if (!isNestedDir(live.dir)) {
        return `${project.id} is on a flat site; a restore needs the nested layout, which live moves into on its next deploy`
    }
    for (const [service, entry] of databasesOf(project)) {
        const dump = dumpPlan(service, entry)
        if (dump !== null && isProblem(dump)) return dump.problem
        if (dump?.kind === 'generic') return `${service} uses the generic engine, which a restore cannot load; put it back by hand`
        const plan = loadPlan(service, entry, project.id, project.id)
        if (plan !== null && isProblem(plan)) return plan.problem
    }
    return null
}

// Where one run stages: <site>/.restore/<run>, or null when that would be anywhere else. The one folder a
// restore removes recursively, so both the run and the boot sweep ask this rather than building the path.
export function stagingOf(project: ProjectEntry, run: string): string | null {
    const live = environmentOf(project, 'live')
    if (!live || !isNestedDir(live.dir)) return null
    const staging = posix.join(siteOf(live.dir), '.restore', run)
    return STAGING_DIR.test(staging) ? staging : null
}

// At boot, for each run the store has just marked interrupted: its staging holds a copy of the client's
// data, so it goes. A run whose project has since gone from the registry is logged for the operator.
export async function removeInterruptedRestoreStaging(
    records: RestoreRecord[], registry: Registry, fs: Pick<RestoreFs, 'rmdir'>, log: (message: string) => void,
): Promise<void> {
    for (const record of records) {
        const project = registry.projects.get(record.project)
        const staging = project ? stagingOf(project, record.run) : null
        if (staging === null) {
            log(`WARN restore ${record.project} ${record.run} was interrupted, and where it staged could not be worked out; look under the site's .restore folder`)
            continue
        }
        try {
            await fs.rmdir(staging)
            log(`restore ${record.project} ${record.run} was interrupted; removed ${staging}`)
        } catch (error) {
            log(`WARN restore ${record.project} ${record.run} was interrupted, and ${staging} could not be removed: ${describeError(error)}`)
        }
    }
}

// Which of the snapshot's paths is the backup run's own staging folder, the one the dumps are under:
// <backupDir>/.staging/<id>/<run>. Null when there is none, which a snapshot with no databases may be.
export function dumpFolderOf(paths: readonly string[], backupDir: string, id: string): string | null {
    const parent = posix.join(backupDir, '.staging', id)
    return paths.find(path => posix.dirname(path) === parent && RUN_FOLDER.test(posix.basename(path))) ?? null
}

// Which of the snapshot's paths holds one storage folder. The path the registry has now first; failing
// that, one under the same site that ends in the same relative path, which is where it was before the
// site moved into the nested layout. Null when the snapshot does not hold it at all (the folder was
// registered after the backup was taken).
export function storageFolderOf(paths: readonly string[], storage: { path: string, absolute: string }, site: string): string | null {
    if (paths.includes(storage.absolute)) return storage.absolute
    const suffix = `/${storage.path}`
    const moved = paths.filter(path => path.endsWith(suffix) && isWithin(site, path) && path !== site)
    return moved.length === 1 ? moved[0]! : null
}

type Context = {
    project: ProjectEntry
    live: EnvironmentEntry
    staging: string
    deps: RestoreDeps
}

export async function runRestore(project: ProjectEntry, request: RestoreRequest, deps: RestoreDeps): Promise<RestoreRecord> {
    const startedAt = deps.now()
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const where = `restore ${project.id} ${request.run}`
    let record: RestoreRecord = {
        project: project.id, environment: 'live', run: request.run, actor: request.actor,
        startedAt: new Date(startedAt).toISOString(), durationMs: 0, outcome: 'running', step: 'safety', reason: null,
        services: databasesOf(project).map(([service]) => service), storage: Object.values(project.storage).map(entry => entry.path),
        snapshot: request.snapshot, safety: null,
    }
    await deps.store.start(record).catch(error => deps.log(`WARN ${where}: the record could not be started: ${describeError(error)}`))

    let step = 'safety'
    // On the record as it starts, so the portal can say where the run is
    const begin = async (next: string): Promise<void> => {
        step = next
        record = { ...record, step, durationMs: deps.now() - startedAt }
        await deps.store.finish(record).catch(error => deps.log(`WARN ${where}: the record could not be written: ${describeError(error)}`))
    }

    const live = environmentOf(project, 'live')
    const staging = stagingOf(project, request.run) ?? ''
    const stagingOk = staging !== ''
    const changed: Changed = { base: null, wasRunning: [], started: [], stopped: new Set() }
    let failure: { step: string, reason: string } | null = null
    // Set once anything of live's may have changed: from then on, a failure says live may be partly restored
    let touched = false

    try {
        // Waited for before anything else, whatever else is wrong: the backup runner records it either way
        const safety = await request.safety
        if (safety.outcome !== 'ok' || safety.snapshot === null) {
            fail(`the safety backup of live did not work, so nothing was restored: ${safety.reason ?? 'no reason was recorded'}`)
        }
        // The short id, as the list of backups shows it
        record = { ...record, safety: safety.snapshot.slice(0, 8) }
        if (!live) fail(`${project.id} has no live environment to restore into`)
        if (!stagingOk) fail(`refusing to stage restore ${JSON.stringify(request.run)} anywhere but under the site's .restore folder`)
        const context: Context = { project, live: live!, staging, deps }
        const repo = repoPath(deps.backupDir, project.id)

        await begin('space')
        const size = await deps.restic.restoreSize(repo, request.snapshot)
        if (!size.ok) fail(`${size.reason}: ${size.output}`)
        const site = siteOf(live!.dir)
        const free = await deps.fs.freeBytes(site)
        if (free < COPY_MIN_FREE_BYTES + size.bytes) {
            fail(`only ${gib(free)} GiB is free under ${site}; a restore needs 10 GiB plus the size of the backup (${gib(size.bytes)} GiB)`)
        }

        await begin('extract')
        const listed = await deps.restic.paths(repo, request.snapshot)
        if (!listed.ok) fail(`${listed.reason}: ${listed.output}`)
        await deps.fs.mkdir(staging, { private: true })
        const restored = await deps.restic.restore(repo, request.snapshot, staging)
        if (!restored.ok) fail(`${restored.reason}: ${restored.output}`)
        const found = await findInSnapshot(context, listed.paths)

        await begin('prepare')
        touched = true
        const loading = { project, environment: live!, deps, sleep, changed }
        let containers = await prepare(loading)
        for (const [service, entry] of databasesOf(project)) {
            if (!isComposeService(entry)) continue
            await begin(`load:${service}`)
            deps.log(`${where}: loading ${service}`)
            containers = await load(loading, service, entry, found.dumps, containers, project.id, project.id)
        }
        for (const [service, entry] of databasesOf(project)) {
            if (entry.role !== 'database' || entry.engine !== 'sqlite') continue
            await begin(`sqlite:${service}`)
            await putSqlite(context, service, entry.file, found.sqlite.get(service)!)
        }
        for (const { path, source } of found.storage) {
            await begin(`storage:${path}`)
            await putStorage(context, path, source)
        }
    } catch (error) {
        failure = { step, reason: error instanceof StepFailed ? error.message : describeError(error) }
        deps.log(`${where}: failed at ${step}: ${failure.reason}`)
    }

    const putBack = await restoreState(changed, deps)
    if (putBack !== null) {
        deps.log(`${where}: live's services could not be put back as they were: ${putBack}`)
        if (failure === null) failure = { step: 'restore-state', reason: putBack }
        else failure.reason += ` Putting live's services back as they were also failed: ${putBack}`
    }

    // Checked again right before the one recursive delete, whatever the path was checked against before
    if (stagingOk && STAGING_DIR.test(staging)) {
        try {
            await deps.fs.rmdir(staging)
        } catch (error) {
            const reason = `${staging} could not be removed: ${describeError(error)}`
            deps.log(`${where}: ${reason}`)
            if (failure === null) failure = { step: 'clean', reason }
            else failure.reason += ` ${reason}`
        }
    }

    if (failure !== null && touched && failure.step !== 'clean') {
        failure.reason += record.safety === null
            ? ' Live may be partly restored.'
            : ` Live may be partly restored; the safety backup ${record.safety} holds it as it was before.`
    }
    const finished: RestoreRecord = {
        ...record,
        durationMs: deps.now() - startedAt,
        outcome: failure === null ? 'ok' : 'failed',
        step: failure?.step ?? null,
        reason: failure?.reason ?? null,
    }
    await deps.store.finish(finished).catch(error => deps.log(`WARN ${where}: the record could not be written: ${describeError(error)}`))
    deps.log(`${where}: ${finished.outcome}${finished.reason ? `: ${finished.reason}` : ''}`)
    return finished
}

type Found = {
    // The dump of each compose database, by service
    dumps: Map<string, string>
    // The copy of each sqlite file, by service
    sqlite: Map<string, string>
    // Each storage folder the snapshot holds, and where it was restored to
    storage: Array<{ path: string, source: string }>
}

// Everything the restore will put into live, found in what restic wrote to staging before live is touched:
// a database the snapshot has no dump of fails the run here, while live is still as it was. A storage
// folder it does not hold (one registered since) is left as live has it, and the log says so.
async function findInSnapshot(context: Context, paths: readonly string[]): Promise<Found> {
    const { project, live, staging, deps } = context
    const found: Found = { dumps: new Map(), sqlite: new Map(), storage: [] }
    const databases = databasesOf(project)
    const folder = dumpFolderOf(paths, deps.backupDir, project.id)
    for (const [service, entry] of databases) {
        const plan = dumpPlan(service, entry)
        if (plan === null) continue
        if (isProblem(plan)) fail(plan.problem)
        if (plan.kind === 'generic') fail(`${service} uses the generic engine, which a restore cannot load; put it back by hand`)
        const file = folder === null ? null : posix.join(staging, folder, 'db', service, plan.file)
        if (file === null || (await deps.fs.lkind(file)) !== 'file') {
            fail(`the backup holds no dump of ${service}: it was taken before ${service} was a registered database, so it cannot put it back`)
        }
        if (plan.kind === 'sqlite') found.sqlite.set(service, file!)
        else found.dumps.set(service, file!)
    }
    const site = siteOf(live.dir)
    for (const storage of Object.values(project.storage)) {
        const held = storageFolderOf(paths, storage, site)
        const source = held === null ? null : posix.join(staging, held)
        if (source === null || (await deps.fs.lkind(source)) === 'none') {
            deps.log(`restore ${project.id}: the backup does not hold ${storage.path}, so live's is left as it is`)
            continue
        }
        found.storage.push({ path: storage.path, source })
    }
    return found
}

// The helper with the site folder mounted at its own path: staging and live are both inside it, so a
// rename between them is one rename(2) on one mount, and a symlink in live's checkout resolves as it does
// on the host as long as it stays in the site. Every path given is under the site.
async function inSite(context: Context, argv: (inside: (path: string) => string) => string[], what: string): Promise<void> {
    const { live, deps } = context
    const site = siteOf(live.dir)
    const inside = (path: string): string => {
        if (!isWithin(site, path)) fail(`${path} is not under the site's folder ${site}`)
        return path
    }
    const result = await deps.helper([{ source: site, target: site }], argv(inside), HELPER_TIMEOUT_MS)
    if (result.exitCode !== 0 || result.timedOut) fail(`${what}: ${result.timedOut ? 'timed out' : tail(result.stderr.trim(), 300)}`)
}

// A plain rename, within the site folder: never follows a symlink at either end
function move(context: Context, from: string, to: string): Promise<void> {
    return inSite(context, inside => renameArgv(inside(from), inside(to)), `${from} could not be moved to ${to}`)
}

// A symlink in live's checkout (committed to the repo, say) could lead a path the restore writes to out of
// live's folder. So every folder that already exists along the way (a symlink, dangling or not, counts) is
// resolved first, and each must be inside live's own folder; one that cannot be resolved is refused too.
// Called again once the parents are made, on the folder the target goes in. The target itself is never
// written through: what is there is renamed into staging, and the backup's copy is renamed into its place.
async function confine(context: Context, relative: string, depths: 'all' | 'parent' = 'all'): Promise<void> {
    const { live, deps } = context
    const root = await deps.fs.realpath(live.dir)
    const parents = posix.dirname(relative) === '.' ? [] : posix.dirname(relative).split('/')
    for (let depth = depths === 'all' ? 0 : parents.length; depth <= parents.length; depth++) {
        const dir = posix.join(live.dir, ...parents.slice(0, depth))
        if ((await deps.fs.lkind(dir)) === 'none') break
        let real: string
        try {
            real = await deps.fs.realpath(dir)
        } catch (error) {
            fail(`${relative} could not be resolved (through ${dir}: ${describeError(error)}), so the restore will not touch it`)
        }
        if (!isWithin(root, real)) fail(`${relative} resolves outside live's folder (through ${dir}, to ${real}), so the restore will not touch it`)
    }
}

// The folders above something the restore is about to put into live, made one level at a time and each
// owned like live's tree, as a copy makes them. In the helper, where mkdir fails on anything already there
// rather than going through it.
async function ensureParents(context: Context, relative: string): Promise<void> {
    const { live, deps } = context
    const parents = posix.dirname(relative) === '.' ? [] : posix.dirname(relative).split('/')
    let like: Like | null = null
    for (let depth = 1; depth <= parents.length; depth++) {
        const dir = posix.join(live.dir, ...parents.slice(0, depth))
        // A symlink there, dangling or not, is left for confine to judge, never made or owned through
        if ((await deps.fs.lkind(dir)) !== 'none') continue
        const owned = like ??= await deps.fs.owner(live.dir)
        await inSite(context, inside => mkdirArgv(inside(dir), owned), `${dir} could not be made`)
    }
}

// The backup's copy of a sqlite file, renamed into live's place. sqlite3's .backup made it, so it is one
// consistent file with no journal of its own; live's file, and any journal beside it that belongs to that
// file and not this one, go into staging first. Live's site services are stopped by now, so nothing has the
// file open to write to it.
async function putSqlite(context: Context, service: string, file: string, copy: string): Promise<void> {
    const { live, staging, deps } = context
    const target = posix.join(live.dir, file)
    await confine(context, file)
    await ensureParents(context, file)
    await confine(context, file, 'parent')
    if ((await deps.fs.lkind(copy)) !== 'file') fail(`${service}: the backup's copy of ${file} is not a file`)
    // The backup's copy is owned by root, and the site's own user has to be able to write it: owned like the
    // file it replaces (and moded like it), or like the folder it goes in when there was none. A symlink at
    // the target is not a file of live's own to take an owner from: it is set aside like one.
    const had = (await deps.fs.lkind(target)) === 'file'
    const like = await deps.fs.owner(had ? target : posix.dirname(target))
    await deps.fs.chown(copy, like.uid, like.gid)
    if (had) await deps.fs.chmod(copy, like.mode)

    const old = posix.join(staging, 'old', 'sqlite', service)
    await deps.fs.mkdir(old, { private: true })
    // Each move is remembered, so a failure part way puts live's own files back
    const moved: Array<{ from: string, to: string }> = []
    try {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            const from = `${target}${suffix}`
            if ((await deps.fs.lkind(from)) === 'none') continue
            const to = posix.join(old, `${posix.basename(target)}${suffix}`)
            await move(context, from, to)
            moved.push({ from, to })
        }
        await move(context, copy, target)
    } catch (error) {
        for (const { from, to } of moved.reverse()) {
            await move(context, to, from).catch(undo => deps.log(`restore ${live.dir}: ${to} could not be moved back to ${from}: ${describeError(undo)}`))
        }
        throw error
    }
}

// The backup's copy of a storage folder, renamed into live's place, with the owners and modes restic kept
// from when it was backed up. Live's own folder goes into staging first, and comes back if the rename
// fails, rather than leaving live with none.
async function putStorage(context: Context, path: string, source: string): Promise<void> {
    const { live, staging, deps } = context
    const target = posix.join(live.dir, path)
    await confine(context, path)
    await ensureParents(context, path)
    await confine(context, path, 'parent')

    const old = posix.join(staging, 'old', 'storage', path)
    const had = (await deps.fs.lkind(target)) !== 'none'
    if (had) {
        await deps.fs.mkdir(posix.dirname(old), { private: true })
        await move(context, target, old)
    }
    try {
        await move(context, source, target)
    } catch (error) {
        if (had) await move(context, old, target).catch(() => {})
        throw error
    }
}
