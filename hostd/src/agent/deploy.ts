// One deploy, end to end. The order is the whole point: nothing before the swap may stop, move or write
// to the running tree, so a fetch, a checkout or a build that fails leaves the site serving exactly what
// it was serving before, and the only thing to clean up is the new tree.
//
// Every dependency is injected, so the tests need no Docker, no network and no filesystem. Nothing here
// throws: a failure becomes a DeployRecord saying what went wrong, because the caller's job is to record
// it, not to catch it.
//
// A site is laid out one of two ways (see shared/layout.ts). Flat: the tree at <dir>, with <dir>.next,
// <dir>.prev and the repository at <dir>.git beside it. Nested: everything under one site folder, the
// tree at <site>/<env>, with <site>/next/<env>, <site>/prev/<env> and one repository at <site>/git that
// every environment shares. deployTrees names the paths for either, and the steps below are the same
// for both. A flat environment moves into the nested layout during one of its own deploys, inside the
// window the site is already down for (see migrate-layout.ts); a move that was interrupted is finished
// by the next deploy before it does anything else.
//
// The git repository lives beside the tree, not inside it, because a deploy renames the tree: leaving the
// repository in it would move it into the previous copy and delete it on the next deploy. Provisioning
// clones into the tree, so the first deploy of an environment moves its .git across once. The rename
// itself is atomic, but the move is three steps (make the directory, own it, rename into it), and only
// the last one puts a repository anywhere: interrupted before it, this leaves an empty directory behind.
// So what the next deploy looks for is the repository, never the directory holding it. See ensureRepo.

import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import type { EnvironmentEntry, ProjectEntry, Registry } from '../shared/registry.ts'
import type { RegistryWriter } from '../shared/registry-write.ts'
import type { Commit } from '../shared/fetch-protocol.ts'
import { maintenanceKey, type DeployRecord, type DeployTrigger } from '../shared/deploys.ts'
import type { FetchClient } from './fetch-client.ts'
import type { ComposeLocation, Runner } from './compose.ts'
import { isPortOverride, type PortOverrideResult } from './port-override.ts'
import type { DockerApi } from './docker.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import { isExampleName } from '../shared/envfiles.ts'
import {
    buildArgv, composeNameOf, deployTrees, downArgv, locationIn, migratingOf, migrationTarget, repositoryIn, runCompose, upArgv,
    BUILD_TIMEOUT_MS, SWAP_TIMEOUT_MS, type DeployTrees,
} from './deploy-compose.ts'
import { waitForHealthy } from './deploy-health.ts'
import { environmentServices, missingSiteProblem } from './environment-services.ts'
import { executeSteps, inspectLayout, resumeSteps, windowSteps, type Step } from './migrate-layout.ts'

// The worst case is a swap that cannot complete, so a deploy refuses to start rather than risk it.
export const MIN_FREE_BYTES = 10 * 1024 ** 3
// Enough to find the subject of any commit a poll is likely to pick up. A subject that cannot be found
// (a rollback to something older) is null, never a reason to fail the deploy.
const SUBJECT_LOG_LIMIT = 50

export type DeployFs = {
    exists(path: string): Promise<boolean>
    mkdir(dir: string): Promise<void>
    rmdir(dir: string): Promise<void>
    // Removes a folder only if it is empty, and fails otherwise. What undoing a folder this process made
    // uses, so an undo can never delete what ended up inside it (rmdir above is recursive).
    removeEmptyDir(dir: string): Promise<void>
    move(from: string, to: string): Promise<void>
    // Whether there is anything at a path worth keeping: a folder with at least one entry, or anything
    // that is not a folder. False when nothing is there, and for a folder that is empty. What the storage
    // check asks before a whole tree is removed (see storageLeftIn).
    holdsData(path: string): Promise<boolean>
    // Copies one file into the new tree. Separate from the env carry's own read and write, which go
    // through env-files.ts and are held to the env-file boundary on purpose: a compose file is not an
    // env file and must not become reachable through the capability that edits those.
    copyFile(from: string, to: string): Promise<void>
    freeBytes(path: string): Promise<number>
    // The flag Apache reads to serve the holding page, keyed <id>-<env> as the design names it.
    setMaintenance(key: string): Promise<void>
    clearMaintenance(key: string): Promise<void>
    // The ownership and mode an existing path already has, read before it is used as the pattern for a
    // tree this deploy is about to create beside it. Never guessed, the same reasoning registry-write.ts
    // already carries a file's own owner and mode across its replacement by: what belongs to the
    // operator must go on belonging to the operator, in whatever mode the operator themselves chose.
    owner(path: string): Promise<{ uid: number, gid: number, mode: number }>
    // Applies that ownership to a whole tree hostd just created, and a mode built from `like` and, for a
    // regular file, from the mode the file already has: a directory gets `like.mode` outright (so the
    // tree stays as traversable as the one it is patterned on), a file keeps `like`'s read and write bits
    // but its own execute bits, because whether a file is meant to run is the commit's own business, not
    // the site directory's. See own-tree.ts's fileModeFor for the exact rule, and its own comment for why
    // this can only keep an execute bit that survived the checkout, not restore one that did not.
    own(dir: string, like: { uid: number, gid: number, mode: number }): Promise<void>
}

export type DeployDeps = {
    registry: () => Registry
    refreshRegistry: () => Promise<void>
    writer: RegistryWriter
    fetcher: FetchClient
    docker: DockerApi
    runner: Runner
    fs: DeployFs
    // Rebuilds hostd.ports.yml in the new tree from the commit going out (port-override.ts)
    portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>
    envFs?: EnvFs
    now: () => number
    sleep: (ms: number) => Promise<void>
    log(message: string): void
    // Whether a deploy may start moving a flat environment into the nested layout. Resuming a move
    // already under way always runs. On in production unless HOSTD_MIGRATE_LAYOUT=0 (see index.ts).
    migrateLayout?: boolean
}

export type DeployRequest = {
    trigger: DeployTrigger
    actor: string
    // Set by the poller (which has just read the tip) and by a rollback (which names an older commit).
    // Absent for a manual deploy, which reads the tip for itself.
    commit?: string
}

