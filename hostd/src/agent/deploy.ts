// One deploy, end to end. The order is the whole point: nothing before the swap may stop, move or write
// to the running tree, so a fetch, a checkout or a build that fails leaves the site serving exactly what
// it was serving before, and the only thing to clean up is the new tree.
//
// Every dependency is injected, so the tests need no Docker, no network and no filesystem. Nothing here
// throws: a failure becomes a DeployRecord saying what went wrong, because the caller's job is to record
// it, not to catch it.
//
// The git repository lives at <dir>.git, not inside <dir>, because a deploy renames <dir>: leaving the
// repository in the tree would move it into <dir>.prev and delete it on the next deploy. Provisioning
// clones into <dir>, so the first deploy of an environment moves <dir>/.git across once. The rename
// itself is atomic, but the move is three steps (make the directory, own it, rename into it), and only
// the last one puts a repository anywhere: interrupted before it, this leaves an empty <dir>.git behind.
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
import {
    buildArgv, composeNameOf, deployTrees, downArgv, locationIn, repositoryIn, runCompose, upArgv,
    BUILD_TIMEOUT_MS, SWAP_TIMEOUT_MS, type DeployTrees,
} from './deploy-compose.ts'
import { waitForHealthy } from './deploy-health.ts'

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
}

export type DeployRequest = {
    trigger: DeployTrigger
    actor: string
    // Set by the poller (which has just read the tip) and by a rollback (which names an older commit).
    // Absent for a manual deploy, which reads the tip for itself.
    commit?: string
}

