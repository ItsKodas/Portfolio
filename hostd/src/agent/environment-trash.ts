// Deleting an environment into its site's trash, restoring it from there, and purging it after 30 days.
//
// A delete is a soft one: the environment is stopped (never with -v), taken off the web, and its folders
// are renamed into <site>/.deleted/<env>-<unix seconds>/{tree, prev, next}. Its registry node is kept in
// the deleted environments record, and only then is it unregistered. Nothing is deleted before its
// replacement is in place: every step here is a rename or a write that the step before it can undo, and a
// failure undoes in reverse whatever succeeded. An undo that cannot finish stops where it is and says what
// is left, rather than carrying on over a state it no longer understands, and it never deletes anything
// to get out of one.
//
// The purge is the one recursive delete, and it only ever targets a folder under <site>/.deleted/.

import { posix } from 'node:path'

import { COMPOSE_NAME, describeError } from '../shared/formats.ts'
import { deployKey } from '../shared/deploys.ts'
import { hostnamesOf, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { isFlatDir, isNestedDir, siteOf } from '../shared/layout.ts'
import type { PortVerdict } from '../shared/ports.ts'
import type { Change } from '../shared/registry-write.ts'
import { refuse, type AgentReply, type DeletedEnvironment, type Refusal, type RestoreEnvironmentReply } from '../shared/protocol.ts'
import type { ComposeLocation, Runner } from './compose.ts'
import { deployTrees, downArgv, locationIn, runCompose, upArgv, SWAP_TIMEOUT_MS } from './deploy-compose.ts'
import type { PortOverrideResult } from './port-override.ts'
import { DELETED_KEEP_MS, type DeletedRecord, type DeletedStore } from './deleted-store.ts'

// Listing and removing a compose project's volumes: quick calls, but Docker can be slow under load.
const VOLUME_TIMEOUT_MS = 60_000
// Where a trash folder may be, and nowhere else: one site folder under /var/www, its .deleted folder, and
// one <env>-<unix seconds> inside it. The purge refuses any recorded path that is not exactly this shape.
const TRASH_DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/\.deleted\/[a-z][a-z0-9]{0,15}-\d{1,12}$/

type Done = { ok: true } | { ok: false, message: string }

// The vhost hostd wrote for an environment. read answers null when hostd never wrote one, which is not an
// error: that environment is served by hand, or not at all. put writes back exactly the text read, which
// is how a delete's undo puts a removed vhost back without minting a token only api may mint.
export type TrashVhosts = {
    read(project: ProjectEntry, environment: EnvironmentEntry): Promise<string | null>
    remove(project: ProjectEntry, environment: EnvironmentEntry): Promise<Done>
    put(project: ProjectEntry, environment: EnvironmentEntry, text: string): Promise<Done>
    write(project: ProjectEntry, environment: EnvironmentEntry, token: string): Promise<Done>
}

export type TrashDeps = {
    registry(): Registry
    refreshRegistry(): Promise<void>
    // Why the registry store rejected the file on its last reload, or null when it did not. A reload
    // never throws: it keeps the last good snapshot, which may no longer list an environment that now
    // runs under a recorded compose name, so the purge trusts none of it while this answers a reason.
    registryRejection(): string | null
    writer: {
        write(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
        environmentNode(id: string, environment: EnvironmentName): Promise<Record<string, unknown> | null>
    }
    store: Pick<DeletedStore, 'list' | 'add' | 'update' | 'remove'> & Partial<Pick<DeletedStore, 'unwritable'>>
    fs: {
        exists(path: string): Promise<boolean>
        // Never recursive
        mkdir(dir: string): Promise<void>
        // A plain rename, only ever within one site folder
        move(from: string, to: string): Promise<void>
        // Recursive: the purge's alone
        rmdir(dir: string): Promise<void>
        // Not recursive: the kernel refuses a folder that is not empty
        removeEmptyDir(dir: string): Promise<void>
        owner(path: string): Promise<{ uid: number, gid: number, mode: number }>
        own(dir: string, like: { uid: number, gid: number, mode: number }): Promise<void>
        // The purge compares it with the recorded path before its recursive delete
        realpath(path: string): Promise<string>
    }
    // The docker CLI: compose down and up, and the volume listing and removal a purge runs
    runner: Runner
    // null when nothing wired the Apache rail up, so hostd has never written a vhost for anything
    vhosts: TrashVhosts | null
    checkPort(port: number): Promise<PortVerdict>
    choosePort(): Promise<{ ok: true, port: number } | { ok: false, problem: string }>
    setPortEnv(environment: EnvironmentEntry, key: string, port: number): Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>
    restorePortEnv(environment: EnvironmentEntry, previous: string | null): Promise<{ ok: true } | { ok: false, problem: string }>
    portOverride(location: ComposeLocation, portEnv: string): Promise<PortOverrideResult>
    now(): number
    log(message: string): void
}

// One step that has happened, and how to take it back. undo throws when it cannot.
type Step = { what: string, undo: () => Promise<void> }

// Takes back every step in reverse. Answers null once all of them are undone, otherwise what is still
// done, starting with the step whose undo failed: nothing after that one is attempted.
async function unwind(steps: Step[], log: (message: string) => void): Promise<string | null> {
    for (let at = steps.length - 1; at >= 0; at--) {
        const step = steps[at]!
        try {
            await step.undo()
        } catch (error) {
            const left = steps.slice(0, at + 1).reverse().map(entry => entry.what)
            log(`the undo stopped at "${step.what}": ${describeError(error)}`)
            return `The undo stopped at "${step.what}" (${describeError(error)}) and nothing was deleted; still done: ${left.join('; ')}.`
        }
    }
    return null
}

const ensure = (done: Done, what: string): void => {
    if (!done.ok) throw new Error(`${what}: ${done.message}`)
}

// Where an environment's trash goes: its own site's for a nested one, and live's site for a flat one
// beside a nested live. Null for a flat environment beside a flat live, which has no site folder yet.
function siteFor(project: ProjectEntry, environment: EnvironmentEntry): string | null {
    if (isNestedDir(environment.dir)) return siteOf(environment.dir)
    const live = project.environments.get('live')
    return live && isNestedDir(live.dir) ? siteOf(live.dir) : null
}

// The environment an entry in the record describes, enough for the compose and .env calls a restore
// makes before the registry has it back
function entryFrom(name: EnvironmentName, node: Record<string, unknown>, composeName: string, port: number): EnvironmentEntry {
    const dir = node.dir as string
    const compose = Array.isArray(node.compose) ? node.compose.map(String)
        : typeof node.compose === 'string' ? [node.compose] : ['docker-compose.yml']
    return {
        name, dir, composePaths: compose.map(file => posix.join(dir, file)), composeName,
        branch: typeof node.branch === 'string' ? node.branch : null,
        domain: null, aliases: [], port, certificate: null, deployed: null, websockets: false, flexibleSsl: false,
    }
}

const purgeAtOf = (deletedAt: string): string => new Date(Date.parse(deletedAt) + DELETED_KEEP_MS).toISOString()

export async function deleteEnvironment(project: ProjectEntry, name: EnvironmentName, actor: string, deps: TrashDeps): Promise<AgentReply> {
    if (name === 'live') return refuse('bad-request', 'the live environment cannot be deleted; remove the whole site instead')
    const environment = project.environments.get(name)
    if (!environment) return refuse('unknown-environment', `${project.id} has no ${name} environment`)
    const site = siteFor(project, environment)
    if (!site) return refuse('bad-request', `${project.id} live is still in the flat layout; deploy it once so it moves into the nested layout, then delete ${name}`)
    if (!(await deps.fs.exists(environment.dir))) return refuse('failed', `${environment.dir} is not there to move into the trash`)
    const node = await deps.writer.environmentNode(project.id, name)
    if (!node) return refuse('failed', `${project.id} ${name} could not be read out of the registry`)

    const at = deps.now()
    const deletedAt = new Date(at).toISOString()
    const deleted = posix.join(site, '.deleted')
    const trash = posix.join(deleted, `${name}-${Math.floor(at / 1000)}`)
    if (await deps.fs.exists(trash)) return refuse('busy', `${trash} already exists; try again in a second`)

    const trees = deployTrees(environment.dir)
    const location = locationIn(environment, environment.dir)
    const steps: Step[] = []
    const id = `${project.id} ${name}`

    const down = await runCompose(downArgv(location, environment.composeName), SWAP_TIMEOUT_MS, deps.runner)
    if (!down.ok) return refuse('failed', `could not stop ${id}: ${down.message}`, down.output)
    deps.log(`delete ${id}: stopped`)
    steps.push({
        what: `stopped ${id}`,
        undo: async () => {
            const up = await runCompose(upArgv(location, environment.composeName), SWAP_TIMEOUT_MS, deps.runner)
            if (!up.ok) throw new Error(`up ${up.message}`)
        },
    })

    try {
        // Off the web before anything moves, so its hostnames stop proxying to a port that is about to
        // be free for someone else
        const vhosts = deps.vhosts
        const previous = vhosts ? await vhosts.read(project, environment) : null
        if (vhosts && previous !== null) {
            ensure(await vhosts.remove(project, environment), `the vhost for ${id} could not be removed`)
            steps.push({
                what: `removed the vhost for ${id}`,
                undo: async () => ensure(await vhosts.put(project, environment, previous), 'the vhost could not be put back'),
            })
        }

        // Made like the site, so the operator can read what is in the trash as they can the site itself
        const like = await deps.fs.owner(site)
        for (const dir of [deleted, trash]) {
            if (await deps.fs.exists(dir)) continue
            await deps.fs.mkdir(dir)
            steps.push({ what: `made ${dir}`, undo: () => deps.fs.removeEmptyDir(dir) })
            await deps.fs.own(dir, like)
        }

        const moves: Array<[string, string]> = [[environment.dir, posix.join(trash, 'tree')]]
        for (const [from, to] of [[trees.prev, 'prev'], [trees.next, 'next']] as const) {
            if (await deps.fs.exists(from)) moves.push([from, posix.join(trash, to)])
        }
        for (const [from, to] of moves) {
            await deps.fs.move(from, to)
            steps.push({ what: `moved ${from} to ${to}`, undo: () => deps.fs.move(to, from) })
        }

        const record: DeletedRecord = { project: project.id, environment: name, deletedAt, trash, composeName: environment.composeName, node, actor }
        await deps.store.add(record)
        steps.push({ what: `recorded ${id} as deleted`, undo: () => deps.store.remove(project.id, name, deletedAt) })

        const written = await deps.writer.write({ kind: 'remove-environment', id: project.id, environment: name })
        if (!written.ok) throw new Error(written.problem)
    } catch (error) {
        const problem = `could not delete ${id}: ${describeError(error)}`
        deps.log(`delete ${problem}`)
        const left = await unwind(steps, deps.log)
        return refuse('failed', left === null ? `${problem}. Everything was put back.` : `${problem}. ${left}`)
    }

    try {
        await deps.refreshRegistry()
    } catch (error) {
        deps.log(`delete ${id}: the registry could not be reloaded: ${describeError(error)}`)
    }
    deps.log(`delete ${id}: moved to ${trash}`)
    return { ok: true, output: `${id} was stopped and moved to ${trash}; it can be restored until ${purgeAtOf(deletedAt)}` }
}

export async function restoreEnvironment(
    project: ProjectEntry, name: EnvironmentName, deletedAt: string, token: string | null, deps: TrashDeps,
): Promise<RestoreEnvironmentReply | Refusal> {
    const id = `${project.id} ${name}`
    if (name === 'live') return refuse('bad-request', 'the live environment is never restored')
    const record = deps.store.list(project.id).find(entry => entry.environment === name && entry.deletedAt === deletedAt)
    if (!record) return refuse('bad-request', `${project.id} has no ${name} deleted at ${deletedAt}`)

    await deps.refreshRegistry()
    const registry = deps.registry()
    const current = registry.projects.get(project.id) ?? project
    if (current.environments.has(name)) return refuse('bad-request', `${project.id} already has a ${name} environment again; delete it first to restore this one`)
    if (deps.now() - Date.parse(deletedAt) > DELETED_KEEP_MS) {
        return refuse('bad-request', `${id} was deleted more than 30 days ago and is waiting to be purged`)
    }
    const tree = posix.join(record.trash, 'tree')
    if (!(await deps.fs.exists(tree))) return refuse('failed', `the trash folder ${tree} is gone, so there is nothing to restore`)

    const node = record.node
    const dir = node.dir
    if (typeof dir !== 'string' || !(isNestedDir(dir) || isFlatDir(dir))) return refuse('failed', `the record for ${id} names no usable folder`)
    if (await deps.fs.exists(dir)) return refuse('bad-request', `${dir} exists; move it away before restoring ${id}`)

    // The port it had, if nothing took it meanwhile. A host that cannot be read is not a free port.
    const recordedPort = typeof node.port === 'number' ? node.port : 0
    let port = recordedPort
    const verdict = await deps.checkPort(recordedPort)
    if (!verdict.ok) {
        if (verdict.code === 'unavailable') return refuse('unavailable', verdict.problem)
        const chosen = await deps.choosePort()
        if (!chosen.ok) return refuse('unavailable', chosen.problem)
        port = chosen.port
    }

    // Each hostname it had, unless another project or environment claimed it meanwhile. The primary goes
    // with the rest when it was taken, and the first alias left over becomes the primary.
    const claimed = new Set<string>()
    for (const entry of registry.projects.values()) {
        for (const environment of entry.environments.values()) for (const hostname of hostnamesOf(environment)) claimed.add(hostname)
    }
    const had = [node.domain, ...(Array.isArray(node.aliases) ? node.aliases : [])]
        .filter((hostname): hostname is string => typeof hostname === 'string')
    const kept = had.filter(hostname => !claimed.has(hostname.toLowerCase()))
    const droppedHostnames = had.filter(hostname => claimed.has(hostname.toLowerCase()))
    const restoredNode: Record<string, unknown> = { ...node, port }
    delete restoredNode.domain
    delete restoredNode.aliases
    if (kept.length > 0) restoredNode.domain = kept[0]
    if (kept.length > 1) restoredNode.aliases = kept.slice(1)

    const trees = deployTrees(dir)
    const steps: Step[] = []
    const leftInTrash: string[] = []
    try {
        await deps.fs.move(tree, dir)
        steps.push({ what: `moved ${tree} to ${dir}`, undo: () => deps.fs.move(dir, tree) })
        for (const [from, to] of [[posix.join(record.trash, 'prev'), trees.prev], [posix.join(record.trash, 'next'), trees.next]] as const) {
            if (!(await deps.fs.exists(from))) continue
            if (await deps.fs.exists(to) || !(await deps.fs.exists(posix.dirname(to)))) {
                leftInTrash.push(from)
                continue
            }
            await deps.fs.move(from, to)
            steps.push({ what: `moved ${from} to ${to}`, undo: () => deps.fs.move(to, from) })
        }

        if (port !== recordedPort) {
            const entry = entryFrom(name, node, record.composeName, port)
            const written = await deps.setPortEnv(entry, current.portEnv, port)
            if (!written.ok) throw new Error(written.problem)
            steps.push({
                what: `wrote port ${port} into ${dir}/.env`,
                undo: async () => {
                    const put = await deps.restorePortEnv(entry, written.previous)
                    if (!put.ok) throw new Error(put.problem)
                },
            })
            const override = await deps.portOverride({ dir, composePaths: entry.composePaths, composeName: record.composeName }, current.portEnv)
            if (!override.ok) throw new Error(override.problem)
        }

        const registered = await deps.writer.write({ kind: 'restore-environment', id: project.id, environment: name, node: restoredNode })
        if (!registered.ok) throw new Error(registered.problem)
    } catch (error) {
        const problem = `could not restore ${id}: ${describeError(error)}`
        deps.log(`restore ${problem}`)
        const left = await unwind(steps, deps.log)
        return refuse('failed', left === null ? `${problem}. Everything was put back in the trash.` : `${problem}. ${left}`)
    }

    // Back in the registry from here on: what fails now is reported beside the restore, never undone.
    const warnings: string[] = []
    let vhost = false
    try {
        await deps.refreshRegistry()
    } catch (error) {
        deps.log(`restore ${id}: the registry could not be reloaded: ${describeError(error)}`)
    }
    const restored = deps.registry().projects.get(project.id)?.environments.get(name)
    if (!restored) {
        warnings.push(`${id} was restored but could not be read back, so it was neither put on the web nor started`)
    } else {
        if (restored.domain !== null && token !== null && deps.vhosts && current.capabilities.has('domains')) {
            try {
                const wrote = await deps.vhosts.write(current, restored, token)
                if (wrote.ok) vhost = true
                else warnings.push(`its vhost could not be written: ${wrote.message}`)
            } catch (error) {
                warnings.push(`its vhost could not be written: ${describeError(error)}`)
            }
        }
        const up = await runCompose(upArgv(locationIn(restored, restored.dir), restored.composeName), SWAP_TIMEOUT_MS, deps.runner)
        if (!up.ok) warnings.push(`it could not be started (up ${up.message}); deploy it to start it`)
    }
    if (leftInTrash.length > 0) {
        // Slimmed rather than dropped, so the purge still removes what stayed behind
        try {
            await deps.store.update({ ...record, leftovers: true })
        } catch (error) {
            warnings.push(`its record could not be updated: ${describeError(error)}`)
        }
        warnings.push(`${leftInTrash.join(' and ')} stayed in the trash, because the folder it came from is taken or missing; the purge removes it with the rest`)
    } else {
        try {
            await deps.store.remove(project.id, name, deletedAt)
        } catch (error) {
            warnings.push(`its record could not be dropped: ${describeError(error)}`)
        }
        try {
            await deps.fs.removeEmptyDir(record.trash)
        } catch (error) {
            deps.log(`restore ${id}: ${record.trash} was left in place: ${describeError(error)}`)
        }
    }
    deps.log(`restore ${id}: restored on port ${port}${droppedHostnames.length ? `, without ${droppedHostnames.join(', ')}` : ''}`)
    return { ok: true, port, portChanged: port !== recordedPort, droppedHostnames, warnings, vhost }
}

export type PurgeDeps = Pick<TrashDeps, 'registry' | 'refreshRegistry' | 'registryRejection' | 'store' | 'runner' | 'log'> & {
    fs: Pick<TrashDeps['fs'], 'rmdir' | 'realpath'>
    // Whether a delete or restore of this environment is running, which the purge never races
    busy?: (record: DeletedRecord) => boolean
    // Drops the environment's deploy history, so a new environment of that name starts clean
    forgetDeploys?: (key: string) => Promise<void>
}

// Every record older than 30 days: its trash folder, then the volumes of the compose project it ran
// under. A record is only dropped once both are gone; anything that fails leaves it for the next sweep.
// The caller runs this under the same lock a delete and a restore take, and each record is re-read, with
// the registry reloaded, just before anything of it is deleted.
export async function purgeDeleted(now: number, deps: PurgeDeps): Promise<{ purged: string[], kept: string[] }> {
    const purged: string[] = []
    const kept: string[] = []

    for (const listed of deps.store.list()) {
        if (now - Date.parse(listed.deletedAt) <= DELETED_KEEP_MS) continue
        const id = `${listed.project} ${listed.environment}`
        const keep = (why: string) => {
            deps.log(`purge ${id}: kept for the next sweep: ${why}`)
            kept.push(id)
        }
        if (deps.busy?.(listed)) {
            keep('it is being deleted or restored')
            continue
        }
        try {
            await deps.refreshRegistry()
        } catch (error) {
            keep(`the registry could not be reloaded: ${describeError(error)}`)
            continue
        }
        const rejection = deps.registryRejection()
        if (rejection !== null) {
            keep(`the registry file was rejected, so the last good version in use may be stale: ${rejection}`)
            continue
        }
        // Its record could not be dropped afterwards: the folder and the volumes would go, and the record
        // would stay behind naming a trash folder that no longer exists
        const unwritable = deps.store.unwritable?.() ?? null
        if (unwritable !== null) {
            keep(`the deleted environments record refuses writes: ${unwritable}`)
            continue
        }
        const record = deps.store.list(listed.project)
            .find(entry => entry.environment === listed.environment && entry.deletedAt === listed.deletedAt)
        if (!record) {
            deps.log(`purge ${id}: its record is gone, so there is nothing to purge`)
            continue
        }
        const registry = deps.registry()
        // An invalid project is missing from registry.projects, and so are the compose names its
        // environments run under: nothing can be proven not to be in use until every project is valid.
        if (registry.invalid.size > 0) {
            keep(`the registry has invalid projects (${[...registry.invalid.keys()].sort().join(', ')}), whose compose names cannot be known`)
            continue
        }
        if (!TRASH_DIR.test(record.trash) || posix.normalize(record.trash) !== record.trash) {
            keep(`${record.trash} is not a folder under a site's .deleted folder, so it is not deleted`)
            continue
        }
        if (!COMPOSE_NAME.test(record.composeName)) {
            keep(`${record.composeName} is not a compose project name`)
            continue
        }
        const inUse = [...registry.projects.values()]
            .some(project => [...project.environments.values()].some(environment => environment.composeName === record.composeName))
        // Leftovers of a restore share the compose name of the environment that came back, and remove no
        // volumes, so only a real deleted environment is checked
        if (!record.leftovers && inUse) {
            keep(`the compose name ${record.composeName} belongs to a registered environment`)
            continue
        }

        // A symlink anywhere along the recorded path would point the recursive delete somewhere else
        let real: string
        try {
            real = await deps.fs.realpath(record.trash)
        } catch (error) {
            // Already gone is fine: the delete below is then a no-op
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                keep(`${record.trash} could not be resolved: ${describeError(error)}`)
                continue
            }
            real = record.trash
        }
        if (real !== record.trash) {
            keep(`${record.trash} resolves to ${real}, so it is not deleted`)
            continue
        }

        try {
            await deps.fs.rmdir(record.trash)
        } catch (error) {
            keep(`${record.trash} could not be deleted: ${describeError(error)}`)
            continue
        }

        const volumes: string[] = []
        if (!record.leftovers) {
            const listedVolumes = await deps.runner('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${record.composeName}`, '-q'], VOLUME_TIMEOUT_MS)
            if (listedVolumes.timedOut || listedVolumes.exitCode !== 0) {
                keep(`the volumes of ${record.composeName} could not be listed: ${listedVolumes.stderr.trim()}`)
                continue
            }
            volumes.push(...listedVolumes.stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
            const failed: string[] = []
            for (const volume of volumes) {
                // A volume still in use is refused by Docker and retried on the next sweep
                const removed = await deps.runner('docker', ['volume', 'rm', volume], VOLUME_TIMEOUT_MS)
                if (removed.timedOut || removed.exitCode !== 0) failed.push(volume)
            }
            if (failed.length > 0) {
                keep(`could not remove the volumes ${failed.join(', ')}`)
                continue
            }
        }

        try {
            await deps.store.remove(record.project, record.environment, record.deletedAt)
        } catch (error) {
            keep(`the record could not be dropped: ${describeError(error)}`)
            continue
        }
        if (!record.leftovers && deps.forgetDeploys) {
            try {
                await deps.forgetDeploys(deployKey(record.project, record.environment))
            } catch (error) {
                deps.log(`purge ${id}: its deploy history could not be dropped: ${describeError(error)}`)
            }
        }
        deps.log(`purge ${id}: removed ${record.trash}${volumes.length ? ` and the volumes ${volumes.join(', ')}` : ''}`)
        purged.push(id)
    }
    return { purged, kept }
}

// What the portal lists for one project: each deleted environment, and when the sweep will purge it
export function deletedEnvironments(project: string, deps: Pick<TrashDeps, 'store'>): DeletedEnvironment[] {
    return deps.store.list(project).filter(record => !record.leftovers).map(record => ({
        environment: record.environment,
        deletedAt: record.deletedAt,
        purgeAt: purgeAtOf(record.deletedAt),
        branch: typeof record.node.branch === 'string' ? record.node.branch : null,
        domain: typeof record.node.domain === 'string' ? record.node.domain : null,
        aliases: Array.isArray(record.node.aliases) ? record.node.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
    }))
}
