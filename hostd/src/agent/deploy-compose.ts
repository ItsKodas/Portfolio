// Compose, aimed at a tree that is not (yet) the environment's own folder. Everything here is built from
// registry values and the folder names derived from them, so no value from a request can reach a command
// line, exactly as in compose.ts.

import { posix } from 'node:path'

import { tail, type Runner } from './compose.ts'
import { isNestedDir, siteOf, nestedDir } from '../shared/layout.ts'
import type { EnvironmentEntry, ProjectEntry } from '../shared/registry.ts'

// Unlike compose.ts's own ComposeLocation, no composeName: every function below takes the project name as
// its own separate argument instead (see base()), which is what lets deploy.ts pin one name (the
// environment's own) across a build in <dir>.next and the swap into <dir> that follows, two different
// locations that must still resolve to the same compose project.
type BuildLocation = { dir: string, composePaths: string[] }

// A build runs the repo's own Dockerfile, which can legitimately take a long time on a cold cache.
export const BUILD_TIMEOUT_MS = 30 * 60_000
// down and up during a swap, while the maintenance page is up: the same bound lifecycle uses.
export const SWAP_TIMEOUT_MS = 120_000

export type DeployTrees = {
    dir: string
    next: string
    prev: string
    // Where the git repository lives once a deploy has moved it out of the tree, so renaming the tree
    // can never take the repository with it. Shared by every environment of a nested site.
    repo: string
    // The repository's original home, inside the tree, as a fresh clone leaves it.
    git: string
    // The folder a nested site keeps everything under, or null for a flat one.
    site: string | null
}

export function deployTrees(dir: string): DeployTrees {
    if (isNestedDir(dir)) {
        const site = siteOf(dir)
        const env = posix.basename(dir)
        return {
            dir, next: posix.join(site, 'next', env), prev: posix.join(site, 'prev', env),
            repo: posix.join(site, 'git'), git: posix.join(dir, '.git'), site,
        }
    }
    return { dir, next: `${dir}.next`, prev: `${dir}.prev`, repo: `${dir}.git`, git: posix.join(dir, '.git'), site: null }
}

// Where a flat environment goes when it is nested, or null when it is not to move (yet). Live goes
// under a site named after its own flat folder. Any other environment waits until live has moved,
// because until then /var/www/<site> is live's own tree and nothing can be put inside it.
export function migrationTarget(project: ProjectEntry, environment: EnvironmentEntry): DeployTrees | null {
    if (isNestedDir(environment.dir)) return null
    if (environment.name === 'live') return deployTrees(nestedDir(environment.dir, 'live'))
    const live = project.environments.get('live')
    if (!live || !isNestedDir(live.dir)) return null
    return deployTrees(nestedDir(siteOf(live.dir), environment.name))
}

// Where a flat live tree waits during its own migration, between leaving /var/www/<site> and
// arriving at /var/www/<site>/prev/live. The one moment the site's folder name is free to be made.
export const migratingOf = (site: string): string => `${site}.migrating`

// What proves <dir>.git holds the repository, rather than merely existing. ensureRepo creates that
// directory one step before the repository moves into it, so the directory on its own proves nothing:
// asking `exists(trees.repo)` and running git there answers "fatal: not a git repository" for every
// deploy from then on. Every reader that has to choose between the tree and the directory beside it asks
// this instead.
export function repositoryIn(trees: DeployTrees): string {
    return posix.join(trees.repo, '.git')
}

// Pinned with --project-name on every deploy step, which is what lets a build in the next tree
// produce the images the swapped-in tree then starts.
export function composeNameOf(environment: EnvironmentEntry): string {
    return environment.composeName
}

// The same compose files the registry named for this environment, resolved inside another tree and in
// the registry's own order, because compose merges -f files left to right.
export function locationIn(environment: EnvironmentEntry, dir: string): BuildLocation {
    return { dir, composePaths: environment.composePaths.map(path => posix.join(dir, posix.relative(environment.dir, path))) }
}

function base(location: BuildLocation, name: string): string[] {
    return ['compose', '--project-name', name, '--project-directory', location.dir, ...location.composePaths.flatMap(path => ['-f', path])]
}

export const buildArgv = (location: BuildLocation, name: string): string[] => [...base(location, name), 'build']
export const upArgv = (location: BuildLocation, name: string): string[] => [...base(location, name), 'up', '-d', '--no-build', '--pull', 'never']
// --remove-orphans, because a commit that deletes a service would otherwise leave its container running
// under this project's name for ever. Never -v: a deploy must not be able to delete a client's data.
export const downArgv = (location: BuildLocation, name: string): string[] => [...base(location, name), 'down', '--remove-orphans']

export type ComposeResult = { ok: true, output: string } | { ok: false, message: string, output: string }

// Which compose subcommand an argv from this module runs, for the message a failure carries. Read by
// position rather than by looking for the word: a project could legitimately be called `up`, and the
// last element is a flag for some subcommands and the subcommand itself for others.
export function subcommandOf(argv: string[]): string {
    const afterFiles = argv.lastIndexOf('-f')
    const afterDirectory = argv.lastIndexOf('--project-directory')
    const at = afterFiles !== -1 ? afterFiles + 2 : afterDirectory !== -1 ? afterDirectory + 2 : 1
    return argv[at] ?? 'compose'
}

export async function runCompose(argv: string[], timeoutMs: number, run: Runner): Promise<ComposeResult> {
    const result = await run('docker', argv, timeoutMs)
    // Compose writes its progress to stderr, so both streams are the output.
    const output = tail([result.stdout, result.stderr].filter(text => text !== '').join('\n'))
    const what = subcommandOf(argv)
    if (result.timedOut) return { ok: false, message: `${what} timed out after ${Math.round(timeoutMs / 1000)} seconds`, output }
    if (result.exitCode === null) return { ok: false, message: `${what} could not run`, output }
    if (result.exitCode !== 0) return { ok: false, message: `${what} exited with code ${result.exitCode}`, output }
    return { ok: true, output }
}