// A tree name of this deploy's own that some other project has registered as its folder. Far-fetched,
// and cheap to refuse: the alternative is a deploy that deletes another client's site.
function treesProblem(registry: Registry, id: string, trees: DeployTrees): string | null {
    const mine = [trees.next, trees.prev, trees.repo]
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
// <dir>.git in place with nothing inside it. Read as "already moved", that empty directory is handed to
// every later deploy's fetch, which can only answer "fatal: not a git repository (or any parent up to
// mount point /var)", in under a second, with no retry able to recover it. Asking for the repository
// instead makes the half-done state something this finishes rather than something it inherits.
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

// Fetch, then the tip of the tracked branch. Separate from runDeploy because the poller needs exactly
// this and nothing else: it compares the answer with the registry's `deployed` before deciding whether
// there is anything to deploy at all.
export async function currentTip(
    project: ProjectEntry, environment: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true, commit: string } | { ok: false, problem: string }> {
    const branch = environment.branch
    if (!branch) return { ok: false, problem: `${project.id} ${environment.name} has no branch to track` }
    const trees = deployTrees(environment.dir)
    try {
        const repo = await ensureRepo(trees, deps)
        if (!repo.ok) return repo
        const fetched = await deps.fetcher.call({ verb: 'fetch', dir: trees.repo, branch, credential: project.credential })
        if (!fetched.ok) return { ok: false, problem: fetched.message }
        const tip = await deps.fetcher.call({ verb: 'tip', dir: trees.repo, branch })
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
        const read = await readEnvFile(environment, file.path, deps.envFs)
        // The path is named, never the contents: an env value must not reach a log line or a record.
        if (!read.ok) return { ok: false, problem: `${file.path} could not be read from the running copy` }
        const written = await writeEnvFile(next, file.path, read.text, deps.envFs)
        if (!written.ok) return { ok: false, problem: `${file.path} could not be written into the new tree` }
    }
    return { ok: true }
}

// The automatic return the design is emphatic about: the new tree is parked back at <dir>.next, the
// previous one takes its place, and only once the previous copy is up and healthy is the failed tree
// removed. Nothing is deleted before its replacement is in place, so an interrupted rollback still
// leaves both copies on disk for the operator to sort out.
async function swapBack(
    project: ProjectEntry, environment: EnvironmentEntry, trees: DeployTrees, name: string, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    if (!(await deps.fs.exists(trees.prev))) return { ok: false, problem: 'there is no previous copy to go back to' }
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

export async function runDeploy(
    project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps,
): Promise<DeployRecord> {
    const startedMs = deps.now()
    const startedAt = new Date(startedMs).toISOString()
    const trees = deployTrees(environment.dir)
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
    if (!environment.branch) return failed(`${project.id} ${environment.name} has no branch to track`)
    const squatter = treesProblem(deps.registry(), project.id, trees)
    if (squatter) return failed(squatter)

    try {
        const free = await deps.fs.freeBytes(environment.dir)
        if (free < MIN_FREE_BYTES) {
            return failed(`only ${Math.round(free / 1024 ** 3)} GB of free disk, and a deploy needs ${MIN_FREE_BYTES / 1024 ** 3} GB`)
        }

        let commit = request.commit
        if (!commit) {
            const tip = await currentTip(project, environment, deps)
            if (!tip.ok) return failed(tip.problem)
            commit = tip.commit
        } else {
            const repo = await ensureRepo(trees, deps)
            if (!repo.ok) return failed(repo.problem)
        }

        const subject = await subjectOf(trees, environment.branch, commit, deps)
        const fail = (reason: string, output: string | null = null) => {
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: failed, ${reason}`)
            return record(commit, subject, 'failed', reason, output)
        }

        // Prepare. A tree left behind by an earlier deploy is removed first: git refuses to add a
        // worktree over an existing folder, and whatever is in there is nobody's current version.
        if (await deps.fs.exists(trees.next)) await deps.fs.rmdir(trees.next)
        const checkedOut = await deps.fetcher.call({ verb: 'checkout', dir: trees.repo, worktree: trees.next, commit })
        if (!checkedOut.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(checkedOut.message)
        }

        const nextEnvironment: EnvironmentEntry = {
            ...environment, dir: trees.next, composePaths: locationIn(environment, trees.next).composePaths,
        }
        const carried = await carryEnvFiles(environment, nextEnvironment, deps)
        if (!carried.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(carried.problem)
        }

        // The checkout above runs as root, in the fetcher, and the env files just carried across run as
        // root here too, so trees.next is root-owned throughout, whatever mode either process left its
        // own entries at. A swap that put that straight into <dir> would still pass the health check
        // below, then take the site down anyway the moment anything but root tried to read its own
        // files. Fixed here, before the build (which reads this same tree) and before the swap, to the
        // ownership <dir> itself already has right now, read fresh rather than assumed, so an operator's
        // own choice of mode (or a future change to it) survives every deploy rather than being baked in
        // once. This is ownership and directory mode, not a substitute for the fetcher checking commits
        // out under a umask that lets git set a file's own mode correctly in the first place (see
        // fetcher/index.ts): own only ever keeps an execute bit it is handed, never invents one.
        const like = await deps.fs.owner(trees.dir)
        await deps.fs.own(trees.next, like)

        // Build. The site is still serving the old version throughout, and a failure here ends the
        // deploy with nothing of the running environment touched.
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: building`)
        const built = await runCompose(buildArgv(locationIn(environment, trees.next), name), BUILD_TIMEOUT_MS, deps.runner)
        if (!built.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(built.message, built.output)
        }

        // Swap. Everything from here until the flag comes down is the only window in which the site is
        // not serving, so it holds no network call and no build: a down, two renames and an up.
        await deps.fs.setMaintenance(key)
        try {
            const down = await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            if (!down.ok) {
                // Nothing has moved, so the old tree is still the site and can be started again by the
                // operator or by the next deploy. Refusing to move on is what keeps that true.
                await deps.fs.rmdir(trees.next).catch(() => {})
                return fail(`the running copy could not be stopped: ${down.message}`, down.output)
            }

            // Only one previous copy is kept, which is what bounds the disk this costs.
            if (await deps.fs.exists(trees.prev)) await deps.fs.rmdir(trees.prev)
            await deps.fs.move(trees.dir, trees.prev)
            await deps.fs.move(trees.next, trees.dir)

            const up = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            const healthy = up.ok
                ? await waitForHealthy(project, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
                : { ok: false as const, problem: up.message }
            if (!healthy.ok) {
                const back = await swapBack(project, environment, trees, name, deps)
                deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: rolled back, ${healthy.problem}`)
                const reason = back.ok
                    ? `${healthy.problem}; rolled back to the previous copy`
                    : `${healthy.problem}; the previous copy did not come back healthy either: ${back.problem}`
                return record(commit, subject, 'rolled-back', reason, up.ok ? null : up.output)
            }
        } finally {
            // Always, including on the way out through a throw: a flag left behind would serve the
            // holding page over a site that is running perfectly well.
            await deps.fs.clearMaintenance(key).catch(() => {})
        }

        // The tree now serving is the one checked out as <dir>.next, and the swap renamed it. Git still
        // records it under the path it was created at, which no longer exists, so anyone who ever runs
        // `git worktree prune` against this repository (an operator tidying up, which is exactly what
        // the stale entry invites) deletes the admin directory <dir>/.git points at, and the live site's
        // tree stops being a repository at all. Repair follows the tree to where it actually is.
        //
        // Outside the maintenance window on purpose: this is a round trip to the fetcher and it touches
        // nothing the site is serving. Best effort for the same reason. The site is up and healthy, and
        // a record that could not be tidied is not a deploy that failed.
        const repaired = await deps.fetcher.call({ verb: 'repair', dir: trees.repo, worktree: trees.dir })
        if (!repaired.ok) {
            deps.log(`deploy ${project.id} ${environment.name}: could not repair the worktree record: ${repaired.message}`)
        }

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
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: deployed`)
        return record(commit, subject, 'ok', null)
    } catch (error) {
        return failed(describeError(error))
    }
}
