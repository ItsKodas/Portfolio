// Creates and removes projects and environments end to end. Every step here is undoable only while the
// steps after it have not happened yet, so the order below is load-bearing: nothing is registered before
// it exists on disk, and a failure partway through, whether returned or thrown, removes whatever this put
// on disk and writes nothing to the registry. Concurrent provisioning is Agent's job to serialise, with a
// single global lock (see provisioningBusy in agent.ts, not one keyed per id); the rollback here still
// refuses to remove a folder a write failure says is already claimed, since that folder is then someone
// else's, not this call's own.
// `log` never receives a repo URL, a git message or an env value; only ids, paths and fixed words, so a
// compromised or merely careless log sink can never leak a secret.

import { posix } from 'node:path'
import { randomBytes } from 'node:crypto'

import { PROJECT_ID, CLIENT_ID, HOSTNAME, RESERVED_PROJECT_IDS, describeError, isEnvironmentName } from '../shared/formats.ts'
import {
    GIT_REF, GIT_REPO, DEFAULT_PORT_ENV, PORT_OVERRIDE_FILE,
    type CertificateMode, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry,
} from '../shared/registry.ts'
import type { OwnPort, PortVerdict } from '../shared/ports.ts'
import { RegistryWriter, type Change } from '../shared/registry-write.ts'
import type { FetchClient } from './fetch-client.ts'
import { runLifecycle, type ComposeLocation, type GuessedService, type Runner } from './compose.ts'
import type { PortOverrideResult } from './port-override.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, createMissingEnvFiles, type EnvFs } from './env-files.ts'
import { isExampleName } from '../shared/envfiles.ts'
import { isNestedDir, nestedDir, siteOf } from '../shared/layout.ts'
import {
    refuse, parseCreateExtras,
    type AgentReply, type ProvisionAddEnvironmentArgs, type ProvisionCreateArgs, type Refusal,
} from '../shared/protocol.ts'

const DEFAULT_COMPOSE = ['docker-compose.yml']
// The keys a value's domain gets rewritten under, and nothing else: a database password or an API key
// that happens to end in one of these letters is never touched, because those never end with them.
const DOMAIN_KEY_SUFFIXES = ['_URL', '_HOST', '_DOMAIN', '_ORIGIN']
// Exactly which keys name a database, and nothing else: an unrestricted substring replacement over every
// value would also rewrite S3_BUCKET=acme-assets, GITHUB_REPO=ItsKodas/acme or SMTP_USER=noreply@acme.com
// whenever the project id happens to appear inside them, corrupting values that have nothing to do with
// the database this is actually meant to repoint.
const DATABASE_KEYS = new Set(['DATABASE_URL', 'DATABASE_NAME', 'DB_NAME', 'DB_DATABASE'])
const DATABASE_KEY_SUFFIXES = ['_DATABASE', '_DB']
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

