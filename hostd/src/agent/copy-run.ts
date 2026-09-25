// One copy of live's databases and storage into another environment of the same site, end to end. Never
// throws: a failure is a record saying which step failed and why.
//
// Live is only ever read: its databases are dumped online through the same commands a backup runs, its
// sqlite files are read with sqlite3's .backup, and its storage folders are copied with cp -a. Nothing of
// live's is stopped, started or written. The environment ends in the state it started in: its site
// services running only if they were, and any database the copy had to start stopped again.
//
// Everything staged goes under <site>/.copy/<run>/, which is removed whatever happens. It is the only
// thing this file ever deletes recursively, and the path is checked against its exact shape before it is.
// Every path comes from the registry entry, never from a request: the run id is the agent's own.
//
// Every read of live's checkout and every change to the environment's runs in the io helper (see
// io-helper.ts), which mounts only what that step may touch: a client container can swap a folder in its
// own checkout for a symlink between a check here and the use, and the helper is what keeps that symlink
// from reaching another site. The checks here still run first, for the reason they give.

import { posix } from 'node:path'
import { pipeline, type Readable, type Writable } from 'node:stream'

import { describeError, isWithin } from '../shared/formats.ts'
import { isNestedDir, siteOf } from '../shared/layout.ts'
import { environmentOf, isComposeService, type EnvironmentEntry, type ProjectEntry, type Registry, type ServiceEntry } from '../shared/registry.ts'
import type { CopyRecord } from '../shared/protocol.ts'
import { composeBase, resolveCompose, tail, type Runner } from './compose.ts'
import { checkedId, pickPerService, type ContainerSummary, type DockerApi } from './docker.ts'
import { dumpPlan, isProblem } from './backup-dumps.ts'
import { linkedSideFile, sqliteBackup, writeChunk } from './backup-run.ts'
import { mkdirArgv, renameArgv, type IoHelper } from './io-helper.ts'
import { loadPlan, parseSize, postgresErrorCollector, readyPasses, readyProbe, renameStream, sizeProbe } from './copy-plans.ts'
import { MIN_FREE_BYTES } from './deploy.ts'
import { declaredServices, environmentServices, type EnvironmentServices } from './environment-services.ts'

// The same margin a deploy keeps, on top of what the copy of live's storage and databases is about to take
export const COPY_MIN_FREE_BYTES = MIN_FREE_BYTES
// compose stop, up and start, and each database command that is not the load itself
const COMPOSE_TIMEOUT_MS = 120_000
// cp -a of a storage folder and sqlite3's .backup of a file: as long as the data is large
const COPY_TIMEOUT_MS = 4 * 60 * 60_000
// How long a database the copy started has to reach running, and then to answer
const WAIT_ATTEMPTS = 30
const WAIT_MS = 2_000
// Where a copy stages, and nowhere else: one site folder under /var/www, its .copy folder, and one run id
const STAGING_DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\.copy\/[0-9a-f]{8,32}$/
// Where an earlier version of the copy put its copy, beside the environment's own file or folder. Nothing
// is written there now; whatever is found there is set aside into staging.
const COPY_ASIDE = '.hostd-copy'
// What the environment's redis says its data directory is: an absolute path, and nothing a shell or
// docker cp could read as anything else
const REDIS_DIR = /^\/[A-Za-z0-9._/-]{0,255}$/
// And the file in it that redis loads at start: one plain file name, never a path
const REDIS_FILE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/

type Like = { uid: number, gid: number, mode: number }

export type CopyFs = {
    // Recursive, and only ever under staging, which no client can change (the environment's own folders
    // are made in the helper). private: 0700, for staging, which holds a copy of the client's data
    mkdir(dir: string, options?: { private?: boolean }): Promise<void>
    // Recursive: only ever the staging folder, checked first
    rmdir(dir: string): Promise<void>
    // stat: follows a symlink, so a dangling one is not there
    exists(path: string): Promise<boolean>
    // lstat: what is at the path itself, a symlink (dangling or not) never followed
    lkind(path: string): Promise<'none' | 'link' | 'dir' | 'file' | 'other'>
    // Where a path really is, every symlink along it followed
    realpath(path: string): Promise<string>
    owner(path: string): Promise<Like>
    // Which folder a path is (device and inode, following a symlink), for the helper to prove it
    // mounted the same one
    identity(path: string): Promise<string>
    // One path's owner and mode, never following into a tree: what a sqlite file copied in by root needs.
    // chown never follows a symlink (lchown); chmod has no such form, so it is only ever called on a
    // regular file in the run's own staging, checked with lkind first.
    chown(path: string, uid: number, gid: number): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    // A sink to stream a dump into, and a promise that resolves once it is on disk
    writeStream(path: string): { sink: Writable, done: Promise<void> }
    readStream(path: string): Readable
    freeBytes(path: string): Promise<number>
    // Bytes under a path, 0 when nothing is there
    sizeOf(path: string): Promise<number>
}

