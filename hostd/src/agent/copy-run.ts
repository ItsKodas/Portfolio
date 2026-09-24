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

import { posix } from 'node:path'
import { pipeline, type Readable, type Writable } from 'node:stream'

import { describeError } from '../shared/formats.ts'
import { isNestedDir, siteOf } from '../shared/layout.ts'
import { environmentOf, isComposeService, type EnvironmentEntry, type ProjectEntry, type ServiceEntry } from '../shared/registry.ts'
import type { CopyRecord } from '../shared/protocol.ts'
import { composeBase, tail, type Runner } from './compose.ts'
import { checkedId, pickPerService, type ContainerSummary, type DockerApi } from './docker.ts'
import { dumpPlan, isProblem } from './backup-dumps.ts'
import { loadPlan, postgresErrorCollector, renameStream, type RenameEngine } from './copy-plans.ts'
import { MIN_FREE_BYTES } from './deploy.ts'

// The same margin a deploy keeps, on top of what the copy of live's storage is about to take
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
// Beside the environment's own file or folder while it is being copied in
const COPY_ASIDE = '.hostd-copy'
// What the environment's redis says its data directory is: an absolute path, and nothing a shell or
// docker cp could read as anything else
const REDIS_DIR = /^\/[A-Za-z0-9._/-]{0,255}$/

type Like = { uid: number, gid: number, mode: number }

