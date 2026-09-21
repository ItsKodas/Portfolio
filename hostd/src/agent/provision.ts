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

import { PROJECT_ID, CLIENT_ID, HOSTNAME, RESERVED_PROJECT_IDS, describeError } from '../shared/formats.ts'
import {
    GIT_REF, GIT_REPO,
    type CertificateMode, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry,
} from '../shared/registry.ts'
import { RegistryWriter, type Change } from '../shared/registry-write.ts'
import type { FetchClient } from './fetch-client.ts'
import { runLifecycle, type GuessedService, type Runner } from './compose.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, createMissingEnvFiles, type EnvFs } from './env-files.ts'
import {
    refuse,
    type AgentReply, type ProvisionAddEnvironmentArgs, type ProvisionCreateArgs, type Refusal,
} from '../shared/protocol.ts'

const COMPOSE_FILE = 'docker-compose.yml'
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
    mkdir(dir: string): Promise<void>
    rmdir(dir: string): Promise<void>
    exists(dir: string): Promise<boolean>
    // The same pair deploy.ts's DeployFs already defines, for the same reason and with the same
    // implementations behind them (see own-tree.ts). `owner` reads an existing path's ownership and mode,
    // never guesses one; `own` applies it to a whole tree this process just put on disk.
    owner(path: string): Promise<{ uid: number, gid: number, mode: number }>
    own(dir: string, like: { uid: number, gid: number, mode: number }): Promise<void>
    // expectedName is the folder's own basename (what an unpinned compose file resolves to): resolveNewProject
    // checks it against the compose file's own project name, the same guard the ongoing sweep runs, but
    // here before anything is written. collidesWith, only ever passed for a test environment, is the
    // live environment's own expected name, so pinning it there gets a message about the collision.
    // composePath is deliberately singular, unlike the registry's own compose list: a fresh clone gives
    // nothing that says which extra compose files (an override, a production file) the operator intends,
    // so this only ever resolves the base docker-compose.yml. If the repo actually runs with more than
    // one file, an unnamed one is invisible to hostd from here on; RUNBOOK.md's Creating a site, step 2,
    // is where the operator is meant to list them all in the registry entry.
    resolve(expectedName: string, dir: string, composePath: string, collidesWith?: string): Promise<{ ok: true, services: Record<string, GuessedService> } | { ok: false, problem: string }>
    // Only ever used to stop the live environment before removeProject unregisters a whole project: there
    // is no per-environment lifecycle yet (see RUNBOOK.md), so this is never asked to touch test.
    runner: Runner
    log(message: string): void
}

function fieldProblem(args: ProvisionCreateArgs): string | null {
    if (!PROJECT_ID.test(args.id)) return 'id must be lowercase letters, digits and hyphens, 2 to 31 characters'
    if (!CLIENT_ID.test(args.client)) return 'client must be 1 to 64 letters, digits, underscores or hyphens'
    if (args.name.length < 1 || args.name.length > 100) return 'name must be 1 to 100 characters'
    if (!GIT_REPO.test(args.repo)) return 'repo must be an ssh or https git URL'
    if (!GIT_REF.test(args.branch)) return 'branch must be a plain branch name'
    if (args.domain !== null && !HOSTNAME.test(args.domain)) return 'domain must be a lowercase hostname'
    return null
}

// Only ever compares against a project other than the one this domain would land on: a create has no
// existing project to exclude, an add-environment excludes the project it is adding to.
function domainTaken(registry: Registry, domain: string, excludeId?: string): boolean {
    for (const [id, project] of registry.projects) {
        if (id === excludeId) continue
        for (const environment of project.environments.values()) {
            if (environment.domain === domain) return true
        }
    }
    return false
}

// takenPorts only ever sees registry.projects, which excludes anything already invalid, and Docker's own
// published ports only see running containers; a temporarily invalid entry whose containers are stopped
// is invisible to both, so a new project could take its port and collide the moment that entry is fixed.
// Refusing provisioning outright while anything is invalid is the honest fix: naming the ids and asking
// the operator to fix them first, rather than trying to parse a port out of a broken entry.
function invalidRegistryProblem(registry: Registry): string | null {
    if (registry.invalid.size === 0) return null
    return `fix these invalid projects before provisioning: ${[...registry.invalid.keys()].sort().join(', ')}`
}

function isDatabaseKey(key: string): boolean {
    return DATABASE_KEYS.has(key) || DATABASE_KEY_SUFFIXES.some(suffix => key.endsWith(suffix))
}