export type CopyDeps = {
    dockerApi: Pick<DockerApi, 'exec' | 'listProjectContainers'>
    runner: Runner
    fs: CopyFs
    helper: IoHelper
    store: { start(record: CopyRecord): Promise<void>, finish(record: CopyRecord): Promise<void> }
    log(message: string): void
    now(): number
    sleep?(ms: number): Promise<void>
}

type Containers = ReadonlyMap<string, ContainerSummary>

class StepFailed extends Error {}
function fail(reason: string): never {
    throw new StepFailed(reason)
}

const databasesOf = (project: ProjectEntry): Array<[string, ServiceEntry]> =>
    Object.entries(project.services).filter(([, entry]) => entry.role === 'database')
const storagePathsOf = (project: ProjectEntry): string[] => Object.values(project.storage).map(entry => entry.path)
// live's database is named after the site, and an environment's after the site and itself, which is what
// provision.ts's rewriteEnvText wrote into the environment's env files
const databaseNameOf = (project: ProjectEntry, environment: EnvironmentEntry): string => `${project.id}-${environment.name}`

// Every one of live's databases is loaded into the environment, so each has to be a service the
// environment's own compose file declares. A branch may run fewer services than the registry lists
// (environment-services.ts), and a database it does not run has nowhere for live's data to go.
function undeclaredProblem(project: ProjectEntry, name: string, declared: EnvironmentServices): string | null {
    const missing = databasesOf(project).filter(([service, entry]) => isComposeService(entry) && !Object.hasOwn(declared, service))
    if (missing.length === 0) return null
    const names = missing.map(([service]) => service)
    return `${name} does not run ${names.join(', ')}: its compose file does not declare ${names.length === 1 ? 'it' : 'them'}, so live's data has nowhere to go`
}

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

// Why a copy into this environment may not start, or null when it may. Reads only, and only what is quick
// to read, so a start answers at once: the disk is the run's own first step (spaceProblem). The agent
// refuses a busy environment, and a running backup, itself.
export async function copyRefusal(
    project: ProjectEntry, name: string, deps: { dockerApi: Pick<DockerApi, 'listProjectContainers'>, runner: Runner },
): Promise<string | null> {
    if (name === 'live') return 'live is what a copy reads from; it is never copied into'
    const environment = environmentOf(project, name)
    if (!environment) return `${project.id} has no ${name} environment`
    const live = environmentOf(project, 'live')
    if (!live) return `${project.id} has no live environment to copy from`
    if (!isNestedDir(live.dir) || !isNestedDir(environment.dir) || siteOf(live.dir) !== siteOf(environment.dir)) {
        return `${project.id} is on a flat site; a copy needs live and ${name} in the nested layout, which each moves into on its next deploy`
    }

    for (const [service, entry] of databasesOf(project)) {
        const dump = dumpPlan(service, entry)
        if (dump !== null && isProblem(dump)) return dump.problem
        const load = loadPlan(service, entry, project.id, databaseNameOf(project, environment))
        if (load !== null && isProblem(load)) return load.problem
    }

    const declared = await environmentServices(project, environment, deps.runner)
    if (!declared.ok) return declared.problem
    const undeclared = undeclaredProblem(project, name, declared.services)
    if (undeclared) return undeclared

    const running = pickPerService(await deps.dockerApi.listProjectContainers(live.composeName))
    for (const [service, entry] of databasesOf(project)) {
        if (!isComposeService(entry)) continue
        if (running.get(service)?.State !== 'running') return `${service} has no running container in live, so there is nothing to copy from`
    }
    return null
}

// Why the site's disk will not take this copy, or null when it will: 10 GiB free beyond the size of live's
// storage, which the copy is about to duplicate, and an estimate of live's databases, which it dumps into
// staging and loads into the environment. Walking a large storage tree takes a while, which is why this is
// the run's first step rather than a refusal the start has to wait for.
export async function spaceProblem(
    project: ProjectEntry, live: EnvironmentEntry, environment: EnvironmentEntry,
    deps: { fs: Pick<CopyFs, 'freeBytes' | 'sizeOf'>, dockerApi: Pick<DockerApi, 'exec' | 'listProjectContainers'>, log(message: string): void },
): Promise<string | null> {
    let storage = 0
    for (const path of storagePathsOf(project)) storage += await deps.fs.sizeOf(posix.join(live.dir, path))
    const databases = await databaseEstimate(project, live, deps)
    const site = siteOf(environment.dir)
    const free = await deps.fs.freeBytes(site)
    if (free >= COPY_MIN_FREE_BYTES + storage + databases) return null
    return `only ${gib(free)} GiB is free under ${site}; a copy needs 10 GiB plus the size of live's storage (${gib(storage)} GiB)`
        + ` and an estimate of its databases (${gib(databases)} GiB)`
}

