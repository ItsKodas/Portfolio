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
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
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
    writer: RegistryWriter
    fetcher: FetchClient
    choosePort: () => Promise<{ ok: true, port: number } | { ok: false, problem: string }>
    mkdir(dir: string): Promise<void>
    rmdir(dir: string): Promise<void>
    exists(dir: string): Promise<boolean>
    resolve(dir: string, composePath: string): Promise<{ ok: true, services: Record<string, { role: 'site' }> } | { ok: false, problem: string }>
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
    // Runs after a successful clone, before resolve. A no-op for create; addEnvironment copies and
    // rewrites env files here, using the composePath's directory as the freshly cloned test folder.
    afterClone: (composePath: string) => Promise<{ ok: true } | { ok: false, problem: string }>
    // Given the site services resolve found, attempts the registry write. Only createProject's services
    // are ever non-empty going in; addEnvironment's write ignores the argument. `conflict: true` on a
    // failure (set by registry-write.ts's own edit(), not guessed from the message text) means someone
    // else's entry already claims this id or environment: the folder this call made is then not this
    // call's to remove, because it may not even be this call's folder any more. The single global
    // provisioning lock in agent.ts is the primary defense against that race; this is the fallback for
    // whatever reaches the write despite it.
    write: (services: Record<string, { role: 'site' }>) => Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
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

        const resolved = await deps.resolve(dir, composePath)
        if (!resolved.ok || Object.keys(resolved.services).length === 0) {
            await rollback('compose has no site service')
            return refuse('invalid-project', resolved.ok ? 'the compose file has no service with role site' : resolved.problem)
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

const noSetup = async (): Promise<{ ok: true }> => ({ ok: true })

export async function createProject(args: ProvisionCreateArgs, deps: ProvisionDeps, envFs?: EnvFs): Promise<AgentReply> {
    const problem = fieldProblem(args)
    if (problem) return refuse('bad-request', problem)

    const registry = deps.registry()
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
        afterClone: noSetup,
        write: services => deps.writer.write({
            kind: 'add-project',
            id: args.id,
            project: {
                client: args.client,
                name: args.name,
                repo: args.repo,
                services,
                environment: { name: 'live', dir, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate },
            },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const live: EnvironmentEntry = {
        name: 'live', dir, composePath: attempt.composePath, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate, deployed: null,
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

    const registry = deps.registry()
    if (args.domain && domainTaken(registry, args.domain, project.id)) return refuse('bad-request', `${args.domain} is already used by another project`)

    const port = await deps.choosePort()
    if (!port.ok) return refuse('unavailable', port.problem)

    const attempt = await provisionOnDisk({
        id: project.id,
        dir,
        repo: project.repo,
        branch: args.branch,
        afterClone: async composePath => {
            const live = project.environments.get('live')
            if (!live) return { ok: true }
            const test: EnvironmentEntry = {
                name: 'test', dir, composePath, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate, deployed: null,
            }
            const failures = await copyEnvFiles(project.id, live, test, envFs, deps)
            return failures.length === 0 ? { ok: true } : { ok: false, problem: `could not copy ${failures.join(', ')} from the live environment` }
        },
        write: () => deps.writer.write({
            kind: 'add-environment',
            id: project.id,
            environment: { name: 'test', dir, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate },
        }),
    }, deps)
    if (!attempt.ok) return attempt

    const test: EnvironmentEntry = {
        name: 'test', dir, composePath: attempt.composePath, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate, deployed: null,
    }
    const envFiles = await listEnvFiles(test, envFs)
    return { ok: true, project: { id: project.id, state: 'needs-setup' }, envFiles }
}

export async function removeProject(project: ProjectEntry, environment: EnvironmentName | null, deps: ProvisionDeps): Promise<AgentReply> {
    const change: Change = environment ? { kind: 'remove-environment', id: project.id, environment } : { kind: 'remove-project', id: project.id }
    const written = await deps.writer.write(change)
    if (!written.ok) return refuse('failed', written.problem)

    const dir = (environment ? project.environments.get(environment)?.dir : undefined) ?? project.dir
    deps.log(`provision ${project.id}: unregistered${environment ? ` (${environment})` : ''}, left ${dir} in place`)
    return { ok: true, output: `${dir} was left in place, along with its volumes and databases` }
}