export type ProvisionDeps = {
    registry: () => Registry
    // Reloads the registry from disk before registry() is read below, so the id, domain and port checks
    // that follow all see one fresh snapshot rather than choosePort alone refreshing for itself: the
    // store only reloads on its own 10 second timer otherwise, and a create issued just after another one
    // could see an id, domain or port that one just took as still free.
    refreshRegistry: () => Promise<void>
    writer: RegistryWriter
    fetcher: FetchClient
    choosePort: () => Promise<{ ok: true, port: number } | { ok: false, problem: string }>
    // Whether a port the operator named is free: the same rule choosePort applies, against the registry
    // and a fresh reading of the host. own is the environment the port is for, whose current port is not
    // counted against it.
    checkPort: (port: number, own?: OwnPort) => Promise<PortVerdict>
    // Writes <key>=<port> into the environment's root .env (port-env.ts), answering what was there. A
    // dependency rather than a direct call, so a test never writes to a real /var/www.
    setPortEnv: (environment: EnvironmentEntry, key: string, port: number) => Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>
    // Writes hostd.ports.yml into location.dir from the environment's own compose files and answers its
    // full compose list, override last (port-override.ts). A dependency so a test never runs compose or
    // writes into a real /var/www.
    portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>
    // Removes an environment's hostd.ports.yml, for a port change's undo. A file already gone is not an error.
    removePortOverride: (dir: string) => Promise<void>
    // Never recursive: a missing parent is a refusal, not something to make on the way.
    mkdir(dir: string): Promise<void>
    // A plain rename, only ever within one site folder: how a new site's repository leaves live/.git for
    // the git/ folder beside it.
    move(from: string, to: string): Promise<void>
    rmdir(dir: string): Promise<void>
    exists(dir: string): Promise<boolean>
    // The same pair deploy.ts's DeployFs already defines, for the same reason and with the same
    // implementations behind them (see own-tree.ts). `owner` reads an existing path's ownership and mode,
    // never guesses one; `own` applies it to a whole tree this process just put on disk.
    owner(path: string): Promise<{ uid: number, gid: number, mode: number }>
    own(dir: string, like: { uid: number, gid: number, mode: number }): Promise<void>
    // expectedName is the environment's own compose name, the one it will actually run under:
    // resolveNewProject checks it against the compose file's own project name, the same guard the ongoing
    // sweep runs, but here before anything is written. collidesWith, only ever passed for an environment
    // other than live, is the live environment's own expected name, so pinning it there gets a message
    // about the collision.
    // composePaths is every file the environment runs with, in compose's merge order: whatever the
    // operator named at create (docker-compose.yml when they named nothing), so a file missing from the
    // clone, or an override that does not merge, refuses the create instead of surfacing at first deploy.
    resolve(expectedName: string, dir: string, composePaths: string[], collidesWith?: string): Promise<{ ok: true, services: Record<string, GuessedService>, published: number[] } | { ok: false, problem: string }>
    // Only ever used to stop the live environment before removeProject unregisters a whole project: there
    // is no per-environment lifecycle yet (see RUNBOOK.md), so this is never asked to touch test.
    runner: Runner
    log(message: string): void
    // Whether this project deleted an environment of this name that the purge has not removed yet
    // (environment-trash.ts), whose files and volumes are still kept for a restore. Adding one under the
    // same name would take the folder and the compose name that restore needs back. Absent means
    // nothing is ever kept, so nothing is refused.
    deletedWithin?: (project: string, environment: string) => Promise<boolean>
}

function fieldProblem(args: ProvisionCreateArgs): string | null {
    if (!PROJECT_ID.test(args.id)) return 'id must be lowercase letters, digits and hyphens, 2 to 31 characters'
    if (args.client !== undefined && !CLIENT_ID.test(args.client)) return 'client must be 1 to 64 letters, digits, underscores or hyphens'
    if (args.name.length < 1 || args.name.length > 100) return 'name must be 1 to 100 characters'
    if (!GIT_REPO.test(args.repo)) return 'repo must be an ssh or https git URL'
    if (!GIT_REF.test(args.branch)) return 'branch must be a plain branch name'
    if (args.domain !== null && !HOSTNAME.test(args.domain)) return 'domain must be a lowercase hostname'
    // The optional fields, through the same parser api and the request line already ran them through:
    // the agent's own check, rather than a trust in theirs.
    const extras = parseCreateExtras(args)
    if (!extras.ok) return extras.message
    return null
}

// A create's domain against every other project's: a create has no environments of its own yet.
function domainTaken(registry: Registry, domain: string): boolean {
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) {
            if (environment.domain === domain) return true
        }
    }
    return false
}

// An add-environment's domain against every hostname anything already serves, this project's own other
// environments included: two environments of one site answering one name collide exactly as two sites
// would, and an alias is as much a claim on a name as a primary is.
function hostnameTaken(registry: Registry, hostname: string): boolean {
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) {
            if (environment.domain === hostname || environment.aliases.includes(hostname)) return true
        }
    }
    return false
}