// Size answers are a line or two; anything longer is not one
const MAX_SIZE_ANSWER = 64 * 1024

// Best effort: each of live's databases asked its own size in its own container (sqlite measured by its
// file). A database that cannot say counts as nothing, and the log says which.
async function databaseEstimate(
    project: ProjectEntry, live: EnvironmentEntry,
    deps: { fs: Pick<CopyFs, 'sizeOf'>, dockerApi: Pick<DockerApi, 'exec' | 'listProjectContainers'>, log(message: string): void },
): Promise<number> {
    const unknown = (service: string, why: string) => {
        deps.log(`WARN copy ${project.id}: ${service}: the size of live's database could not be read, so it counts as nothing towards the space a copy needs: ${why}`)
        return 0
    }
    let containers: Containers | null = null
    let total = 0
    for (const [service, entry] of databasesOf(project)) {
        if (entry.role !== 'database') continue
        if (entry.engine === 'sqlite') {
            total += await deps.fs.sizeOf(posix.join(live.dir, entry.file)).catch(error => unknown(service, describeError(error)))
            continue
        }
        const probe = sizeProbe(service, entry)
        if (probe === null) continue
        if (isProblem(probe)) {
            total += unknown(service, probe.problem)
            continue
        }
        try {
            containers ??= pickPerService(await deps.dockerApi.listProjectContainers(live.composeName))
            const container = containers.get(service)
            if (container?.State !== 'running') {
                total += unknown(service, 'it has no running container in live')
                continue
            }
            const chunks: Buffer[] = []
            let length = 0
            const result = await deps.dockerApi.exec(container.Id, probe, chunk => {
                if (length >= MAX_SIZE_ANSWER) return
                chunks.push(chunk)
                length += chunk.length
            })
            if (result.exitCode !== 0) {
                total += unknown(service, `the size query exited with code ${result.exitCode}: ${tail(result.stderr, 300)}`)
                continue
            }
            const size = parseSize(entry.engine, Buffer.concat(chunks).toString('utf8'))
            total += size ?? unknown(service, 'the size query did not answer with a byte count')
        } catch (error) {
            total += unknown(service, describeError(error))
        }
    }
    return total
}

// Where one run stages: <site>/.copy/<run>, or null when that would be anywhere else. The one folder a
// copy removes recursively, so both the run and the boot sweep ask this rather than building the path.
export function stagingOf(project: ProjectEntry, name: string, run: string): string | null {
    const environment = environmentOf(project, name)
    if (!environment || !isNestedDir(environment.dir)) return null
    const staging = posix.join(siteOf(environment.dir), '.copy', run)
    return STAGING_DIR.test(staging) ? staging : null
}

// At boot, for each run the store has just marked interrupted: its staging holds a copy of live's data,
// so it goes. A run whose environment has since gone from the registry is logged for the operator.
export async function removeInterruptedStaging(
    records: CopyRecord[], registry: Registry, fs: Pick<CopyFs, 'rmdir'>, log: (message: string) => void,
): Promise<void> {
    for (const record of records) {
        const project = registry.projects.get(record.project)
        const staging = project ? stagingOf(project, record.environment, record.run) : null
        if (staging === null) {
            log(`WARN copy ${record.project} ${record.environment} ${record.run} was interrupted, and where it staged could not be worked out; look under the site's .copy folder`)
            continue
        }
        try {
            await fs.rmdir(staging)
            log(`copy ${record.project} ${record.environment} ${record.run} was interrupted; removed ${staging}`)
        } catch (error) {
            log(`WARN copy ${record.project} ${record.environment} ${record.run} was interrupted, and ${staging} could not be removed: ${describeError(error)}`)
        }
    }
}

// The environment's state as the copy found it, and what the copy has changed about it so far: what step 6
// puts back. Filled in as each change is made, so a failure part way puts back exactly what was changed.
type Changed = {
    // The environment's own compose argv, once prepare has begun
    base: string[] | null
    wasRunning: string[]
    // Databases the copy started, to be stopped again
    started: string[]
    // Databases a redis load stopped and has not yet started again
    stopped: Set<string>
}