// A tree name of this deploy's own that some other project has registered as its folder. Far-fetched,
// and cheap to refuse: the alternative is a deploy that deletes another client's site. A move into the
// nested layout adds the folders it would make or rename into, and the flat tree's waiting place.
function treesProblem(registry: Registry, id: string, trees: DeployTrees, target: DeployTrees | null): string | null {
    const mine = [trees.next, trees.prev, trees.repo]
    if (target) mine.push(target.dir, target.next, target.prev, target.repo, migratingOf(target.site!))
    for (const [otherId, project] of registry.projects) {
        if (otherId === id) continue
        for (const environment of project.environments.values()) {
            if (mine.includes(environment.dir)) return `${environment.dir} is registered to ${otherId}, so ${id} cannot deploy`
        }
    }
    return null
}

// Moves the repository out of the tree the first time, and confirms there is one at all. Every git
// command after this runs against trees.repo, which no swap ever renames.
//
// What is asked is whether the repository is there, never whether the directory that holds it is: the
// three steps below are not one atomic act, and an interruption between the mkdir and the move leaves
// <dir>.git (nested: <site>/git) in place with nothing inside it. Read as "already moved", that empty
// directory is handed to every later deploy's fetch, which can only answer "fatal: not a git repository
// (or any parent up to mount point /var)", in under a second, with no retry able to recover it. Asking
// for the repository instead makes the half-done state something this finishes rather than something
// it inherits.
async function ensureRepo(trees: DeployTrees, deps: DeployDeps): Promise<{ ok: true } | { ok: false, problem: string }> {
    const repository = repositoryIn(trees)
    if (await deps.fs.exists(repository)) return { ok: true }
    if (!(await deps.fs.exists(trees.git))) {
        // Both places are named. Whichever way this site got here, the operator is the one who has to
        // look at the disk, and the answer is far more use than git's own account of the same fact.
        return { ok: false, problem: `${trees.dir} has no git repository, and nor does ${trees.repo}, so it cannot be deployed` }
    }
    // trees.repo is a directory this process makes itself, under its own restrictive umask (right for
    // the secrets it mostly writes; see index.ts), so left alone it lands root-owned with no group or
    // other bits at all: on the live server this came out drw-rw---- root root, a directory with no
    // execute bit that nothing but root can even enter. It belongs with the site it was split out of, so
    // it is given that site's own ownership and mode before anything moves into it, never root's.
    if (!(await deps.fs.exists(trees.repo))) {
        const like = await deps.fs.owner(trees.dir)
        await deps.fs.mkdir(trees.repo)
        await deps.fs.own(trees.repo, like)
    }
    await deps.fs.move(trees.git, repository)
    deps.log(`deploy ${trees.dir}: moved the git repository to ${trees.repo}`)
    return { ok: true }
}

// The environment's own trees, and where it is to move if this deploy moves it into the nested layout
// (null when it is not to move, including whenever migrateLayout is off).
export function sourceTrees(
    project: ProjectEntry, environment: EnvironmentEntry, deps: DeployDeps,
): { trees: DeployTrees, target: DeployTrees | null } {
    const trees = deployTrees(environment.dir)
    const target = deps.migrateLayout ? migrationTarget(project, environment) : null
    return { trees, target }
}

// The trees the fetch, tip, log and checkout work in. Live builds in its flat <dir>.next even when it
// is about to move, because /var/www/<site> is its own running tree until the window, so nothing can be
// made inside it. Any other environment waiting to move already has live nested beside it, so it builds
// from the shared repository into <site>/next/<env>, and never touches its old clone again.
function buildTreesOf(environment: EnvironmentEntry, source: { trees: DeployTrees, target: DeployTrees | null }): DeployTrees {
    return source.target && environment.name !== 'live' ? source.target : source.trees
}

// Fetch, then the tip of the tracked branch. Separate from runDeploy because the poller needs exactly
// this and nothing else: it compares the answer with the registry's `deployed` before deciding whether
// there is anything to deploy at all. It asks the same repository runDeploy would build from.
export async function currentTip(
    project: ProjectEntry, environment: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true, commit: string } | { ok: false, problem: string }> {
    const branch = environment.branch
    if (!branch) return { ok: false, problem: `${project.id} ${environment.name} has no branch to track` }
    try {
        return await tipIn(project, branch, await pollTreesOf(project, environment, deps), deps)
    } catch (error) {
        return { ok: false, problem: describeError(error) }
    }
}

// Where the poller reads the tip. Normally the trees runDeploy would build from, except for a live whose
// move finished on disk but was never recorded (a registry write that failed, or a stop between the
// window and the write): the registry still says flat, but the repository is only in the nested
// layout now. Polling the flat trees would find no repository and skip the site on every poll, so the
// deploy whose resume check records the move would never be started.
async function pollTreesOf(project: ProjectEntry, environment: EnvironmentEntry, deps: DeployDeps): Promise<DeployTrees> {
    const source = sourceTrees(project, environment, deps)
    const build = buildTreesOf(environment, source)
    const moved = migrationTarget(project, environment)
    if (build !== source.trees || !moved) return build
    if (await deps.fs.exists(repositoryIn(source.trees)) || !(await deps.fs.exists(repositoryIn(moved)))) return build
    return moved
}

// currentTip's own work, in trees already chosen. runDeploy calls this directly, because a resume can
// change which trees it builds in, and the tip has to come from the repository the checkout will then
// use.
async function tipIn(
    project: ProjectEntry, branch: string, build: DeployTrees, deps: DeployDeps,
): Promise<{ ok: true, commit: string } | { ok: false, problem: string }> {
    try {
        const repo = await ensureRepo(build, deps)
        if (!repo.ok) return repo
        const fetched = await deps.fetcher.call({ verb: 'fetch', dir: build.repo, branch, credential: project.credential })
        if (!fetched.ok) return { ok: false, problem: fetched.message }
        const tip = await deps.fetcher.call({ verb: 'tip', dir: build.repo, branch })
        if (!tip.ok) return { ok: false, problem: tip.message }
        if (!tip.commit) return { ok: false, problem: `the fetcher gave no commit for ${branch}` }
        return { ok: true, commit: tip.commit }
    } catch (error) {
        return { ok: false, problem: describeError(error) }
    }
}