// The port check's registry side only ever sees registry.projects, which excludes anything already
// invalid, and the host's listening ports only show what is running; a temporarily invalid entry whose
// containers are stopped is invisible to both, so a new project could take its port and collide the
// moment that entry is fixed.
// Refusing provisioning outright while anything is invalid is the honest fix: naming the ids and asking
// the operator to fix them first, rather than trying to parse a port out of a broken entry.
function invalidRegistryProblem(registry: Registry): string | null {
    if (registry.invalid.size === 0) return null
    return `fix these invalid projects before provisioning: ${[...registry.invalid.keys()].sort().join(', ')}`
}

// Said the same way by create, add-environment and a port change. hostd wrote the override itself, so
// this only happens when it did not take effect, and the operator is pointed at the file, not the repo.
export function notPublishedProblem(dir: string, port: number): string {
    return `hostd could not publish port ${port} (its override did not take effect); check ${PORT_OVERRIDE_FILE} in ${dir}`
}

function isDatabaseKey(key: string): boolean {
    return DATABASE_KEYS.has(key) || DATABASE_KEY_SUFFIXES.some(suffix => key.endsWith(suffix))
}

// A best-effort text rewrite, not an env-file parser: a line that is not KEY=VALUE (a comment, a blank
// line, something malformed) is carried through untouched rather than guessed at.
//
// The domain substitution runs behind a one-off placeholder, generated fresh per call, rather than
// straight into the value: the new domain conventionally embeds the project id itself (uat1.acme.com,
// for project acme), so substituting the domain first and then blindly replacing every occurrence of the
// database name would re-match "acme" inside the domain this just wrote, corrupting it. Parking the
// substituted domain behind a placeholder the database rule cannot match, then restoring it last, avoids
// that regardless of how the two happen to overlap. The database rule itself is restricted to keys that
// actually name a database (see isDatabaseKey), so it never touches an unrelated value that merely
// contains the project id as a substring.
function rewriteEnvText(
    text: string,
    live: { domain: string | null, database: string },
    target: { domain: string | null, database: string },
): string {
    const placeholder = `__hostd_domain_${randomBytes(8).toString('hex')}__`
    return text.split('\n').map(line => {
        const match = ENV_LINE.exec(line)
        if (!match) return line
        const key = match[1]!
        let value = match[2]!
        const rewriteDomain = Boolean(live.domain && target.domain && value.includes(live.domain) && DOMAIN_KEY_SUFFIXES.some(suffix => key.endsWith(suffix)))
        const rewriteDatabase = isDatabaseKey(key) && value.includes(live.database)
        if (rewriteDomain) value = value.split(live.domain!).join(placeholder)
        if (rewriteDatabase) value = value.split(live.database).join(target.database)
        if (rewriteDomain) value = value.split(placeholder).join(target.domain!)
        return `${key}=${value}`
    }).join('\n')
}

// Copies every env file the live environment has into the freshly checked out folder of a new
// environment, pointing anything that looks like the site's own URL or database at the new one instead:
// database <id> becomes <id>-<name>. Returns the paths that could not be copied: a silently-missing file
// is not a safe outcome here, because the checkout has already put the repo's own committed copy of that
// file in place, which plausibly still points at the live database.
async function copyEnvFiles(
    projectId: string, live: EnvironmentEntry, target: EnvironmentEntry, envFs: EnvFs | undefined, deps: ProvisionDeps,
): Promise<string[]> {
    const files = await listEnvFiles(live, envFs)
    const liveDatabase = projectId
    const targetDatabase = `${projectId}-${target.name}`
    const failures: string[] = []
    for (const file of files) {
        // The clone has already put the repo's own committed copy in place, which is the point of an
        // example: there is nothing here to copy over it. See isExampleName.
        if (isExampleName(file.path)) continue
        const read = await readEnvFile(live, file.path, envFs)
        if (!read.ok) {
            failures.push(file.path)
            continue
        }
        const rewritten = rewriteEnvText(
            read.text,
            { domain: live.domain, database: liveDatabase },
            { domain: target.domain, database: targetDatabase },
        )
        const written = await writeEnvFile(target, file.path, rewritten, envFs)
        if (written.ok) deps.log(`provision ${projectId}: copied ${file.path} into the ${target.name} environment`)
        else failures.push(file.path)
    }
    return failures
}