export async function runCopy(project: ProjectEntry, name: string, run: string, actor: string, deps: CopyDeps): Promise<CopyRecord> {
    const startedAt = deps.now()
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const record: CopyRecord = {
        project: project.id, environment: name, run, actor,
        startedAt: new Date(startedAt).toISOString(), durationMs: 0, outcome: 'running', step: null, reason: null,
        services: databasesOf(project).map(([service]) => service), storage: storagePathsOf(project),
    }
    await deps.store.start(record).catch(error => deps.log(`WARN copy ${project.id} ${name}: the record could not be started: ${describeError(error)}`))

    const live = environmentOf(project, 'live')
    const environment = environmentOf(project, name)
    const where = `copy ${project.id} ${name} ${run}`
    let step = 'dump'
    let failure: { step: string, reason: string } | null = null
    const changed: Changed = { base: null, wasRunning: [], started: [], stopped: new Set() }
    const staging = stagingOf(project, name, run) ?? ''
    const stagingOk = staging !== ''

    try {
        if (!live || !environment || name === 'live') fail(`${project.id} has no ${name} environment to copy into`)
        if (!stagingOk) fail(`refusing to stage copy ${JSON.stringify(run)} anywhere but under the site's .copy folder`)
        const context = { project, live: live!, environment: environment!, staging, deps, sleep, changed }
        step = 'space'
        const space = await spaceProblem(project, live!, environment!, deps)
        if (space) fail(space)
        step = 'dump'
        const dumps = await dumpLive(context)
        step = 'prepare'
        let containers = await prepare(context)
        for (const [service, entry] of databasesOf(project)) {
            if (!isComposeService(entry)) continue
            step = `load:${service}`
            deps.log(`${where}: loading ${service}`)
            containers = await load(context, service, entry, dumps, containers)
        }
        for (const [service, entry] of databasesOf(project)) {
            if (entry.role !== 'database' || entry.engine !== 'sqlite') continue
            step = `sqlite:${service}`
            await copySqlite(context, service, entry.file)
        }
        for (const path of storagePathsOf(project)) {
            step = `storage:${path}`
            await copyStorage(context, path)
        }
    } catch (error) {
        failure = { step, reason: error instanceof StepFailed ? error.message : describeError(error) }
        deps.log(`${where}: failed at ${step}: ${failure.reason}`)
    }

    const restored = await restoreState(changed, deps)
    if (restored !== null) {
        deps.log(`${where}: the environment could not be put back as it was: ${restored}`)
        if (failure === null) failure = { step: 'restore-state', reason: restored }
        else failure.reason += ` Putting the environment back as it was also failed: ${restored}`
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

    if (failure !== null && /^(load|sqlite|storage):/.test(failure.step)) {
        failure.reason += ` The environment may be partly copied; a new copy will overwrite it.`
    }
    const finished: CopyRecord = {
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

type Context = {
    project: ProjectEntry
    live: EnvironmentEntry
    environment: EnvironmentEntry
    staging: string
    deps: CopyDeps
    sleep: (ms: number) => Promise<void>
    changed: Changed
}

// Step 2: each database's dump, as a backup takes it, from live's own running container into staging.
// sqlite is not dumped: step 5 copies it straight across.
async function dumpLive(context: Context): Promise<Map<string, string>> {
    const { project, live, staging, deps } = context
    await deps.fs.mkdir(staging, { private: true })
    const containers = pickPerService(await deps.dockerApi.listProjectContainers(live.composeName))
    const dumps = new Map<string, string>()
    for (const [service, entry] of databasesOf(project)) {
        const plan = dumpPlan(service, entry)
        if (plan === null) continue
        if (isProblem(plan)) fail(plan.problem)
        if (plan.kind === 'sqlite') continue
        if (plan.kind === 'generic') fail(`${service} uses the generic engine, which cannot be copied while live runs; give it a real engine in the registry`)
        if (plan.kind !== 'exec') continue
        const container = containers.get(service)
        if (container?.State !== 'running') fail(`${service} has no running container in live to dump from`)
        const dir = posix.join(staging, service)
        await deps.fs.mkdir(dir, { private: true })
        const file = posix.join(dir, plan.file)
        const { sink, done } = deps.fs.writeStream(file)
        // Handled from the start: a write that fails (a full disk) rejects this long before the exec returns
        done.catch(() => {})
        try {
            const result = await deps.dockerApi.exec(container!.Id, plan.argv, chunk => writeChunk(sink, chunk))
            sink.end()
            await done
            if (result.exitCode !== 0) fail(`${service}: the dump exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`)
        } catch (error) {
            sink.end()
            await done.catch(() => {})
            throw error
        }
        dumps.set(service, file)
    }
    return dumps
}

async function compose(context: Pick<Context, 'deps'>, base: string[], args: string[]): Promise<string | null> {
    const result = await context.deps.runner('docker', [...base, ...args], COMPOSE_TIMEOUT_MS)
    if (result.timedOut) return `compose ${args.join(' ')} timed out`
    if (result.exitCode !== 0) return `compose ${args.join(' ')} exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 300)}`
    return null
}

// Step 3: every service of the environment that is not a registered database stopped (its site services,
// and anything else its compose file runs: a queue worker writes to the databases too), so nothing writes to
// what is being replaced, and its databases running, so there is something to load into. The names come
// from the environment's own compose config, not the registry, which lists only the services it knows.
async function prepare(context: Context): Promise<Containers> {
    const { project, environment, deps, changed } = context
    const location = { dir: environment.dir, composePaths: environment.composePaths, composeName: environment.composeName }
    const resolved = await resolveCompose(location, deps.runner)
    if (!resolved.ok) fail(`the environment's compose file could not be read: ${resolved.problem}`)
    const undeclared = undeclaredProblem(project, environment.name, declaredServices(project, resolved.resolved))
    if (undeclared) fail(undeclared)
    const base = composeBase(location)
    let containers: Containers = pickPerService(await deps.dockerApi.listProjectContainers(environment.composeName))
    const databases = databasesOf(project).filter(([, entry]) => isComposeService(entry)).map(([service]) => service)
    const others = Object.keys(resolved.resolved.services).filter(service => !databases.includes(service))
    changed.base = base
    changed.wasRunning = others.filter(service => containers.get(service)?.State === 'running')

    if (others.length > 0) {
        const stopped = await compose(context, base, ['stop', ...others])
        if (stopped) fail(stopped)
    }
    const stopped = databases.filter(service => containers.get(service)?.State !== 'running')
    if (stopped.length === 0) return containers
    changed.started = stopped
    const up = await compose(context, base, ['up', '-d', '--no-build', '--pull', 'never', ...stopped])
    if (up) fail(up)
    let running = false
    for (let attempt = 0; attempt < WAIT_ATTEMPTS && !running; attempt++) {
        if (attempt > 0) await context.sleep(WAIT_MS)
        containers = pickPerService(await deps.dockerApi.listProjectContainers(environment.composeName))
        running = stopped.every(service => containers.get(service)?.State === 'running')
    }
    if (!running) {
        const late = stopped.filter(service => containers.get(service)?.State !== 'running')
        fail(`${late.join(', ')} did not start in the environment`)
    }
    // Running is not ready: a server the copy has just started can take a while to take connections
    for (const service of stopped) await waitReady(context, service, project.services[service]!, containers.get(service)!.Id)
    return containers
}

// Waits for a database's own readiness probe to answer inside its container, as many times in a row as
// its engine needs (readyPasses), for up to a minute
async function waitReady(context: Context, service: string, entry: ServiceEntry, id: string): Promise<void> {
    const probe = readyProbe(service, entry)
    if (probe === null) return
    if (isProblem(probe)) fail(probe.problem)
    const needed = readyPasses(entry)
    let passes = 0
    let last = ''
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
        if (attempt > 0) await context.sleep(WAIT_MS)
        const result = await context.deps.dockerApi.exec(id, probe as string[], discard)
        if (result.exitCode === 0) {
            if (++passes >= needed) return
            continue
        }
        passes = 0
        last = tail(result.stderr, 300)
    }
    fail(`${service} did not become ready in the environment within ${(WAIT_ATTEMPTS * WAIT_MS) / 1000} seconds${last ? `: ${last}` : ''}`)
}

const discard = () => {}

// Step 4: one dump loaded into the environment's own container
async function load(context: Context, service: string, entry: ServiceEntry, dumps: Map<string, string>, containers: Containers): Promise<Containers> {
    const { project, environment, deps } = context
    const to = databaseNameOf(project, environment)
    const plan = loadPlan(service, entry, project.id, to)
    if (plan === null) return containers
    if (isProblem(plan)) return fail(plan.problem)
    const container = containers.get(service)
    if (container?.State !== 'running') return fail(`${service} is not running in the environment`)
    const dump = dumps.get(service)
    if (dump === undefined) return fail(`${service} has no dump to load`)

    if (plan.kind === 'redis') {
        await loadRedis(context, service, entry, container.Id, dump)
        return containers
    }
    if (plan.kind !== 'exec') return containers

    if (plan.before !== null) {
        // The environment's own databases go first, so every database in the dump is made fresh
        const result = await deps.dockerApi.exec(container.Id, plan.before, discard)
        if (result.exitCode !== 0) fail(`${service}: clearing the environment's databases exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`)
    }

    const input = deps.fs.readStream(dump)
    const stdin: Readable = plan.rename === null ? input : pipeline(input, renameStream(plan.rename, project.id, to), discard)
    const errors = plan.errorFilter === 'postgres' ? postgresErrorCollector() : null
    const result = await deps.dockerApi.exec(container.Id, plan.argv, discard, stdin, errors ? chunk => errors.push(chunk) : undefined)
    if (result.exitCode !== 0) fail(`${service}: the load exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`)
    if (errors !== null && errors.count() > 0) {
        const count = errors.count()
        fail(`${service}: psql reported ${count} error${count === 1 ? '' : 's'}: ${errors.errors().slice(0, 5).join(' | ')}`)
    }
    return containers
}

// redis loads its rdb file at start, so the file is put where the environment's redis reads it (its dir and
// dbfilename), with the service stopped (a redis stopping writes its own dataset over that file) and
// started again after.
async function loadRedis(context: Context, service: string, entry: ServiceEntry, id: string, dump: string): Promise<void> {
    const { deps, changed } = context
    const dir = await redisConfig(context, id, 'dir')
    if (dir === null) fail(`${service}: its data directory could not be read`)
    if (!REDIS_DIR.test(dir!)) fail(`${service}: redis did not name a data directory hostd can copy to`)
    // Under appendonly, redis loads its append-only file at start and never reads dump.rdb
    const appendonly = await redisConfig(context, id, 'appendonly')
    if (appendonly === null) fail(`${service}: whether it runs with appendonly could not be read`)
    if (appendonly === 'yes') fail(`${service} runs redis with appendonly, so replacing its rdb file would not take effect; copy it by hand`)
    const file = await redisConfig(context, id, 'dbfilename')
    if (file === null) fail(`${service}: the name of its data file could not be read`)
    if (!REDIS_FILE.test(file!)) fail(`${service}: redis did not name a data file hostd can copy to`)

    const base = changed.base!
    const stopped = await compose(context, base, ['stop', service])
    if (stopped) fail(stopped)
    changed.stopped.add(service)
    const copied = await deps.runner('docker', ['cp', dump, `${checkedId(id)}:${posix.join(dir!, file!)}`], COMPOSE_TIMEOUT_MS)
    if (copied.exitCode !== 0 || copied.timedOut) fail(`${service}: docker cp exited with code ${copied.exitCode}: ${tail(copied.stderr.trim(), 300)}`)
    const started = await compose(context, base, ['start', service])
    if (started) fail(started)
    changed.stopped.delete(service)
    // A redis that cannot read the file it was given (an owner it may not read, say) exits at start
    await waitReady(context, service, entry, id)
}

// One setting of the environment's redis, or null when it could not be read
async function redisConfig(context: Context, id: string, key: 'dir' | 'appendonly' | 'dbfilename'): Promise<string | null> {
    const chunks: Buffer[] = []
    const asked = await context.deps.dockerApi.exec(id, ['sh', '-c', `redis-cli CONFIG GET ${key}`], chunk => { chunks.push(chunk) })
    if (asked.exitCode !== 0) return null
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    return lines[0] === key && lines[1] !== undefined ? lines[1] : null
}

// Moves whatever is at <path>.hostd-copy (left by an earlier version of the copy, which wrote beside the
// target, or committed there) into staging, where it is removed with the rest. lkind, not exists: a
// symlink there, dangling or not, is moved as the link itself (rename never follows it), never followed.
async function setAsideLeftover(context: Context, path: string, relative: string): Promise<void> {
    const { staging, deps } = context
    if ((await deps.fs.lkind(path)) === 'none') return
    const aside = posix.join(staging, 'leftover', relative)
    await deps.fs.mkdir(posix.dirname(aside), { private: true })
    await move(context, path, aside)
}

// The environment's side of the copy, in the helper: the site folder mounted (no client container
// mounts it, only the environments inside it), with live's folder masked read-only over its own place,
// so a swapped-in symlink can reach neither another site nor live. Each is mounted at its own path, so
// a symlink the site's checkout has always had, absolute or not, resolves as it does on the host as long
// as it stays in the site. Every path given is under the site.
async function inSite(context: Context, argv: (inside: (path: string) => string) => string[], what: string): Promise<void> {
    const { live, environment, deps } = context
    const site = siteOf(environment.dir)
    const inside = (path: string): string => {
        if (!isWithin(site, path)) fail(`${path} is not under the site's folder ${site}`)
        return path
    }
    const mounts = [{ source: site, target: site }, { source: live.dir, target: live.dir, readOnly: true }]
    const result = await deps.helper(mounts, argv(inside), COMPOSE_TIMEOUT_MS)
    if (result.exitCode !== 0 || result.timedOut) fail(`${what}: ${result.timedOut ? 'timed out' : tail(result.stderr.trim(), 300)}`)
}

// A plain rename, within one site folder: never follows a symlink at either end
function move(context: Context, from: string, to: string): Promise<void> {
    return inSite(context, inside => renameArgv(inside(from), inside(to)), `${from} could not be moved to ${to}`)
}

// A symlink in the environment's checkout (committed to the repo, say) could lead a path the copy writes to
// out of the environment, and into live. So before anything is set aside, made or moved, every folder that
// already exists along the way (a symlink, dangling or not, counts as existing) is resolved, and each must
// be inside the environment's own folder and not inside live's; one that cannot be resolved (a dangling
// symlink) is refused too. Called again once the parents are made, on the folder the target goes in. The
// target itself is never written through: what is there is renamed into staging, and the new copy is
// renamed in from staging.
async function confine(context: Context, relative: string, depths: 'all' | 'parent' = 'all'): Promise<void> {
    const { live, environment, deps } = context
    const root = await deps.fs.realpath(environment.dir)
    const liveRoot = await deps.fs.realpath(live.dir)
    const parents = posix.dirname(relative) === '.' ? [] : posix.dirname(relative).split('/')
    for (let depth = depths === 'all' ? 0 : parents.length; depth <= parents.length; depth++) {
        const dir = posix.join(environment.dir, ...parents.slice(0, depth))
        if ((await deps.fs.lkind(dir)) === 'none') break
        let real: string
        try {
            real = await deps.fs.realpath(dir)
        } catch (error) {
            fail(`${relative} could not be resolved (through ${dir}: ${describeError(error)}), so the copy will not touch it`)
        }
        if (!isWithin(root, real) || isWithin(liveRoot, real)) {
            fail(`${relative} resolves outside the environment's folder (through ${dir}, to ${real}), so the copy will not touch it`)
        }
    }
}

// Where live's own <relative> really is, which must be inside live's folder: a symlink in live's checkout
// (committed to the repo, say, as storage -> /var/www/<other site>/live/storage) would otherwise have the
// copy read another site's files or database into this one's environment. The caller has checked the path
// exists.
async function liveSource(context: Context, relative: string): Promise<string> {
    const { live, deps } = context
    const root = await deps.fs.realpath(live.dir)
    let real: string
    try {
        real = await deps.fs.realpath(posix.join(live.dir, relative))
    } catch (error) {
        fail(`live's ${relative} could not be resolved: ${describeError(error)}`)
    }
    if (!isWithin(root, real)) fail(`live's ${relative} resolves outside live's folder (to ${real}), so the copy will not read it`)
    return real
}

// Live's own folder, still there: a copy reads from it to the end, and a folder that has gone is a failure
// rather than nothing to copy
async function requireLive(context: Context): Promise<void> {
    const { live, deps } = context
    if (!(await deps.fs.exists(live.dir))) fail(`live's folder ${live.dir} is gone, so there is nothing to copy from`)
}

// The folders above something the copy is about to put into the environment, made one level at a time
// and each owned like the environment's tree, as a deploy's carry makes them: the agent's own umask would
// otherwise leave them unreadable to the site. Made in the helper, where mkdir fails on anything already
// there rather than going through it.
async function ensureParents(context: Context, relative: string): Promise<void> {
    const { environment, deps } = context
    const parents = posix.dirname(relative) === '.' ? [] : posix.dirname(relative).split('/')
    let like: Like | null = null
    for (let depth = 1; depth <= parents.length; depth++) {
        const dir = posix.join(environment.dir, ...parents.slice(0, depth))
        // A symlink there, dangling or not, is left for confine to judge, never made or owned through
        if ((await deps.fs.lkind(dir)) !== 'none') continue
        const owned = like ??= await deps.fs.owner(environment.dir)
        await inSite(context, inside => mkdirArgv(inside(dir), owned), `${dir} could not be made`)
    }
}

// Step 5, sqlite: .backup is safe against live writing as it runs. It writes into the run's own private
// staging, never through a path under the environment's checkout, and the copy is renamed into place from
// there (staging is in the same site folder, so on the same filesystem). The environment's own file, and
// any journal beside it that belongs to that file and not the new one, go into staging first.
async function copySqlite(context: Context, service: string, file: string): Promise<void> {
    const { live, environment, staging, deps } = context
    const target = posix.join(environment.dir, file)
    await requireLive(context)
    if (!(await deps.fs.exists(posix.join(live.dir, file)))) fail(`${service}: live has no ${file}`)
    // Read at the path it resolves to, which is inside live's folder, and with nothing beside it that
    // sqlite3 would open through a symlink
    const source = await liveSource(context, file)
    const linked = await linkedSideFile(source, deps.fs)
    if (linked) fail(`live's ${linked} is a symlink, and sqlite3 would open it beside the database, so the copy will not read it`)
    await confine(context, file)
    await setAsideLeftover(context, `${target}${COPY_ASIDE}`, posix.join('sqlite', service))
    await ensureParents(context, file)
    await confine(context, file, 'parent')
    const parent = posix.dirname(target)

    const fresh = posix.join(staging, 'new', 'sqlite', service)
    await deps.fs.mkdir(fresh, { private: true })
    const copy = posix.join(fresh, posix.basename(target))
    const backed = await sqliteBackup(source, copy, deps, COPY_TIMEOUT_MS)
    if (backed === 'changed') fail(`${service}: ${posix.dirname(source)} changed before sqlite3 could read it, so the copy did not read it`)
    if (backed !== null) fail(`${service}: ${backed}`)
    if ((await deps.fs.lkind(copy)) !== 'file') fail(`${service}: sqlite3 did not leave a file at ${copy}`)
    // sqlite3 runs as root, and the site's own user has to be able to write the file: owned like the file
    // it replaces (and moded like it), or like the folder it goes in when there was none. A symlink at the
    // target is not a file of the environment's own to take an owner from: it is set aside like one.
    const had = (await deps.fs.lkind(target)) === 'file'
    const like = await deps.fs.owner(had ? target : parent)
    await deps.fs.chown(copy, like.uid, like.gid)
    if (had) await deps.fs.chmod(copy, like.mode)

    const old = posix.join(staging, 'old', 'sqlite', service)
    await deps.fs.mkdir(old, { private: true })
    // Each move is remembered, so a failure part way puts the environment's own files back rather than
    // leaving them in staging for the clean step to delete
    const moved: Array<{ from: string, to: string }> = []
    try {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            const from = `${target}${suffix}`
            // Whatever is there, a symlink included, is moved as itself
            if ((await deps.fs.lkind(from)) === 'none') continue
            const to = posix.join(old, `${posix.basename(target)}${suffix}`)
            await move(context, from, to)
            moved.push({ from, to })
        }
        await move(context, copy, target)
    } catch (error) {
        for (const { from, to } of moved.reverse()) {
            await move(context, to, from).catch(undo => deps.log(`copy ${environment.dir}: ${to} could not be moved back to ${from}: ${describeError(undo)}`))
        }
        throw error
    }
}

// Step 5, storage: live's folder copied into the run's own private staging, the environment's own moved
// into staging, and the copy renamed into its place, so nothing is ever written through a path under the
// environment's checkout. The copy keeps the owners cp -a kept from live, as a deploy's storage carry does:
// containers often write as their own user (www-data, say), which the environment's tree owner is not.
// Only a parent folder the copy had to make is owned like the environment's tree. cp -a copies a symlink
// as a link, the storage folder itself included when it is one, so a link inside live's folder is carried
// into the environment pointing wherever it pointed in live.
async function copyStorage(context: Context, path: string): Promise<void> {
    const { live, environment, staging, deps } = context
    const source = posix.join(live.dir, path)
    const target = posix.join(environment.dir, path)
    await requireLive(context)
    if (!(await deps.fs.exists(source))) {
        deps.log(`copy ${environment.dir}: live has no ${path}, so the environment's is left as it is`)
        return
    }
    // Checked, but cp is given the path as live has it: the folder's own link, if it is one, is carried
    await liveSource(context, path)
    await confine(context, path)
    await setAsideLeftover(context, `${target}${COPY_ASIDE}`, path)
    await ensureParents(context, path)
    await confine(context, path, 'parent')

    const copy = posix.join(staging, 'new', 'storage', path)
    await deps.fs.mkdir(posix.dirname(copy), { private: true })
    // In the helper, with only live's folder (read-only, at its own path, so a symlink live has always had
    // inside itself still resolves) and this copy's own staging folder mounted
    const copied = await deps.helper(
        [{ source: live.dir, target: live.dir, readOnly: true }, { source: posix.dirname(copy), target: '/stage' }],
        ['cp', '-a', source, posix.join('/stage', posix.basename(copy))],
        COPY_TIMEOUT_MS,
    )
    if (copied.exitCode !== 0 || copied.timedOut) fail(`cp exited with code ${copied.exitCode}: ${tail(copied.stderr.trim(), 500)}`)

    const old = posix.join(staging, 'old', path)
    // Whatever is at the target, a symlink included, is moved aside as itself
    const had = (await deps.fs.lkind(target)) !== 'none'
    if (had) {
        await deps.fs.mkdir(posix.dirname(old), { private: true })
        await move(context, target, old)
    }
    try {
        await move(context, copy, target)
    } catch (error) {
        // The environment's own folder goes back rather than leaving it with none
        if (had) await move(context, old, target).catch(() => {})
        throw error
    }
}

// Step 6: whatever the copy changed about which services run, put back. Answers null, or what failed.
async function restoreState(changed: Changed, deps: CopyDeps): Promise<string | null> {
    if (changed.base === null) return null
    const base = changed.base
    const problems: string[] = []
    const start = [...changed.wasRunning, ...[...changed.stopped].filter(service => !changed.started.includes(service))]
    if (start.length > 0) {
        const started = await compose({ deps }, base, ['start', ...start]).catch(error => describeError(error))
        if (started) problems.push(started)
    }
    if (changed.started.length > 0) {
        const stopped = await compose({ deps }, base, ['stop', ...changed.started]).catch(error => describeError(error))
        if (stopped) problems.push(stopped)
    }
    return problems.length === 0 ? null : problems.join('; ')
}