// Best effort, never a reason to fail a deploy: the subject is for the history to read well.
async function subjectOf(trees: DeployTrees, branch: string, commit: string, deps: DeployDeps): Promise<string | null> {
    try {
        const log = await deps.fetcher.call({ verb: 'log', dir: trees.repo, branch, limit: SUBJECT_LOG_LIMIT })
        if (!log.ok || !log.commits) return null
        // The log's own hashes are abbreviated, so this matches by prefix rather than by equality.
        const found = (log.commits as Commit[]).find(entry => entry.commit !== '' && commit.startsWith(entry.commit))
        return found?.subject ?? null
    } catch {
        return null
    }
}

// The env files are not in the repo, so a fresh checkout has none (or has whatever the repo commits,
// which plausibly points at nothing this site uses). Carrying them across is what makes the new tree
// runnable. A file that cannot be copied fails the deploy: starting a container with half its settings
// is worse than not deploying at all.
async function carryEnvFiles(
    environment: EnvironmentEntry, next: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const files = await listEnvFiles(environment, deps.envFs)
    for (const file of files) {
        // The checkout already has the committed copy, and it is the one that belongs with this commit.
        // See isExampleName for why this is a skip and not a write that needed permitting.
        if (isExampleName(file.path)) continue
        const read = await readEnvFile(environment, file.path, deps.envFs)
        // The path is named, never the contents: an env value must not reach a log line or a record.
        if (!read.ok) return { ok: false, problem: `${file.path} could not be read from the running copy` }
        const written = await writeEnvFile(next, file.path, read.text, deps.envFs)
        if (!written.ok) return { ok: false, problem: `${file.path} could not be written into the new tree` }
    }
    return { ok: true }
}

// The compose files the registry names for this environment, for the ones a fresh checkout does not
// have. A host-specific override is not in the repo, deliberately: it says which port this machine has
// free, which service this box does not run, which address to publish on. None of that belongs upstream,
// and every deployable site on the dedi has one. Without this, compose is handed `-f` pointing into the
// new tree at a file that is not there and refuses before building anything:
//
//   open /var/www/<id>.next/docker-compose.override.yml: no such file or directory
//
// The checkout wins wherever it has its own copy, the same rule the .example skip follows: the repo's
// file belongs with the commit going out, and the running tree's is the commit being replaced. So this
// only ever fills a gap, never overwrites. Paired by index rather than recomputed, because
// next.composePaths is locationIn's own mapping of the same list into the new tree.
//
// Unlike an env file, a failure here fails the deploy outright. A missing env file is a site that starts
// with less configuration than it should; a missing compose file is a site compose cannot describe at
// all, and the build would only fail on it a moment later with a worse message.
async function carryComposeFiles(
    environment: EnvironmentEntry, next: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    for (const [index, from] of environment.composePaths.entries()) {
        const to = next.composePaths[index]
        if (!to) continue
        // hostd.ports.yml is rebuilt a few steps down, not carried: a running tree that predates this
        // feature, or one whose override was removed by hand, has none, and carrying would fail the
        // deploy one step before the rebuild that recreates it anyway.
        if (isPortOverride(from)) continue
        if (await deps.fs.exists(to)) continue
        try {
            await deps.fs.copyFile(from, to)
        } catch (error) {
            return { ok: false, problem: `${posix.basename(from)} could not be carried into the new tree: ${describeError(error)}` }
        }
        deps.log(`deploy ${environment.dir}: carried ${posix.basename(from)} into the new tree`)
    }
    return { ok: true }
}

// Compose fills in `Dockerfile` for every service that does not name its own build file, and the legacy
// builder the agent runs (no buildx: see the agent stage in hostd/Dockerfile) looks for exactly that
// name, so a repo that commits `dockerfile` failed every build with "unable to evaluate symlinks in
// Dockerfile path". buildx would find the lowercase name on its own, but BuildKit fetches registry
// tokens from the client, and the agent has no network: every base image not already on the host
// failed instead. So the checkout gets a `Dockerfile` copy beside each registered compose file, where
// a `context: .` build looks for it. Only ever a gap filled: a checkout with its own is left alone.
async function nameDockerfiles(next: EnvironmentEntry, deps: DeployDeps): Promise<{ ok: true } | { ok: false, problem: string }> {
    const dirs = new Set(next.composePaths.map(path => posix.dirname(path)))
    for (const dir of dirs) {
        const lower = posix.join(dir, 'dockerfile')
        const upper = posix.join(dir, 'Dockerfile')
        if (await deps.fs.exists(upper) || !(await deps.fs.exists(lower))) continue
        try {
            await deps.fs.copyFile(lower, upper)
        } catch (error) {
            return { ok: false, problem: `dockerfile could not be copied to Dockerfile in the new tree: ${describeError(error)}` }
        }
        deps.log(`deploy ${next.dir}: copied dockerfile to Dockerfile for the build`)
    }
    return { ok: true }
}

// The storage folders the registry names for this project, relative to whichever tree they are in. The
// registry resolves them against live, but every environment's compose file bind-mounts the same
// relative path from its own tree, so every environment's deploy carries them.
const storagePathsOf = (project: ProjectEntry): string[] => Object.values(project.storage).map(entry => entry.path)

// Where the checkout's own copy of a storage folder waits, for the moment it takes to swap the two.
const CARRY_ASIDE = '.hostd-carry'

type CarriedStorage = { ok: true, carried: string[] } | { ok: false, problem: string, undone: boolean }