type ProvisionAttempt = {
    id: string
    // The environment's own folder: what is cloned or checked out into, and what resolve reads.
    dir: string
    // The folder this call makes, owns, and removes again on a rollback. A new nested site's is the site
    // folder, which holds live and the repository split out of it; everywhere else it is dir itself. A
    // new environment's worktree root is its own folder only, never the site around it, which is live's
    // as much as its own.
    root: string
    // Where the tree comes from: a fresh clone of repo into dir, or a worktree of a repository already on
    // disk (a nested site's shared git/), which git makes the folder for itself.
    source: { kind: 'clone' } | { kind: 'worktree', repo: string }
    repo: string
    branch: string
    // Which of the fetcher's tokens the clone authenticates with. null is the default GITHUB_TOKEN, the
    // same meaning it carries on the registry entry and on the fetch protocol itself.
    credential: string | null
    // Only ever set by addEnvironment, to the live environment's own compose name, which is what another
    // environment's compose file must never be pinned to (see composeNameProblem in compose.ts). Absent
    // for createProject, since live has no other environment to collide with yet.
    collidesWith?: string
    // The compose project name this environment will run under, checked by resolve before anything is
    // registered.
    composeName: string
    // The existing directory whose ownership and mode the new tree should take. Read, never assumed, the
    // same rule deploy.ts follows for a checkout and a repository directory. createProject names the
    // parent, /var/www, because a brand new project has no directory of its own anywhere yet;
    // addEnvironment names the site folder the new environment's tree sits in.
    likeDir: string
    // Relative to dir, in compose's merge order
    compose: string[]
    // The port this environment gets. provisionOnDisk writes it into .env straight after the clone
    // (after afterClone, so it wins over a .env copied from live) and refuses unless compose publishes it.
    port: number
    portEnv: string
    // Runs after a successful clone or checkout, before resolve. A no-op for create; addEnvironment copies
    // and rewrites env files here, into the new environment's folder.
    afterClone: (composePath: string) => Promise<{ ok: true } | { ok: false, problem: string }>
    // Given the services resolve found (each guessed site or database) and the environment's compose
    // list relative to dir (the repo's files, then hostd.ports.yml), attempts the registry write. Only
    // createProject's services are ever non-empty going in; addEnvironment's write ignores the argument.
    // `conflict: true` on a failure (set by registry-write.ts's own edit(), not guessed from the message
    // text) means someone else's entry already claims this id or environment: the folder this call made
    // is then not this call's to remove, because it may not even be this call's folder any more. The
    // single global provisioning lock in agent.ts is the primary defense against that race; this is the
    // fallback for whatever reaches the write despite it.
    write: (services: Record<string, GuessedService>, compose: string[]) => Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
}