// A best-effort text rewrite, not an env-file parser: a line that is not KEY=VALUE (a comment, a blank
// line, something malformed) is carried through untouched rather than guessed at.
//
// The domain substitution runs behind a one-off placeholder, generated fresh per call, rather than
// straight into the value: the test domain conventionally embeds the project id itself (test.acme.com,
// for project acme), so substituting the domain first and then blindly replacing every occurrence of the
// database name would re-match "acme" inside the domain this just wrote, corrupting it. Parking the
// substituted domain behind a placeholder the database rule cannot match, then restoring it last, avoids
// that regardless of how the two happen to overlap. The database rule itself is restricted to keys that
// actually name a database (see isDatabaseKey), so it never touches an unrelated value that merely
// contains the project id as a substring.
function rewriteEnvText(
    text: string,
    live: { domain: string | null, database: string },
    test: { domain: string | null, database: string },
): string {
    const placeholder = `__hostd_domain_${randomBytes(8).toString('hex')}__`
    return text.split('\n').map(line => {
        const match = ENV_LINE.exec(line)
        if (!match) return line
        const key = match[1]!
        let value = match[2]!
        const rewriteDomain = Boolean(live.domain && test.domain && value.includes(live.domain) && DOMAIN_KEY_SUFFIXES.some(suffix => key.endsWith(suffix)))
        const rewriteDatabase = isDatabaseKey(key) && value.includes(live.database)
        if (rewriteDomain) value = value.split(live.domain!).join(placeholder)
        if (rewriteDatabase) value = value.split(live.database).join(test.database)
        if (rewriteDomain) value = value.split(placeholder).join(test.domain!)
        return `${key}=${value}`
    }).join('\n')
}

// Copies every env file the live environment has into the freshly cloned test folder, pointing anything
// that looks like the site's own URL or database at the test side instead. Returns the paths that could
// not be copied: a silently-missing file is not a safe outcome here, because the clone has already put
// the repo's own committed copy of that file in place, which plausibly still points at the live database.
async function copyEnvFiles(
    projectId: string, live: EnvironmentEntry, test: EnvironmentEntry, envFs: EnvFs | undefined, deps: ProvisionDeps,
): Promise<string[]> {
    const files = await listEnvFiles(live, envFs)
    const liveDatabase = projectId
    const testDatabase = `${projectId}-test`
    const failures: string[] = []
    for (const file of files) {
        const read = await readEnvFile(live, file.path, envFs)
        if (!read.ok) {
            failures.push(file.path)
            continue
        }
        const rewritten = rewriteEnvText(
            read.text,
            { domain: live.domain, database: liveDatabase },
            { domain: test.domain, database: testDatabase },
        )
        const written = await writeEnvFile(test, file.path, rewritten, envFs)
        if (written.ok) deps.log(`provision ${projectId}: copied ${file.path} into the test environment`)
        else failures.push(file.path)
    }
    return failures
}

type ProvisionAttempt = {
    id: string
    dir: string
    repo: string
    branch: string
    // Only ever set by addEnvironment, to the project's own id: the live environment's expected compose
    // name, which is what a test environment's compose file must never be pinned to (see
    // composeNameProblem in compose.ts). Absent for createProject, since live has no other environment to
    // collide with yet.
    collidesWith?: string
    // The existing directory whose ownership and mode the freshly cloned tree should take. Read, never
    // assumed, the same rule deploy.ts follows for a checkout and a repository directory. createProject
    // names the parent, /var/www, because a brand new project has no directory of its own anywhere yet;
    // addEnvironment names the project's live folder, which is the sibling the test tree is a copy of.
    likeDir: string
    // Runs after a successful clone, before resolve. A no-op for create; addEnvironment copies and
    // rewrites env files here, using the composePath's directory as the freshly cloned test folder.
    afterClone: (composePath: string) => Promise<{ ok: true } | { ok: false, problem: string }>
    // Given the services resolve found (each guessed site or database), attempts the registry write. Only
    // createProject's services are ever non-empty going in; addEnvironment's write ignores the argument.
    // `conflict: true` on a failure (set by registry-write.ts's own edit(), not guessed from the message
    // text) means someone else's entry already claims this id or environment: the folder this call made
    // is then not this call's to remove, because it may not even be this call's folder any more. The
    // single global provisioning lock in agent.ts is the primary defense against that race; this is the
    // fallback for whatever reaches the write despite it.
    write: (services: Record<string, GuessedService>) => Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
}