// Storage is client data (uploads, a SQLite file's folder) that lives inside the tree and is not in the
// repo, so a fresh checkout does not have it, and a swap that only renamed the trees would leave it in
// the previous copy for the next deploy to delete. Docker would then create an empty root-owned folder at
// the bind-mount path on `up`, and the site would come up healthy with none of its data. So the swap
// moves each registered folder from the tree that just stopped into the one about to start.
//
// A checkout that commits a copy of its own (a folder of starter documents, say) is not overwritten: the
// two are swapped, the running data into the new tree and the committed copy into the old one, so nothing
// is removed and a rollback can swap them straight back. A folder the old tree does not have is left
// alone. Moves, never copies: both trees are on one filesystem, so each is a rename, however big the
// folder, and the window stays short.
//
// Run through executeSteps in 'window' mode, so a failure undoes every move already made and says whether
// that worked. Returns the paths it carried, which are exactly what a rollback has to carry back.
async function carryStorage(paths: string[], from: string, to: string, deps: DeployDeps): Promise<CarriedStorage> {
    const steps: Step[] = []
    const carried: string[] = []
    for (const path of paths) {
        const source = posix.join(from, path)
        if (!(await deps.fs.exists(source))) continue
        const target = posix.join(to, path)
        // A nested path (data/uploads) needs its parents in the new tree, which a checkout that ignores
        // the whole of data/ does not have. Each is owned like its counterpart in the old tree.
        const parents = posix.dirname(path) === '.' ? [] : posix.dirname(path).split('/')
        for (let depth = 1; depth <= parents.length; depth++) {
            const parent = parents.slice(0, depth).join('/')
            steps.push({ kind: 'mkdir', dir: posix.join(to, parent), like: posix.join(from, parent) })
        }
        if (await deps.fs.exists(target)) {
            const aside = `${source}${CARRY_ASIDE}`
            // Refused before anything moves, rather than guessing whose that folder is.
            if (await deps.fs.exists(aside)) return { ok: false, problem: `${aside} is in the way`, undone: true }
            steps.push(
                { kind: 'move', from: target, to: aside },
                { kind: 'move', from: source, to: target },
                { kind: 'move', from: aside, to: source },
            )
        } else {
            steps.push({ kind: 'move', from: source, to: target })
        }
        carried.push(path)
    }
    const done = await executeSteps(steps, deps.fs, 'window')
    if (!done.ok) return { ok: false, problem: `${done.step} failed: ${done.problem}`, undone: done.undone }
    if (carried.length > 0) deps.log(`deploy ${to}: carried ${carried.join(', ')} across from ${from}`)
    return { ok: true, carried }
}

// Asked before a whole tree other than the running one is removed: a leftover build tree, or the previous
// copy a swap is about to replace. After a normal deploy neither holds client data, because carryStorage
// took it. One that does is a window that stopped part way (the agent killed between the renames and the
// carry, or an undo that could not finish), or a tree left by a hostd from before storage was carried,
// and removing it would delete the only copy. So when a registered storage folder in it holds something
// and the running tree's own copy is empty or missing, the answer is a problem, never a removal: the
// operator decides which copy is the real one (see the RUNBOOK).
async function storageLeftIn(paths: string[], tree: string, running: string, deps: DeployDeps): Promise<string | null> {
    for (const path of paths) {
        const left = posix.join(tree, path)
        if (!(await deps.fs.holdsData(left))) continue
        const live = posix.join(running, path)
        if (await deps.fs.holdsData(live)) continue
        return `${left} holds storage that ${live} does not, so ${tree} is not being removed; see the RUNBOOK`
    }
    return null
}

// The automatic return the design is emphatic about: the new tree is parked back at <dir>.next (nested:
// next/<env>), the previous one takes its place, and only once the previous copy is up and healthy is
// the failed tree removed. Nothing is deleted before its replacement is in place, so an interrupted
// rollback still leaves both copies on disk for the operator to sort out. Only ever works on `trees`, so
// the same code rolls back a flat tree, a nested one, and one that moved into the nested layout this
// deploy (whose previous copy is the flat tree, now at prev/live).
//
// `carried` is the storage the swap carried into the failed tree, and it goes back with the previous
// copy before that starts. If it cannot, the previous copy is not started: a site serving without its
// uploads would look healthy and quietly write new ones into a folder the next deploy has no reason to
// keep. The failed tree is left at next, holding the data, and storageLeftIn stops the next deploy from
// removing it.
async function swapBack(
    project: ProjectEntry, environment: EnvironmentEntry, trees: DeployTrees, name: string, carried: string[], deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    if (!(await deps.fs.exists(trees.prev))) return { ok: false, problem: 'there is no previous copy to go back to' }
    // A live tree that moved into the nested layout this deploy was built in the flat <site>.next, so
    // <site>/next may not exist yet, and a rename cannot make the folder it lands in.
    if (trees.site) {
        const parent = await executeSteps([{ kind: 'mkdir', dir: posix.dirname(trees.next), like: trees.site }], deps.fs, 'window')
        if (!parent.ok) return { ok: false, problem: `${parent.step} failed: ${parent.problem}` }
    }
    // Whatever state the failed version is in, its containers have to go before the old tree takes its
    // place: they hold the port. A down that fails is not a reason to stop, because the up below is
    // what actually decides whether the site comes back.
    await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
    await deps.fs.move(trees.dir, trees.next)
    await deps.fs.move(trees.prev, trees.dir)
    const storage = await carryStorage(carried, trees.next, trees.dir, deps)
    if (!storage.ok) {
        return { ok: false, problem: `its storage could not be carried back from ${trees.next}, so it was not started: ${storage.problem}` }
    }
    const up = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
    if (!up.ok) return { ok: false, problem: up.message }
    const healthy = await healthOf(project, environment, trees.dir, name, deps)
    if (!healthy.ok) return { ok: false, problem: healthy.problem }
    // Checked, not assumed: the carry above should have left nothing in it, and a removal is forever.
    const left = await storageLeftIn(storagePathsOf(project), trees.next, trees.dir, deps).catch(error => describeError(error))
    if (left) deps.log(`deploy ${project.id} ${environment.name}: ${left}`)
    else await deps.fs.rmdir(trees.next).catch(() => {})
    return { ok: true }
}