// The mkdir/clone/resolve/write sequence shared by createProject and addEnvironment: the exact ordering
// that makes each step undoable only while the later ones have not happened. A throw from any dependency
// (the fetcher on a timeout or a dropped connection, a filesystem call, resolve) is rolled back exactly
// like a returned failure would be: nothing here assumes a dependency can only fail by returning `ok:
// false`. A rollback only ever removes `root`, and only once this call has put it on disk.
async function provisionOnDisk(attempt: ProvisionAttempt, deps: ProvisionDeps): Promise<Refusal | { ok: true, composePaths: string[] }> {
    const { id, dir, root } = attempt
    // Whether `root` is on disk as this call's own yet: a worktree's fetch or tip failing leaves nothing
    // behind, and removing a folder then could only ever remove one this call did not make.
    let made = false

    const rollback = async (reason: string): Promise<void> => {
        if (!made) {
            deps.log(`provision ${id}: ${reason}, nothing to remove`)
            return
        }
        deps.log(`provision ${id}: ${reason}, removing ${root}`)
        try {
            await deps.rmdir(root)
        } catch (error) {
            deps.log(`provision ${id}: could not remove ${root}: ${describeError(error)}`)
        }
    }

    if (attempt.source.kind === 'clone') {
        deps.log(`provision ${id}: creating ${root}`)
        try {
            await deps.mkdir(root)
        } catch (error) {
            // Nothing of this call's is on disk yet: mkdir itself is what failed, not a step after it. In
            // particular a failure of EEXIST means the folder is already someone or something else's, and
            // removing it would delete contents this call never created.
            deps.log(`provision ${id}: could not create ${root}: ${describeError(error)}`)
            return refuse('failed', describeError(error))
        }
        made = true
    }

    try {
        if (attempt.source.kind === 'clone') {
            // A new nested site: live is made inside the site folder just made, so a failure from here
            // on removes the site folder as a whole.
            if (dir !== root) await deps.mkdir(dir)
            const cloned = await deps.fetcher.call({ verb: 'clone', repo: attempt.repo, dir, branch: attempt.branch, credential: attempt.credential })
            if (!cloned.ok) {
                await rollback('clone failed')
                return refuse('failed', cloned.message)
            }
            // The repository leaves live straight away for the site's shared git/ folder, which is where
            // the first deploy (and adding an environment) look for it. A rename within one folder, so it is whole
            // or not done at all, and a failure removes the site folder like any other step.
            if (dir !== root) {
                const git = posix.join(root, 'git')
                await deps.mkdir(git)
                await deps.move(posix.join(dir, '.git'), posix.join(git, '.git'))
                deps.log(`provision ${id}: moved the git repository to ${git}`)
            }
        } else {
            const repo = attempt.source.repo
            const fetched = await deps.fetcher.call({ verb: 'fetch', dir: repo, branch: attempt.branch, credential: attempt.credential })
            if (!fetched.ok) {
                await rollback('fetch failed')
                return refuse('failed', fetched.message)
            }
            const tip = await deps.fetcher.call({ verb: 'tip', dir: repo, branch: attempt.branch })
            if (!tip.ok) {
                await rollback('tip failed')
                return refuse('failed', tip.message)
            }
            if (!tip.commit) {
                await rollback('tip gave no commit')
                return refuse('failed', `the fetcher gave no commit for ${attempt.branch}`)
            }
            // git makes the worktree's folder itself, and can leave part of it behind when it fails, so
            // it counts as this call's from the moment the checkout is asked for. A rollback removes the
            // folder and nothing else; the worktree record git keeps for it is left for `worktree add
            // --force` and repair to deal with, the same as a deploy's own failed checkout.
            deps.log(`provision ${id}: adding ${dir} as a worktree of ${repo}`)
            made = true
            const checkedOut = await deps.fetcher.call({ verb: 'checkout', dir: repo, worktree: dir, commit: tip.commit })
            if (!checkedOut.ok) {
                await rollback('checkout failed')
                return refuse('failed', checkedOut.message)
            }
        }

        const composePaths = attempt.compose.map(file => posix.join(dir, file))

        const after = await attempt.afterClone(composePaths[0]!)
        if (!after.ok) {
            await rollback('setup failed')
            return refuse('failed', after.problem)
        }

        // Before own, so .env is covered by it, and before resolve, which interpolates it
        const portWritten = await deps.setPortEnv(
            { name: 'live', dir, composePaths, composeName: attempt.composeName, branch: attempt.branch, domain: null, aliases: [], port: attempt.port, certificate: null, deployed: null, websockets: false, flexibleSsl: false },
            attempt.portEnv, attempt.port,
        )
        if (!portWritten.ok) {
            await rollback('writing the port failed')
            return refuse('failed', portWritten.problem)
        }

        // After the port is in .env, which the repo's own mappings may read, and before own, so the new
        // file is owned with the rest of the tree
        const override = await deps.portOverride({ dir, composePaths, composeName: attempt.composeName }, attempt.portEnv)
        if (!override.ok) {
            await rollback('publishing the port failed')
            return refuse('invalid-project', override.problem)
        }
        deps.log(`provision ${id}: published ${attempt.port} to ${override.service}:${override.target}`)
        const merged = override.composePaths

        // Everything under `root` is root's until here: the clone or checkout ran as root in the fetcher,
        // the repository split out beside a new live moved with it, and the env files afterClone just
        // created or copied were written as root by this process, into a directory
        // this process made under its own restrictive umask (see index.ts). Left like that, a site is
        // created that the operator cannot read, edit or start by hand, unlike every hand-enrolled site
        // beside it, and unlike what the first deploy would leave behind once deploy.ts does this same
        // step. Owned after afterClone rather than straight after the clone, so the env files are covered
        // too, and before resolve and the registry write, so nothing unusable is ever registered. A
        // failure here throws into the catch below, which rolls the folder back, on the same reasoning as
        // every other step: half-owned is not a state worth registering.
        const like = await deps.owner(attempt.likeDir)
        await deps.own(root, like)

        // The expected compose project name is the environment's own composeName, checked against what
        // compose actually resolves before anything is registered: the project id for a nested live,
        // and <id>-<name> for any other environment. Comparing another environment's resolved name
        // against the bare id would refuse the ordinary case for every repo.
        const resolved = await deps.resolve(attempt.composeName, dir, merged, attempt.collidesWith)
        if (!resolved.ok) {
            // Named plainly, both in the log and the refusal: this is docker compose's own error (a
            // missing env_file, a syntax error, a command that could not run), not "no site service",
            // which is a different, narrower case handled below.
            await rollback(`resolve failed: ${resolved.problem}`)
            return refuse('invalid-project', resolved.problem)
        }
        if (Object.keys(resolved.services).length === 0) {
            await rollback('compose declares no services')
            return refuse('invalid-project', 'the compose file declares no services')
        }
        if (!resolved.published.includes(attempt.port)) {
            await rollback(`compose does not publish port ${attempt.port}`)
            return refuse('invalid-project', notPublishedProblem(dir, attempt.port))
        }

        const written = await attempt.write(resolved.services, merged.map(path => posix.relative(dir, path)))
        if (!written.ok) {
            if (written.conflict) {
                deps.log(`provision ${id}: registry write failed, leaving ${root} in place (already claimed)`)
                return refuse('failed', written.problem)
            }
            await rollback('registry write failed')
            return refuse('failed', written.problem)
        }

        deps.log(`provision ${id}: created`)
        return { ok: true, composePaths: merged }
    } catch (error) {
        await rollback(`unexpected error (${describeError(error)})`)
        return refuse('failed', describeError(error))
    }
}