// The mkdir/clone/resolve/write sequence shared by createProject and addEnvironment: the exact ordering
// that makes each step undoable only while the later ones have not happened. A throw from any dependency
// (the fetcher on a timeout or a dropped connection, a filesystem call, resolve) is rolled back exactly
// like a returned failure would be: nothing here assumes a dependency can only fail by returning `ok:
// false`.
async function provisionOnDisk(attempt: ProvisionAttempt, deps: ProvisionDeps): Promise<Refusal | { ok: true, composePath: string }> {
    const { id, dir } = attempt

    const rollback = async (reason: string): Promise<void> => {
        deps.log(`provision ${id}: ${reason}, removing ${dir}`)
        try {
            await deps.rmdir(dir)
        } catch (error) {
            deps.log(`provision ${id}: could not remove ${dir}: ${describeError(error)}`)
        }
    }

    deps.log(`provision ${id}: creating ${dir}`)
    try {
        await deps.mkdir(dir)
    } catch (error) {
        // Nothing of this call's is on disk yet: mkdir itself is what failed, not a step after it. In
        // particular a failure of EEXIST means the folder is already someone or something else's, and
        // removing it would delete contents this call never created.
        deps.log(`provision ${id}: could not create ${dir}: ${describeError(error)}`)
        return refuse('failed', describeError(error))
    }

    try {
        const cloned = await deps.fetcher.call({ verb: 'clone', repo: attempt.repo, dir, branch: attempt.branch })
        if (!cloned.ok) {
            await rollback('clone failed')
            return refuse('failed', cloned.message)
        }

        const composePath = posix.join(dir, COMPOSE_FILE)

        const after = await attempt.afterClone(composePath)
        if (!after.ok) {
            await rollback('setup failed')
            return refuse('failed', after.problem)
        }

        // Everything under `dir` is root's until here: the clone ran as root in the fetcher, and the env
        // files afterClone just created or copied were written as root by this process, into a directory
        // this process made under its own restrictive umask (see index.ts). Left like that, a site is
        // created that the operator cannot read, edit or start by hand, unlike every hand-enrolled site
        // beside it, and unlike what the first deploy would leave behind once deploy.ts does this same
        // step. Owned after afterClone rather than straight after the clone, so the env files are covered
        // too, and before resolve and the registry write, so nothing unusable is ever registered. A
        // failure here throws into the catch below, which rolls the folder back, on the same reasoning as
        // every other step: half-owned is not a state worth registering.
        const like = await deps.owner(attempt.likeDir)
        await deps.own(dir, like)

        // The expected compose project name is this environment's own folder basename, what an unpinned
        // compose file resolves to by default, not the registry id: those coincide for live
        // (/var/www/<id>) but not for test (/var/www/<id>-test), and comparing test's resolved name
        // against the bare id would refuse the ordinary, unpinned case for every repo.
        const resolved = await deps.resolve(posix.basename(dir), dir, composePath, attempt.collidesWith)
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

        const written = await attempt.write(resolved.services)
        if (!written.ok) {
            if (written.conflict) {
                deps.log(`provision ${id}: registry write failed, leaving ${dir} in place (already claimed)`)
                return refuse('failed', written.problem)
            }
            await rollback('registry write failed')
            return refuse('failed', written.problem)
        }

        deps.log(`provision ${id}: created`)
        return { ok: true, composePath }
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
    const dir = `/var/www/${args.id}`
    if (await deps.exists(dir)) return refuse('bad-request', `${dir} already exists`)
    if (args.domain && domainTaken(registry, args.domain)) return refuse('bad-request', `${args.domain} is already used by another project`)

    const port = await deps.choosePort()
    if (!port.ok) return refuse('unavailable', port.problem)

    const attempt = await provisionOnDisk({
        id: args.id,
        dir,
        repo: args.repo,
        branch: args.branch,
        // /var/www itself, the folder this project is being created inside: the only thing on disk that
        // says who the operator is when the project has nothing of its own to read it from yet. If that
        // directory belongs to root, so does the new site, which is no worse than today and stays
        // consistent with its neighbours either way.
        likeDir: posix.dirname(dir),
        // A repo usually commits an example beside a gitignored real file, and its compose file usually
        // declares env_file against the real one; resolve (just below, in provisionOnDisk) would
        // otherwise fail on a repo that has done nothing wrong, before the operator ever gets to fill
        // the real file in.
        afterClone: async () => {
            const created = await createMissingEnvFiles(dir, envFs)
            for (const path of created) deps.log(`provision ${args.id}: created an empty ${path} for its .example`)
            return { ok: true }
        },
        write: services => deps.writer.write({
            kind: 'add-project',
            id: args.id,
            project: {
                client: args.client,
                name: args.name,
                repo: args.repo,
                services,
                environment: { name: 'live', dir, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate },
            },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const live: EnvironmentEntry = {
        name: 'live', dir, composePaths: [attempt.composePath], branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null,
    }
    const envFiles = await listEnvFiles(live, envFs)
    return { ok: true, project: { id: args.id, state: 'needs-setup' }, envFiles }
}

export async function addEnvironment(project: ProjectEntry, args: ProvisionAddEnvironmentArgs, deps: ProvisionDeps, envFs?: EnvFs): Promise<AgentReply> {
    if (!GIT_REF.test(args.branch)) return refuse('bad-request', 'branch must be a plain branch name')
    if (args.domain !== null && !HOSTNAME.test(args.domain)) return refuse('bad-request', 'domain must be a lowercase hostname')
    if (!project.repo) return refuse('invalid-project', `${project.id} has no repo to clone from`)
    if (project.environments.has('test')) return refuse('bad-request', `${project.id} already has a test environment`)

    const dir = `${project.dir}-test`
    if (await deps.exists(dir)) return refuse('bad-request', `${dir} already exists`)

    // Same reasoning as createProject: refresh before the domain and port checks, not just inside
    // choosePort, so both see the same snapshot.
    await deps.refreshRegistry()
    const registry = deps.registry()
    const invalidProblem = invalidRegistryProblem(registry)
    if (invalidProblem) return refuse('unavailable', invalidProblem)
    if (args.domain && domainTaken(registry, args.domain, project.id)) return refuse('bad-request', `${args.domain} is already used by another project`)

    const port = await deps.choosePort()
    if (!port.ok) return refuse('unavailable', port.problem)

    const attempt = await provisionOnDisk({
        id: project.id,
        dir,
        repo: project.repo,
        branch: args.branch,
        // The live environment's own expected compose name: a test environment pinning it would share
        // one compose project with live, and starting test would take over live's running containers.
        collidesWith: project.id,
        // The project's own folder, not /var/www: the test tree sits beside it and is a copy of it, so
        // whatever the operator chose for live is what test should match, the same way deploy.ts patterns
        // a checkout on <dir> rather than on anything further out.
        likeDir: project.dir,
        afterClone: async composePath => {
            const live = project.environments.get('live')
            if (!live) return { ok: true }
            const test: EnvironmentEntry = {
                name: 'test', dir, composePaths: [composePath], branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null,
            }
            const failures = await copyEnvFiles(project.id, live, test, envFs, deps)
            if (failures.length > 0) return { ok: false, problem: `could not copy ${failures.join(', ')} from the live environment` }
            // Fills any gap the copy above left: an env file live never had at all (so there was nothing
            // to copy) but the repo still commits an example for, on the same reasoning as createProject.
            const created = await createMissingEnvFiles(dir, envFs)
            for (const path of created) deps.log(`provision ${project.id}: created an empty ${path} for its .example`)
            return { ok: true }
        },
        write: () => deps.writer.write({
            kind: 'add-environment',
            id: project.id,
            environment: { name: 'test', dir, branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const test: EnvironmentEntry = {
        name: 'test', dir, composePaths: [attempt.composePath], branch: args.branch, domain: args.domain, aliases: [], port: port.port, certificate: args.certificate, deployed: null,
    }
    const envFiles = await listEnvFiles(test, envFs)
    return { ok: true, project: { id: project.id, state: 'needs-setup' }, envFiles }
}

export async function removeProject(project: ProjectEntry, environment: EnvironmentName | null, deps: ProvisionDeps): Promise<AgentReply> {
    // Removing the whole project must stop it first: otherwise the site keeps serving with nothing left
    // in the registry able to stop it, since every lifecycle verb answers unknown-project the instant it
    // is unregistered. runLifecycle only ever reaches the live environment's own compose file (there is
    // no per-environment lifecycle yet, see RUNBOOK.md), which is exactly what removing a whole project,
    // as opposed to only its test environment, needs stopped. A failed stop refuses rather than
    // unregistering anyway: an operator can retry, or stop it by hand, but a project must never go
    // unregistered while still running.
    if (!environment) {
        const stopped = await runLifecycle(project, 'stop', deps.runner)
        if (!stopped.ok) return refuse('failed', `could not stop ${project.id} before removing it: ${stopped.message}`, stopped.output)
    }

    const change: Change = environment ? { kind: 'remove-environment', id: project.id, environment } : { kind: 'remove-project', id: project.id }
    const written = await deps.writer.write(change)
    if (!written.ok) return refuse('failed', written.problem)

    const dir = (environment ? project.environments.get(environment)?.dir : undefined) ?? project.dir
    const stoppedNote = environment ? '' : ', its containers stopped first'
    deps.log(`provision ${project.id}: unregistered${environment ? ` (${environment})` : ''}${stoppedNote}, left ${dir} in place`)
    return {
        ok: true,
        output: environment
            ? `${dir} was left in place, along with its volumes and databases`
            : `${project.id} was stopped and unregistered; ${dir} was left in place, along with its volumes and databases`,
    }
}
