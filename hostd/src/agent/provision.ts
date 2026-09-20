// Creates and removes projects and environments end to end. Every step here is undoable only while the
// steps after it have not happened yet, so the order below is load-bearing: nothing is registered before
// it exists on disk, and a failure partway through removes whatever this put on disk and writes nothing
// to the registry. `log` never receives a repo URL, a git message or an env value; only ids, paths and
// fixed words, so a compromised or merely careless log sink can never leak a secret.

import { posix } from 'node:path'
import { randomBytes } from 'node:crypto'

import { PROJECT_ID, CLIENT_ID, HOSTNAME, RESERVED_PROJECT_IDS } from '../shared/formats.ts'
import {
    GIT_REF, GIT_REPO,
    type CertificateMode, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry,
} from '../shared/registry.ts'
import { RegistryWriter, type Change } from '../shared/registry-write.ts'
import type { FetchClient } from './fetch-client.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import {
    refuse,
    type AgentReply, type ProvisionAddEnvironmentArgs, type ProvisionCreateArgs,
} from '../shared/protocol.ts'

const COMPOSE_FILE = 'docker-compose.yml'
// The keys a value's domain gets rewritten under, and nothing else: a database password or an API key
// that happens to end in one of these letters is never touched, because those never end with them.
const DOMAIN_KEY_SUFFIXES = ['_URL', '_HOST', '_DOMAIN', '_ORIGIN']
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
    if (!PROJECT_ID.test(args.id)) return `id must match ${PROJECT_ID}`
    if (!CLIENT_ID.test(args.client)) return `client must match ${CLIENT_ID}`
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

// A best-effort text rewrite, not an env-file parser: a line that is not KEY=VALUE (a comment, a blank
// line, something malformed) is carried through untouched rather than guessed at.
//
// The domain substitution runs behind a one-off placeholder, generated fresh per call, rather than
// straight into the value: the test domain conventionally embeds the project id itself (test.acme.com,
// for project acme), so substituting the domain first and then blindly replacing every occurrence of the
// database name would re-match "acme" inside the domain this just wrote, corrupting it. Parking the
// substituted domain behind a placeholder the database rule cannot match, then restoring it last, avoids
// that regardless of how the two happen to overlap.
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
        if (rewriteDomain) value = value.split(live.domain!).join(placeholder)
        if (value.includes(live.database)) value = value.split(live.database).join(test.database)
        if (rewriteDomain) value = value.split(placeholder).join(test.domain!)
        return `${key}=${value}`
    }).join('\n')
}

// Copies every env file the live environment has into the freshly cloned test folder, pointing anything
// that looks like the site's own URL or database at the test side instead. Best-effort per file: a file
// that vanishes between the listing and the read is skipped, not fatal to the whole environment.
async function copyEnvFiles(
    projectId: string, live: EnvironmentEntry, test: EnvironmentEntry, envFs: EnvFs | undefined, deps: ProvisionDeps,
): Promise<void> {
    const files = await listEnvFiles(live, envFs)
    const liveDatabase = projectId
    const testDatabase = `${projectId}-test`
    for (const file of files) {
        const read = await readEnvFile(live, file.path, envFs)
        if (!read.ok) continue
        const rewritten = rewriteEnvText(
            read.text,
            { domain: live.domain, database: liveDatabase },
            { domain: test.domain, database: testDatabase },
        )
        const written = await writeEnvFile(test, file.path, rewritten, envFs)
        if (written.ok) deps.log(`provision ${projectId}: copied ${file.path} into the test environment`)
    }
}

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

    deps.log(`provision ${args.id}: creating ${dir}`)
    await deps.mkdir(dir)

    const cloned = await deps.fetcher.call({ verb: 'clone', repo: args.repo, dir, branch: args.branch })
    if (!cloned.ok) {
        deps.log(`provision ${args.id}: clone failed, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('failed', cloned.message)
    }

    const composePath = posix.join(dir, COMPOSE_FILE)
    const resolved = await deps.resolve(dir, composePath)
    if (!resolved.ok || Object.keys(resolved.services).length === 0) {
        deps.log(`provision ${args.id}: compose has no site service, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('invalid-project', resolved.ok ? 'the compose file has no service with role site' : resolved.problem)
    }

    const written = await deps.writer.write({
        kind: 'add-project',
        id: args.id,
        project: {
            client: args.client,
            name: args.name,
            repo: args.repo,
            services: resolved.services,
            environment: { name: 'live', dir, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate },
        },
    })
    if (!written.ok) {
        deps.log(`provision ${args.id}: registry write failed, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('failed', written.problem)
    }

    deps.log(`provision ${args.id}: created`)
    const live: EnvironmentEntry = {
        name: 'live', dir, composePath, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate, deployed: null,
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

    deps.log(`provision ${project.id}: creating ${dir}`)
    await deps.mkdir(dir)

    const cloned = await deps.fetcher.call({ verb: 'clone', repo: project.repo, dir, branch: args.branch })
    if (!cloned.ok) {
        deps.log(`provision ${project.id}: clone failed, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('failed', cloned.message)
    }

    const composePath = posix.join(dir, COMPOSE_FILE)
    const test: EnvironmentEntry = {
        name: 'test', dir, composePath, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate, deployed: null,
    }
    const live = project.environments.get('live')
    if (live) await copyEnvFiles(project.id, live, test, envFs, deps)

    const resolved = await deps.resolve(dir, composePath)
    if (!resolved.ok || Object.keys(resolved.services).length === 0) {
        deps.log(`provision ${project.id}: compose has no site service, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('invalid-project', resolved.ok ? 'the compose file has no service with role site' : resolved.problem)
    }

    const written = await deps.writer.write({
        kind: 'add-environment',
        id: project.id,
        environment: { name: 'test', dir, branch: args.branch, domain: args.domain, port: port.port, certificate: args.certificate },
    })
    if (!written.ok) {
        deps.log(`provision ${project.id}: registry write failed, removing ${dir}`)
        await deps.rmdir(dir)
        return refuse('failed', written.problem)
    }

    deps.log(`provision ${project.id}: test environment created`)
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