// The health check over the services the tree's own compose file declares, which on a branch other than
// the one live runs may be fewer than the registry lists (environment-services.ts). Read after the swap,
// from the tree now in place, so a rollback is checked against the copy it brought back.
async function healthOf(
    project: ProjectEntry, environment: EnvironmentEntry, dir: string, name: string, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const services = await environmentServices(project, { ...locationIn(environment, dir), composeName: name }, deps.runner)
    if (!services.ok) return services
    const noSite = missingSiteProblem(project, services.services)
    if (noSite) return { ok: false, problem: noSite }
    return waitForHealthy({ ...project, services: services.services }, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
}

// A swap renames the tree git checked out, and git goes on recording the worktree under the path it
// was created at, which no longer exists. Anyone who ever runs `git worktree prune` against the
// repository (an operator tidying up, which is exactly what the stale entry invites) then deletes the
// admin directory the tree's .git points at, and the site's tree stops being a repository at all. Repair
// follows the tree to where it actually is, and the same goes for a repository that has itself moved,
// as it does when a site moves into the nested layout.
//
// Always outside the maintenance window: this is a round trip to the fetcher and it touches nothing the
// site is serving. Best effort for the same reason. The site is up, and a record that could not be
// tidied is not a deploy that failed.
async function repairWorktree(
    project: ProjectEntry, environment: EnvironmentEntry, repo: string, worktree: string, deps: DeployDeps,
): Promise<void> {
    const repaired = await deps.fetcher.call({ verb: 'repair', dir: repo, worktree })
    if (!repaired.ok) {
        deps.log(`deploy ${project.id} ${environment.name}: could not repair the worktree record for ${worktree}: ${repaired.message}`)
    }
}

// The registry catches up with a tree that is already nested on disk. The compose name stays the one
// the containers were created under, which is what lets the next down find them.
async function recordLayout(
    project: ProjectEntry, environment: EnvironmentEntry, to: DeployTrees, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    await repairWorktree(project, environment, to.repo, to.dir, deps)
    // Live's previous copy is the flat tree it moved out of, a worktree of this same repository, so it
    // is repaired too. Any other environment's previous copy is its own old clone, which belongs to a
    // repository this one is not, and is about to be removed.
    if (environment.name === 'live' && await deps.fs.exists(to.prev)) await repairWorktree(project, environment, to.repo, to.prev, deps)
    const written = await deps.writer.write({
        kind: 'set-layout', id: project.id, environment: environment.name, dir: to.dir, composeName: environment.composeName,
    })
    if (!written.ok) return { ok: false, problem: written.problem }
    await deps.refreshRegistry()
    return { ok: true }
}

// Starts the tree a move left at to.dir, under the name its containers were always created under. An up
// with --no-build is idempotent: it changes nothing for a site already running there. A start that fails
// is logged, not fatal: the deploy that resumed the move is about to take the same tree down and put a
// new one up in its place anyway.
async function startMoved(project: ProjectEntry, environment: EnvironmentEntry, to: DeployTrees, deps: DeployDeps): Promise<void> {
    const up = await runCompose(upArgv(locationIn(environment, to.dir), composeNameOf(environment)), SWAP_TIMEOUT_MS, deps.runner)
    if (!up.ok) deps.log(`deploy ${project.id} ${environment.name}: the move to ${to.site} is finished, but ${to.dir} did not start: ${up.message}`)
}

// The agent stopped inside a window, after live's tree left /var/www/<site> for <site>.migrating and
// before the move was done, or the window's undo stopped part way. Either way the site has been down
// ever since (behind the holding page, if the flag survived). Resume only goes forward: once
// /var/www/<site>/ exists the nested layout is the true one, and there is no flat tree left to go back
// to. So the rest of the layout is finished, and then the tree that was serving before the window, now
// at prev/live, is put back at live and started. The build the window was about to swap in is never
// served: no health check has seen it. It is parked at next/live if it already reached live, or left
// where it is and removed if it is still the flat <site>.next, either way a build tree and never client
// data, and the deploy carrying on from here builds again anyway.
async function finishInterruptedMove(
    project: ProjectEntry, environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees, key: string, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    await deps.fs.setMaintenance(key)
    try {
        const moved = await executeSteps(resumeSteps(from, to), deps.fs, 'resume')
        if (!moved.ok) return { ok: false, problem: `the move to ${to.site} could not be finished at ${moved.step}: ${moved.problem}` }
        if (await deps.fs.exists(to.prev)) {
            const restored = await restoreOldTree(from, to, deps)
            if (!restored.ok) return { ok: false, problem: `the move to ${to.site} is finished, but ${restored.problem}` }
        } else if (!(await deps.fs.exists(to.dir))) {
            // No old tree to go back to, which a resume should never meet: the build is then all there
            // is, so it is served, as the window would have.
            const build = await executeSteps([{ kind: 'move', from: from.next, to: to.dir }], deps.fs, 'resume')
            if (!build.ok) return { ok: false, problem: `the move to ${to.site} is finished, but ${build.step} failed: ${build.problem}` }
        }
        await startMoved(project, environment, to, deps)
        return { ok: true }
    } finally {
        // Always, for the same reason as the window's own: a flag left behind would serve the holding
        // page over a site that is running.
        await deps.fs.clearMaintenance(key).catch(() => {})
    }
}

// Puts live's old tree back at live, out of prev/live. Only ever removes a build tree (next/live, or the
// flat <site>.next): whatever is at live is moved aside first, never removed, so the one tree a client's
// site depends on is always somewhere on disk.
async function restoreOldTree(from: DeployTrees, to: DeployTrees, deps: DeployDeps): Promise<{ ok: true } | { ok: false, problem: string }> {
    try {
        if (await deps.fs.exists(to.dir)) {
            // A rename cannot make the folder it lands in, and a window stopped this early never made it.
            const parent = await executeSteps([{ kind: 'mkdir', dir: posix.dirname(to.next), like: to.site! }], deps.fs, 'resume')
            if (!parent.ok) return { ok: false, problem: `${parent.step} failed: ${parent.problem}` }
            if (await deps.fs.exists(to.next)) await deps.fs.rmdir(to.next)
            await deps.fs.move(to.dir, to.next)
        }
        if (await deps.fs.exists(from.next)) await deps.fs.rmdir(from.next)
        await deps.fs.move(to.prev, to.dir)
        return { ok: true }
    } catch (error) {
        return { ok: false, problem: `the previous copy could not be put back at ${to.dir}: ${describeError(error)}` }
    }
}

type Resumed =
    // Nothing to resume: flat, or not a candidate for moving at all.
    | { kind: 'unchanged' }
    // A move already under way is finished and recorded; the deploy carries on in the nested trees.
    | { kind: 'nested', environment: EnvironmentEntry }
    | { kind: 'failed', problem: string }

// The check every deploy runs before anything else, whether or not migrateLayout is on: the registry
// still records this environment as flat, so is the disk still flat? The disk is the truth. A move that
// was cut short is finished (see finishInterruptedMove), one that finished but was never recorded is
// started and recorded, and a site folder that is neither layout is left to the operator: the deploy is
// refused. Deploying it flat instead would rename a folder hostd cannot read to .prev, and the deploy
// after that would delete it.
async function resumeLayout(
    project: ProjectEntry, environment: EnvironmentEntry, key: string, deps: DeployDeps,
): Promise<Resumed> {
    const to = migrationTarget(project, environment)
    if (!to) return { kind: 'unchanged' }
    const from = deployTrees(environment.dir)
    const state = await inspectLayout(environment, from, to, path => deps.fs.exists(path))
    if (state === 'flat') return { kind: 'unchanged' }
    if (state === 'unknown') {
        return { kind: 'failed', problem: `${to.site} is neither flat nor nested, so it is not being deployed; see the RUNBOOK` }
    }
    if (state === 'interrupted') {
        const finished = await finishInterruptedMove(project, environment, from, to, key, deps)
        if (!finished.ok) return { kind: 'failed', problem: finished.problem }
    } else {
        // 'moved': either a move whose registry write failed, with the site running, or an agent that
        // stopped between the window's last rename and its up, with nothing running. The disk looks the
        // same for both, so the tree is started either way. In the second case that is the build the
        // window had just put in place, never health-checked: an accepted residual, because the deploy
        // carrying on from here replaces it at once.
        await startMoved(project, environment, to, deps)
    }
    const recorded = await recordLayout(project, environment, to, deps)
    if (!recorded.ok) return { kind: 'failed', problem: `migrated, but the registry could not be updated: ${recorded.problem}` }
    deps.log(`deploy ${project.id} ${environment.name}: finished moving to ${to.dir}`)
    return { kind: 'nested', environment: { ...environment, dir: to.dir, composePaths: locationIn(environment, to.dir).composePaths } }
}

// Inside the window, in place of the flat swap's two renames: the running tree becomes the nested
// previous copy and the new build becomes the nested tree, and for live the repository goes with them.
// A failure undoes every step already taken (executeSteps), so the caller has the flat tree back where
// it was and only has to start it again.
async function moveIntoNested(
    environment: EnvironmentEntry, trees: DeployTrees, target: DeployTrees, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, step: string, problem: string, undone: boolean }> {
    // Only one previous copy is kept, in either layout. Live's nested previous copy cannot exist yet:
    // that path is inside the flat tree still, and whatever the site keeps there is not ours to delete.
    if (await deps.fs.exists(trees.prev)) await deps.fs.rmdir(trees.prev)
    if (!target.prev.startsWith(`${trees.dir}/`) && await deps.fs.exists(target.prev)) await deps.fs.rmdir(target.prev)
    return executeSteps(windowSteps(environment, trees, target), deps.fs, 'window')
}

// The old separate clone a test environment had while it was flat. Everything in it came from GitHub,
// and the shared repository has just fetched the branch this environment deploys, so nothing is lost.
// Best effort: a folder left behind costs disk, not correctness.
async function removeOldClone(project: ProjectEntry, environment: EnvironmentEntry, trees: DeployTrees, deps: DeployDeps): Promise<void> {
    if (!(await deps.fs.exists(trees.repo))) return
    try {
        await deps.fs.rmdir(trees.repo)
        deps.log(`deploy ${project.id} ${environment.name}: removed ${trees.repo}, now that it deploys from the shared repository`)
    } catch (error) {
        deps.log(`deploy ${project.id} ${environment.name}: could not remove ${trees.repo}: ${describeError(error)}`)
    }
}

export async function runDeploy(
    project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps,
): Promise<DeployRecord> {
    const startedMs = deps.now()
    const startedAt = new Date(startedMs).toISOString()
    // `trees` is the environment's own, where it runs. `target` is where it moves this deploy, if it
    // does. Both can change once, below, when a move an earlier deploy started is finished first.
    let { trees, target } = sourceTrees(project, environment, deps)
    const name = composeNameOf(environment)
    // The maintenance flag's own name, not the deploy key: this one becomes a filename Apache reads.
    const key = maintenanceKey(project.id, environment.name)

    const record = (
        commit: string, subject: string | null, outcome: DeployRecord['outcome'], reason: string | null, output: string | null = null,
    ): DeployRecord => ({
        commit, subject, actor: request.actor, trigger: request.trigger, startedAt,
        durationMs: deps.now() - startedMs, outcome, reason, output,
    })
    const failed = (reason: string, output: string | null = null) => {
        deps.log(`deploy ${project.id} ${environment.name}: failed, ${reason}`)
        return record(request.commit ?? '', null, 'failed', reason, output)
    }

    if (!project.repo) return failed(`${project.id} has no repo to deploy from`)
    const branch = environment.branch
    if (!branch) return failed(`${project.id} ${environment.name} has no branch to track`)
    // Checked against where a move would go even with migrateLayout off, because a resume moves there
    // regardless.
    const squatter = treesProblem(deps.registry(), project.id, trees, migrationTarget(project, environment))
    if (squatter) return failed(squatter)

    try {
        const resumed = await resumeLayout(project, environment, key, deps)
        if (resumed.kind === 'failed') return failed(resumed.problem)
        if (resumed.kind === 'nested') {
            environment = resumed.environment
            trees = deployTrees(environment.dir)
            target = null
        }
        const build = buildTreesOf(environment, { trees, target })

        const free = await deps.fs.freeBytes(environment.dir)
        if (free < MIN_FREE_BYTES) {
            return failed(`only ${Math.round(free / 1024 ** 3)} GB of free disk, and a deploy needs ${MIN_FREE_BYTES / 1024 ** 3} GB`)
        }

        let commit = request.commit
        if (!commit) {
            // Said here rather than inside currentTip, which the poller calls for every environment every
            // two minutes: a line in there would be noise about nothing happening, a hundred and fifty
            // times an hour, and would reach no watcher anyway since a poll runs outside a deploy.
            deps.log(`deploy ${project.id} ${environment.name}: fetching ${environment.branch}`)
            const tip = await tipIn(project, branch, build, deps)
            if (!tip.ok) return failed(tip.problem)
            commit = tip.commit
        } else {
            const repo = await ensureRepo(build, deps)
            if (!repo.ok) return failed(repo.problem)
        }

        const subject = await subjectOf(build, branch, commit, deps)
        const fail = (reason: string, output: string | null = null) => {
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: failed, ${reason}`)
            return record(commit, subject, 'failed', reason, output)
        }

        // Every tree this deploy will remove whole, checked before anything is touched rather than inside
        // the window, where a refusal would mean starting the old copy again: the leftover build tree the
        // checkout replaces, and the previous copy (or copies, for a move into the nested layout) the swap
        // replaces. Live's nested previous copy is inside its own flat tree until the window, so it is not
        // one of them (see moveIntoNested).
        const storage = storagePathsOf(project)
        const doomed = [build.next, trees.prev]
        if (target && !target.prev.startsWith(`${trees.dir}/`)) doomed.push(target.prev)
        for (const tree of doomed) {
            const left = await storageLeftIn(storage, tree, trees.dir, deps)
            if (left) return fail(left)
        }

        // Prepare. A nested site's next/ and prev/ are made the first time an environment needs them,
        // owned like the site folder itself, because git will not make the folder a worktree lands in.
        // 'window' mode, though no window is open, because it is the mode that removes a folder it made
        // when a later one fails, rather than leaving half the pair behind.
        if (build.site) {
            const parents = await executeSteps([
                { kind: 'mkdir', dir: posix.dirname(build.next), like: build.site },
                { kind: 'mkdir', dir: posix.dirname(build.prev), like: build.site },
            ], deps.fs, 'window')
            if (!parents.ok) return fail(`${parents.step} failed: ${parents.problem}`)
        }

        // A tree left behind by an earlier deploy is removed first: git refuses to add a worktree over an
        // existing folder, and whatever is in there is nobody's current version.
        if (await deps.fs.exists(build.next)) await deps.fs.rmdir(build.next)
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: checking out`)
        const checkedOut = await deps.fetcher.call({ verb: 'checkout', dir: build.repo, worktree: build.next, commit })
        if (!checkedOut.ok) {
            await deps.fs.rmdir(build.next).catch(() => {})
            return fail(checkedOut.message)
        }

        const nextEnvironment: EnvironmentEntry = {
            ...environment, dir: build.next, composePaths: locationIn(environment, build.next).composePaths,
        }
        const carried = await carryEnvFiles(environment, nextEnvironment, deps)
        if (!carried.ok) {
            await deps.fs.rmdir(build.next).catch(() => {})
            return fail(carried.problem)
        }

        const composed = await carryComposeFiles(environment, nextEnvironment, deps)
        if (!composed.ok) {
            await deps.fs.rmdir(build.next).catch(() => {})
            return fail(composed.problem)
        }

        const named = await nameDockerfiles(nextEnvironment, deps)
        if (!named.ok) {
            await deps.fs.rmdir(build.next).catch(() => {})
            return fail(named.problem)
        }

        // hostd.ports.yml is rebuilt from the commit going out, over the copy carryComposeFiles brought
        // across: a commit that adds a service publishing a host port, or moves the site's container
        // port, is then covered at this deploy, not at the next port change. Before own, so the file is
        // owned with the rest of the tree, and before the build, so a refusal leaves the site untouched.
        if (nextEnvironment.composePaths.some(isPortOverride)) {
            const override = await deps.portOverride({ dir: build.next, composePaths: nextEnvironment.composePaths, composeName: name }, project.portEnv)
            if (!override.ok) {
                await deps.fs.rmdir(build.next).catch(() => {})
                return fail(`the port could not be published: ${override.problem}`)
            }
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: published ${environment.port} to ${override.service}:${override.target}`)
        }

        // The checkout above runs as root, in the fetcher, and the env files just carried across run as
        // root here too, so the new tree is root-owned throughout, whatever mode either process left its
        // own entries at. A swap that put that straight into place would still pass the health check
        // below, then take the site down anyway the moment anything but root tried to read its own
        // files. Fixed here, before the build (which reads this same tree) and before the swap, to the
        // ownership the running tree itself already has right now, read fresh rather than assumed, so an
        // operator's own choice of mode (or a future change to it) survives every deploy rather than being
        // baked in once. This is ownership and directory mode, not a substitute for the fetcher checking
        // commits out under a umask that lets git set a file's own mode correctly in the first place (see
        // fetcher/index.ts): own only ever keeps an execute bit it is handed, never invents one.
        const like = await deps.fs.owner(trees.dir)
        await deps.fs.own(build.next, like)

        // Build. The site is still serving the old version throughout, and a failure here ends the
        // deploy with nothing of the running environment touched.
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: building`)
        const built = await runCompose(buildArgv(locationIn(environment, build.next), name), BUILD_TIMEOUT_MS, deps.runner)
        if (!built.ok) {
            await deps.fs.rmdir(build.next).catch(() => {})
            return fail(built.message, built.output)
        }

        // Swap. Everything from here until the flag comes down is the only window in which the site is
        // not serving, so it holds no network call and no build: a down, the renames and an up. When
        // the environment moves into the nested layout, the renames are the move's own, and the tree
        // that comes up is the nested one.
        let live = trees
        let rolledBack: { reason: string, output: string | null } | null = null
        await deps.fs.setMaintenance(key)
        try {
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: taking the old copy down`)
            const down = await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            if (!down.ok) {
                // Nothing has moved, so the old tree is still the site and can be started again by the
                // operator or by the next deploy. Refusing to move on is what keeps that true.
                await deps.fs.rmdir(build.next).catch(() => {})
                return fail(`the running copy could not be stopped: ${down.message}`, down.output)
            }

            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: swapping in the new copy`)
            if (target) {
                const moved = await moveIntoNested(environment, trees, target, deps)
                if (!moved.ok) {
                    const reason = `moving to ${target.site} failed at ${moved.step}: ${moved.problem}`
                    if (!moved.undone) {
                        // The undo stopped where it could not go on, so the flat tree is not back and
                        // there is nothing at trees.dir to start. For live, that state is one the next
                        // deploy's resume check finishes forward. For any other environment it is only
                        // ever its old tree left at prev/<env>, which the operator has to put back.
                        return fail(environment.name === 'live'
                            ? `${reason}; the undo did not finish either, so the next deploy completes the move`
                            : `${reason}; the undo did not finish either, and the previous copy is at ${target.prev}`)
                    }
                    // Every step taken is undone, so the flat tree is back where it was and the registry
                    // still says so: starting it is all that is left to put the site back.
                    const restarted = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
                    if (!restarted.ok) return fail(`${reason}; the previous copy did not start again: ${restarted.message}`, restarted.output)
                    return fail(reason)
                }
                live = target
            } else {
                // Only one previous copy is kept, which is what bounds the disk this costs.
                if (await deps.fs.exists(trees.prev)) await deps.fs.rmdir(trees.prev)
                await deps.fs.move(trees.dir, trees.prev)
                await deps.fs.move(trees.next, trees.dir)
            }

            // Whichever way the trees moved, the old one is now live.prev and the new one live.dir.
            const carried = await carryStorage(storage, live.prev, live.dir, deps)
            if (!carried.ok && !carried.undone) {
                // Some folders are in each tree and nothing is running. Starting either tree would serve
                // half the data, so neither is started; storageLeftIn keeps the next deploy from removing
                // the tree still holding the rest.
                return fail(`storage could not be carried into the new tree: ${carried.problem}; the undo did not finish either, so ` +
                    `neither copy was started and the storage is split between ${live.prev} and ${live.dir}; see the RUNBOOK`)
            }

            let healthy: { ok: true } | { ok: false, problem: string }
            let output: string | null = null
            if (!carried.ok) {
                // Every move was undone, so the data is back in the old tree: an ordinary rollback.
                healthy = { ok: false, problem: `storage could not be carried into the new tree: ${carried.problem}` }
            } else {
                deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: starting the new copy`)
                const up = await runCompose(upArgv(locationIn(environment, live.dir), name), SWAP_TIMEOUT_MS, deps.runner)
                if (up.ok) deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: waiting for it to come up healthy`)
                else output = up.output
                healthy = up.ok
                    ? await healthOf(project, environment, live.dir, name, deps)
                    : { ok: false, problem: up.message }
            }
            if (!healthy.ok) {
                const back = await swapBack(project, environment, live, name, carried.ok ? carried.carried : [], deps)
                deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: rolled back, ${healthy.problem}`)
                const reason = back.ok
                    ? `${healthy.problem}; rolled back to the previous copy`
                    : `${healthy.problem}; the previous copy did not come back healthy either: ${back.problem}`
                rolledBack = { reason, output }
            }
        } finally {
            // Always, including on the way out through a throw: a flag left behind would serve the
            // holding page over a site that is running perfectly well.
            await deps.fs.clearMaintenance(key).catch(() => {})
        }

        // The tree now serving was checked out at the next path and renamed by the swap, so git is told
        // where it went (see repairWorktree). An environment that moved into the nested layout has the
        // registry told too, before `deployed`: its tree is nested now whether this commit stayed up or
        // was rolled back, and a `deployed` recorded against the old folder would name a tree that is
        // gone. A rollback on the same layout is left as it always was, with nothing to record.
        if (target) {
            const recorded = await recordLayout(project, environment, target, deps)
            if (!recorded.ok) {
                const problem = `moved to ${target.site}, but the registry could not be updated: ${recorded.problem}`
                deps.log(`deploy ${project.id} ${environment.name}: ${problem}`)
                // The next deploy's resume check finds the nested tree and writes this again.
                if (rolledBack) return record(commit, subject, 'rolled-back', `${rolledBack.reason}; ${problem}`, rolledBack.output)
                return record(commit, subject, 'failed', `deployed and ${problem}`)
            }
        } else if (!rolledBack) {
            await repairWorktree(project, environment, live.repo, live.dir, deps)
        }
        if (rolledBack) return record(commit, subject, 'rolled-back', rolledBack.reason, rolledBack.output)

        // Record. The registry is written last, so `deployed` only ever names a commit this environment
        // actually served, and the store is refreshed so the next poll compares against it.
        const written = await deps.writer.write({ kind: 'set-deployed', id: project.id, environment: environment.name, commit })
        if (!written.ok) {
            // The site is up and healthy on the new commit; only the bookkeeping failed. Saying so beats
            // pretending the deploy failed, and the next poll simply deploys the same commit again.
            deps.log(`deploy ${project.id} ${environment.name}: deployed, but the registry could not be updated: ${written.problem}`)
            return record(commit, subject, 'failed', `deployed, but the registry could not be updated: ${written.problem}`)
        }
        await deps.refreshRegistry()
        // Only once both records say the environment deploys nested from the shared repository is its
        // old one given up.
        if (target && environment.name !== 'live') await removeOldClone(project, environment, trees, deps)
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: deployed`)
        return record(commit, subject, 'ok', null)
    } catch (error) {
        return failed(describeError(error))
    }
}
