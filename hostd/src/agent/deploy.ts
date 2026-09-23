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
import type { Runner } from './compose.ts'
import type { DockerApi } from './docker.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import { isExampleName } from '../shared/envfiles.ts'
import {
    buildArgv, composeNameOf, deployTrees, downArgv, locationIn, migratingOf, migrationTarget, repositoryIn, runCompose, upArgv,
    BUILD_TIMEOUT_MS, SWAP_TIMEOUT_MS, type DeployTrees,
} from './deploy-compose.ts'
import { waitForHealthy } from './deploy-health.ts'
import { executeSteps, inspectLayout, resumeSteps, windowSteps } from './migrate-layout.ts'

// The worst case is a swap that cannot complete, so a deploy refuses to start rather than risk it.
export const MIN_FREE_BYTES = 10 * 1024 ** 3
// Enough to find the subject of any commit a poll is likely to pick up. A subject that cannot be found
// (a rollback to something older) is null, never a reason to fail the deploy.
const SUBJECT_LOG_LIMIT = 50

export type DeployFs = {
    exists(path: string): Promise<boolean>
    mkdir(dir: string): Promise<void>
    rmdir(dir: string): Promise<void>
    move(from: string, to: string): Promise<void>
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
    return tipIn(project, branch, buildTreesOf(environment, sourceTrees(project, environment, deps)), deps)
}

// currentTip's own work, in trees already chosen. runDeploy calls this directly, because a resume or a
// refused move can change which trees it builds in, and the tip has to come from the repository the
// checkout will then use.
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

// The automatic return the design is emphatic about: the new tree is parked back at <dir>.next (nested:
// next/<env>), the previous one takes its place, and only once the previous copy is up and healthy is
// the failed tree removed. Nothing is deleted before its replacement is in place, so an interrupted
// rollback still leaves both copies on disk for the operator to sort out. Only ever works on `trees`, so
// the same code rolls back a flat tree, a nested one, and one that moved into the nested layout this
// deploy (whose previous copy is the flat tree, now at prev/live).
async function swapBack(
    project: ProjectEntry, environment: EnvironmentEntry, trees: DeployTrees, name: string, deps: DeployDeps,
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
    const up = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
    if (!up.ok) return { ok: false, problem: up.message }
    const healthy = await waitForHealthy(project, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
    if (!healthy.ok) return { ok: false, problem: healthy.problem }
    await deps.fs.rmdir(trees.next).catch(() => {})
    return { ok: true }
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

// The agent stopped inside a window, after live's tree left /var/www/<site> for <site>.migrating and
// before the move was done, so the site has been down ever since (behind the holding page, if the flag
// survived). Resume only goes forward: once /var/www/<site>/ exists the nested layout is the true one,
// and there is no flat tree left to go back to. So the rest of the move is finished and the site is
// started where it now lives. A start that fails is logged, not fatal: this deploy is about to take the
// same tree down and put a new one up in its place anyway.
async function finishInterruptedMove(
    project: ProjectEntry, environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees, key: string, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    await deps.fs.setMaintenance(key)
    try {
        const moved = await executeSteps(resumeSteps(from, to), deps.fs, 'resume')
        if (!moved.ok) return { ok: false, problem: `the move to ${to.site} could not be finished at ${moved.step}: ${moved.problem}` }
        // No new tree to put in place (the build it was waiting for is gone), so the one that was serving
        // before the window comes back instead.
        if (!(await deps.fs.exists(to.dir)) && await deps.fs.exists(to.prev)) await deps.fs.move(to.prev, to.dir)
        const up = await runCompose(upArgv(locationIn(environment, to.dir), composeNameOf(environment)), SWAP_TIMEOUT_MS, deps.runner)
        if (!up.ok) deps.log(`deploy ${project.id} ${environment.name}: finished the move to ${to.site}, but ${to.dir} did not start: ${up.message}`)
        return { ok: true }
    } finally {
        // Always, for the same reason as the window's own: a flag left behind would serve the holding
        // page over a site that is running.
        await deps.fs.clearMaintenance(key).catch(() => {})
    }
}

type Resumed =
    // Nothing to resume: flat, or not a candidate for moving at all.
    | { kind: 'unchanged' }
    // What is on disk is neither layout, so this deploy must not start a move either.
    | { kind: 'refused' }
    // A move already under way is finished and recorded; the deploy carries on in the nested trees.
    | { kind: 'nested', environment: EnvironmentEntry }
    | { kind: 'failed', problem: string }

// The check every deploy runs before anything else, whether or not migrateLayout is on: the registry
// still records this environment as flat, so is the disk still flat? The disk is the truth. A move that
// was cut short is finished (see finishInterruptedMove), one that finished but was never recorded is
// only recorded, and a site folder that is neither layout is left to the operator.
async function resumeLayout(
    project: ProjectEntry, environment: EnvironmentEntry, key: string, deps: DeployDeps,
): Promise<Resumed> {
    const to = migrationTarget(project, environment)
    if (!to) return { kind: 'unchanged' }
    const from = deployTrees(environment.dir)
    const state = await inspectLayout(environment, from, to, path => deps.fs.exists(path))
    if (state === 'flat') return { kind: 'unchanged' }
    if (state === 'unknown') {
        deps.log(`deploy ${project.id} ${environment.name}: ${to.site} is neither flat nor nested, so it is not being moved`)
        return { kind: 'refused' }
    }
    if (state === 'interrupted') {
        const finished = await finishInterruptedMove(project, environment, from, to, key, deps)
        if (!finished.ok) return { kind: 'failed', problem: finished.problem }
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
        if (resumed.kind === 'refused') target = null
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

        // Prepare. A nested site's next/ and prev/ are made the first time an environment needs them,
        // owned like the site folder itself, because git will not make the folder a worktree lands in.
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
            const down = await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            if (!down.ok) {
                // Nothing has moved, so the old tree is still the site and can be started again by the
                // operator or by the next deploy. Refusing to move on is what keeps that true.
                await deps.fs.rmdir(build.next).catch(() => {})
                return fail(`the running copy could not be stopped: ${down.message}`, down.output)
            }

            if (target) {
                const moved = await moveIntoNested(environment, trees, target, deps)
                if (!moved.ok) {
                    // The steps already taken are undone, so the flat tree is back where it was and the
                    // registry still says so: starting it is all that is left to put the site back.
                    const restarted = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
                    const reason = `moving to ${target.site} failed at ${moved.step}: ${moved.problem}`
                        + (moved.undone ? '' : '; the undo did not finish either, so the next deploy completes the move')
                        + (restarted.ok ? '' : `; the previous copy did not start again: ${restarted.message}`)
                    return fail(reason, restarted.ok ? null : restarted.output)
                }
                live = target
            } else {
                // Only one previous copy is kept, which is what bounds the disk this costs.
                if (await deps.fs.exists(trees.prev)) await deps.fs.rmdir(trees.prev)
                await deps.fs.move(trees.dir, trees.prev)
                await deps.fs.move(trees.next, trees.dir)
            }

            const up = await runCompose(upArgv(locationIn(environment, live.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            const healthy = up.ok
                ? await waitForHealthy(project, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
                : { ok: false as const, problem: up.message }
            if (!healthy.ok) {
                const back = await swapBack(project, environment, live, name, deps)
                deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: rolled back, ${healthy.problem}`)
                const reason = back.ok
                    ? `${healthy.problem}; rolled back to the previous copy`
                    : `${healthy.problem}; the previous copy did not come back healthy either: ${back.problem}`
                rolledBack = { reason, output: up.ok ? null : up.output }
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