export type CopyFs = {
    // Recursive. private: 0700, for staging, which holds a copy of the client's data
    mkdir(dir: string, options?: { private?: boolean }): Promise<void>
    // A plain rename, within one site folder
    move(from: string, to: string): Promise<void>
    // Recursive: only ever the staging folder, checked first
    rmdir(dir: string): Promise<void>
    exists(path: string): Promise<boolean>
    owner(path: string): Promise<Like>
    own(dir: string, like: Like): Promise<void>
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

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

// Why a copy into this environment may not start, or null when it may. Reads only: nothing is changed
// before a copy has passed every check. The agent refuses a busy environment, and a running backup, itself.
export async function copyRefusal(
    project: ProjectEntry, name: string, deps: { dockerApi: Pick<DockerApi, 'listProjectContainers'>, fs: Pick<CopyFs, 'freeBytes' | 'sizeOf'> },
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

    const running = pickPerService(await deps.dockerApi.listProjectContainers(live.composeName))
    for (const [service, entry] of databasesOf(project)) {
        if (!isComposeService(entry)) continue
        if (running.get(service)?.State !== 'running') return `${service} has no running container in live, so there is nothing to copy from`
    }

    let storage = 0
    for (const path of storagePathsOf(project)) storage += await deps.fs.sizeOf(posix.join(live.dir, path))
    const site = siteOf(environment.dir)
    const free = await deps.fs.freeBytes(site)
    if (free < COPY_MIN_FREE_BYTES + storage) {
        return `only ${gib(free)} GiB is free under ${site}; a copy needs 10 GiB plus the size of live's storage (${gib(storage)} GiB)`
    }
    return null
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
    const staging = environment ? posix.join(siteOf(environment.dir), '.copy', run) : ''
    const stagingOk = environment !== null && STAGING_DIR.test(staging)

    try {
        if (!live || !environment || name === 'live') fail(`${project.id} has no ${name} environment to copy into`)
        if (!stagingOk) fail(`refusing to stage a copy at ${JSON.stringify(staging)}`)
        const context = { project, live: live!, environment: environment!, staging, deps, sleep, changed }
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
        try {
            const result = await deps.dockerApi.exec(container!.Id, plan.argv, chunk => {
                if (!sink.write(chunk)) return new Promise<void>(resolve => sink.once('drain', () => resolve()))
            })
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

// Step 3: the environment's site services stopped, so nothing writes to what is being replaced, and its
// databases running, so there is something to load into.
async function prepare(context: Context): Promise<Containers> {
    const { project, environment, deps, changed } = context
    const base = composeBase({ dir: environment.dir, composePaths: environment.composePaths, composeName: environment.composeName })
    let containers: Containers = pickPerService(await deps.dockerApi.listProjectContainers(environment.composeName))
    const sites = Object.entries(project.services).filter(([, entry]) => entry.role === 'site').map(([service]) => service)
    const databases = databasesOf(project).filter(([, entry]) => isComposeService(entry)).map(([service]) => service)
    changed.base = base
    changed.wasRunning = sites.filter(service => containers.get(service)?.State === 'running')

    if (sites.length > 0) {
        const stopped = await compose(context, base, ['stop', ...sites])
        if (stopped) fail(stopped)
    }
    const stopped = databases.filter(service => containers.get(service)?.State !== 'running')
    if (stopped.length === 0) return containers
    changed.started = stopped
    const up = await compose(context, base, ['up', '-d', '--no-build', '--pull', 'never', ...stopped])
    if (up) fail(up)
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
        if (attempt > 0) await context.sleep(WAIT_MS)
        containers = pickPerService(await deps.dockerApi.listProjectContainers(environment.composeName))
        if (stopped.every(service => containers.get(service)?.State === 'running')) return containers
    }
    const late = stopped.filter(service => containers.get(service)?.State !== 'running')
    return fail(`${late.join(', ')} did not start in the environment`)
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
        await loadRedis(context, service, container.Id, dump)
        return containers
    }
    if (plan.kind !== 'exec') return containers

    if (plan.before !== null) {
        // A database the copy has only just started can take a few seconds to take connections
        for (let attempt = 1; ; attempt++) {
            const result = await deps.dockerApi.exec(container.Id, plan.before, discard)
            if (result.exitCode === 0) break
            if (attempt >= WAIT_ATTEMPTS) fail(`${service}: clearing the old database exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`)
            await context.sleep(WAIT_MS)
        }
    }

    const input = deps.fs.readStream(dump)
    const stdin: Readable = plan.rename
        ? pipeline(input, renameStream(entry.role === 'database' ? entry.engine as RenameEngine : 'postgres', project.id, to), discard)
        : input
    const errors = plan.errorFilter === 'postgres' ? postgresErrorCollector() : null
    const result = await deps.dockerApi.exec(container.Id, plan.argv, discard, stdin, errors ? chunk => errors.push(chunk) : undefined)
    if (result.exitCode !== 0) fail(`${service}: the load exited with code ${result.exitCode}: ${tail(result.stderr, 500)}`)
    if (errors !== null && errors.count() > 0) {
        const count = errors.count()
        fail(`${service}: psql reported ${count} error${count === 1 ? '' : 's'}: ${errors.errors().slice(0, 5).join(' | ')}`)
    }
    return containers
}

// redis loads its rdb file at start, so the file is put where the environment's redis reads it, with the
// service stopped (a redis stopping writes its own dataset over that file) and started again after.
async function loadRedis(context: Context, service: string, id: string, dump: string): Promise<void> {
    const { deps, changed } = context
    const chunks: Buffer[] = []
    const asked = await deps.dockerApi.exec(id, ['sh', '-c', 'redis-cli CONFIG GET dir'], chunk => { chunks.push(chunk) })
    if (asked.exitCode !== 0) fail(`${service}: its data directory could not be read: ${tail(asked.stderr, 300)}`)
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    const dir = lines[0] === 'dir' ? lines[1] : undefined
    if (dir === undefined || !REDIS_DIR.test(dir)) fail(`${service}: redis did not name a data directory hostd can copy to`)

    const base = changed.base!
    const stopped = await compose(context, base, ['stop', service])
    if (stopped) fail(stopped)
    changed.stopped.add(service)
    const copied = await deps.runner('docker', ['cp', dump, `${checkedId(id)}:${posix.join(dir!, 'dump.rdb')}`], COMPOSE_TIMEOUT_MS)
    if (copied.exitCode !== 0 || copied.timedOut) fail(`${service}: docker cp exited with code ${copied.exitCode}: ${tail(copied.stderr.trim(), 300)}`)
    const started = await compose(context, base, ['start', service])
    if (started) fail(started)
    changed.stopped.delete(service)
}

// Moves a leftover from an earlier copy that stopped part way into staging, where it is removed with the
// rest, rather than copying into it or deleting it where it is.
async function setAsideLeftover(context: Context, path: string, relative: string): Promise<void> {
    const { staging, deps } = context
    if (!(await deps.fs.exists(path))) return
    const aside = posix.join(staging, 'leftover', relative)
    await deps.fs.mkdir(posix.dirname(aside), { private: true })
    await deps.fs.move(path, aside)
}

// Step 5, sqlite: .backup is safe against live writing as it runs. The environment's own file, and any
// journal beside it that belongs to that file and not the new one, go into staging.
async function copySqlite(context: Context, service: string, file: string): Promise<void> {
    const { live, environment, staging, deps } = context
    const source = posix.join(live.dir, file)
    const target = posix.join(environment.dir, file)
    const copy = `${target}${COPY_ASIDE}`
    if (!(await deps.fs.exists(source))) fail(`${service}: live has no ${file}`)
    await setAsideLeftover(context, copy, posix.join('sqlite', service))
    const parent = posix.dirname(target)
    if (!(await deps.fs.exists(parent))) await deps.fs.mkdir(parent)

    const backed = await deps.runner('sqlite3', [source, `.backup ${copy}`], COPY_TIMEOUT_MS)
    if (backed.exitCode !== 0 || backed.timedOut) fail(`${service}: sqlite3 exited with code ${backed.exitCode}: ${tail(backed.stderr.trim(), 500)}`)
    // sqlite3 runs as root, and the site's own user has to be able to write the file
    const had = await deps.fs.exists(target)
    const reference = had ? target : parent
    for (const command of had ? ['chown', 'chmod'] : ['chown']) {
        const result = await deps.runner(command, [`--reference=${reference}`, copy], COMPOSE_TIMEOUT_MS)
        if (result.exitCode !== 0) fail(`${service}: ${command} exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 300)}`)
    }

    const old = posix.join(staging, 'old', 'sqlite', service)
    await deps.fs.mkdir(old, { private: true })
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (await deps.fs.exists(`${target}${suffix}`)) await deps.fs.move(`${target}${suffix}`, posix.join(old, `${posix.basename(target)}${suffix}`))
    }
    await deps.fs.move(copy, target)
}

// Step 5, storage: live's folder copied beside the environment's, the environment's own moved into
// staging, and the copy moved into its place and owned like the rest of the environment's tree.
async function copyStorage(context: Context, path: string): Promise<void> {
    const { live, environment, staging, deps } = context
    const source = posix.join(live.dir, path)
    const target = posix.join(environment.dir, path)
    const copy = `${target}${COPY_ASIDE}`
    if (!(await deps.fs.exists(source))) {
        deps.log(`copy ${environment.dir}: live has no ${path}, so the environment's is left as it is`)
        return
    }
    await setAsideLeftover(context, copy, path)
    const parent = posix.dirname(target)
    if (!(await deps.fs.exists(parent))) await deps.fs.mkdir(parent)

    const copied = await deps.runner('cp', ['-a', source, copy], COPY_TIMEOUT_MS)
    if (copied.exitCode !== 0 || copied.timedOut) fail(`cp exited with code ${copied.exitCode}: ${tail(copied.stderr.trim(), 500)}`)

    const old = posix.join(staging, 'old', path)
    const had = await deps.fs.exists(target)
    if (had) {
        await deps.fs.mkdir(posix.dirname(old), { private: true })
        await deps.fs.move(target, old)
    }
    try {
        await deps.fs.move(copy, target)
    } catch (error) {
        // The environment's own folder goes back rather than leaving it with none
        if (had) await deps.fs.move(old, target).catch(() => {})
        throw error
    }
    await deps.fs.own(target, await deps.fs.owner(environment.dir))
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