export async function createProject(args: ProvisionCreateArgs, deps: ProvisionDeps, envFs?: EnvFs): Promise<AgentReply> {
    const problem = fieldProblem(args)
    if (problem) return refuse('bad-request', problem)

    // Refreshed once, here, before any of id, domain or port is checked, so all three see the same
    // snapshot: refreshing only inside choosePort would still let the id and domain checks above it run
    // against a registry the store has not reloaded yet.
    await deps.refreshRegistry()
    const registry = deps.registry()
    const invalidProblem = invalidRegistryProblem(registry)
    if (invalidProblem) return refuse('unavailable', invalidProblem)
    if (RESERVED_PROJECT_IDS.has(args.id)) return refuse('bad-request', `${args.id} is reserved for the operator's own stacks`)
    if (registry.projects.has(args.id) || registry.invalid.has(args.id)) return refuse('bad-request', `${args.id} is already registered`)
    // Every new site is nested: one folder under /var/www holding live, and the repository split out of
    // it into git/ beside live. The site folder as a whole is what must not exist yet.
    const site = `/var/www/${args.dir ?? args.id}`
    const dir = nestedDir(site, 'live')
    const compose = args.compose ?? DEFAULT_COMPOSE
    const flags = { websockets: args.websockets ?? false, flexibleSsl: args.flexibleSsl ?? false }
    if (await deps.exists(site)) return refuse('bad-request', `${site} already exists`)
    if (args.domain && domainTaken(registry, args.domain)) return refuse('bad-request', `${args.domain} is already used by another project`)

    let port: { ok: true, port: number }
    if (args.port === undefined) {
        const chosen = await deps.choosePort()
        if (!chosen.ok) return refuse('unavailable', chosen.problem)
        port = chosen
    } else {
        // Checked here, under the agent's provisioning lock, whatever the portal's live check said
        const verdict = await deps.checkPort(args.port)
        if (!verdict.ok) return refuse(verdict.code, verdict.problem)
        port = { ok: true, port: args.port }
    }

    const attempt = await provisionOnDisk({
        id: args.id,
        dir,
        root: site,
        source: { kind: 'clone' },
        repo: args.repo,
        branch: args.branch,
        // A create has no registry entry to read a credential from yet, so it comes straight from the
        // args: null when the operator named none, which means the default token.
        credential: args.credential ?? null,
        // /var/www itself, the folder this project is being created inside: the only thing on disk that
        // says who the operator is when the project has nothing of its own to read it from yet. If that
        // directory belongs to root, so does the new site, which is no worse than today and stays
        // consistent with its neighbours either way.
        likeDir: '/var/www',
        // A nested live's default compose name, which the registry entry therefore never has to spell
        // out: the id, whatever the site folder is called.
        composeName: args.id,
        compose,
        port: port.port,
        // A new project has no `portEnv` key yet, so it gets the default.
        portEnv: DEFAULT_PORT_ENV,
        // A repo usually commits an example beside a gitignored real file, and its compose file usually
        // declares env_file against the real one; resolve (just below, in provisionOnDisk) would
        // otherwise fail on a repo that has done nothing wrong, before the operator ever gets to fill
        // the real file in.
        afterClone: async () => {
            const created = await createMissingEnvFiles(dir, envFs)
            for (const path of created) deps.log(`provision ${args.id}: created an empty ${path} for its .example`)
            return { ok: true }
        },
        write: (services, written) => deps.writer.write({
            kind: 'add-project',
            id: args.id,
            project: {
                client: args.client ?? null,
                name: args.name,
                repo: args.repo,
                ...(args.credential ? { credential: args.credential } : {}),
                capabilities: args.capabilities ?? [],
                services,
                environment: {
                    name: 'live', dir, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate,
                    compose: written, ...flags,
                },
            },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const live: EnvironmentEntry = {
        name: 'live', dir, composePaths: attempt.composePaths, composeName: args.id, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null, ...flags,
    }
    const envFiles = await listEnvFiles(live, envFs)
    return { ok: true, project: { id: args.id, state: 'needs-setup' }, envFiles }
}

export async function addEnvironment(project: ProjectEntry, args: ProvisionAddEnvironmentArgs, deps: ProvisionDeps, envFs?: EnvFs): Promise<AgentReply> {
    // The agent's own check of the name, rather than a trust in the parser's: live is every project's
    // from its create, and a reserved name is a folder of the nested layout or a route segment.
    const name = args.environment
    if (name === 'live') return refuse('bad-request', 'live cannot be added')
    if (!isEnvironmentName(name)) return refuse('bad-request', 'environment must be an environment name')
    if (!GIT_REF.test(args.branch)) return refuse('bad-request', 'branch must be a plain branch name')
    if (args.domain !== null && !HOSTNAME.test(args.domain)) return refuse('bad-request', 'domain must be a lowercase hostname')
    if (!project.repo) return refuse('invalid-project', `${project.id} has no repo to clone from`)
    if (project.environments.has(name)) return refuse('bad-request', `${project.id} already has a ${name} environment`)
    // A deleted environment's tree and volumes wait under its name for a restore; a new one taking the
    // name would take the folder and the compose project that restore puts back.
    if (deps.deletedWithin && await deps.deletedWithin(project.id, name)) {
        return refuse('bad-request', `${name} was deleted less than 30 days ago; restore it or wait for it to be purged`)
    }

    // Every environment beside live is a worktree at <site>/<name> of the one repository the site
    // shares. A flat live has no site folder or shared repository to put one in: its first deploy moves
    // it into the nested layout, and that is the only route there.
    if (!isNestedDir(project.dir)) return refuse('bad-request', 'deploy live once so it moves into the nested layout, then add environments')
    const site = siteOf(project.dir)
    const dir = nestedDir(site, name)
    const composeName = `${project.id}-${name}`
    if (await deps.exists(dir)) return refuse('bad-request', `${dir} already exists`)
    // createProject splits the repository out of live straight after cloning, so a nested site without
    // one here is one somebody changed by hand: refused rather than guessed at.
    const repository = posix.join(site, 'git')
    if (!(await deps.exists(posix.join(repository, '.git')))) return refuse('unavailable', `${repository} has no repository to add ${name} from`)

    // Same reasoning as createProject: refresh before the domain and port checks, not just inside
    // choosePort, so both see the same snapshot.
    await deps.refreshRegistry()
    const registry = deps.registry()
    const invalidProblem = invalidRegistryProblem(registry)
    if (invalidProblem) return refuse('unavailable', invalidProblem)
    if (args.domain && hostnameTaken(registry, args.domain)) return refuse('bad-request', `${args.domain} is already used by another project or environment`)

    const port = await deps.choosePort()
    if (!port.ok) return refuse('unavailable', port.problem)

    const attempt = await provisionOnDisk({
        id: project.id,
        dir,
        // The new environment's own folder only: never the site folder, which is live's and every other
        // environment's as much as this one's.
        root: dir,
        source: { kind: 'worktree', repo: repository },
        repo: project.repo,
        branch: args.branch,
        // The project already has a registry entry, so its own credential is what the fetch
        // authenticates with too: every environment of one project is one GitHub account.
        credential: project.credential,
        // The live environment's own expected compose name: another environment pinning it would share
        // one compose project with live, and starting it would take over live's running containers.
        collidesWith: project.composeName,
        // The site folder the new environment sits in, not /var/www: whatever the operator chose for the
        // site is what its environments should match, the same way deploy.ts patterns a checkout on
        // <dir> rather than on anything further out.
        likeDir: site,
        composeName,
        compose: DEFAULT_COMPOSE,
        port: port.port,
        portEnv: project.portEnv,
        afterClone: async composePath => {
            const live = project.environments.get('live')
            if (!live) return { ok: true }
            const added: EnvironmentEntry = {
                name, dir, composePaths: [composePath], composeName, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null, websockets: false, flexibleSsl: false,
            }
            const failures = await copyEnvFiles(project.id, live, added, envFs, deps)
            if (failures.length > 0) return { ok: false, problem: `could not copy ${failures.join(', ')} from the live environment` }
            // Fills any gap the copy above left: an env file live never had at all (so there was nothing
            // to copy) but the repo still commits an example for, on the same reasoning as createProject.
            const created = await createMissingEnvFiles(dir, envFs)
            for (const path of created) deps.log(`provision ${project.id}: created an empty ${path} for its .example`)
            return { ok: true }
        },
        write: (_services, written) => deps.writer.write({
            kind: 'add-environment',
            id: project.id,
            environment: { name, dir, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, compose: written },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const added: EnvironmentEntry = {
        name, dir, composePaths: attempt.composePaths, composeName, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null, websockets: false, flexibleSsl: false,
    }
    const envFiles = await listEnvFiles(added, envFs)
    return { ok: true, project: { id: project.id, state: 'needs-setup' }, envFiles }
}

// Removing a whole site. One environment is deleted into the site's trash instead (environment-trash.ts).
export async function removeProject(project: ProjectEntry, deps: ProvisionDeps): Promise<AgentReply> {
    // Removing the whole project must stop it first: otherwise the site keeps serving with nothing left
    // in the registry able to stop it, since every lifecycle verb answers unknown-project the instant it
    // is unregistered. A failed stop refuses rather than unregistering anyway: an operator can retry, or
    // stop it by hand, but a project must never go unregistered while still running.
    const stopped = await runLifecycle(project, 'stop', deps.runner)
    if (!stopped.ok) return refuse('failed', `could not stop ${project.id} before removing it: ${stopped.message}`, stopped.output)

    const written = await deps.writer.write({ kind: 'remove-project', id: project.id })
    if (!written.ok) return refuse('failed', written.problem)

    deps.log(`provision ${project.id}: unregistered, its containers stopped first, left ${project.dir} in place`)
    return {
        ok: true,
        output: `${project.id} was stopped and unregistered; ${project.dir} was left in place, along with its volumes and databases`,
    }
}
