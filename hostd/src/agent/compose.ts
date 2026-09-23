// Everything the agent runs through the docker CLI. Every argv is built here from registry values only,
// and every spawn is shell-free, so no value from a request can ever reach a command line.

import { spawn as nodeSpawn } from 'node:child_process'
import { isRecord } from '../shared/formats.ts'
import type { Engine, ProjectEntry } from '../shared/registry.ts'
import type { LifecycleAction } from '../shared/protocol.ts'

export const LIFECYCLE_TIMEOUT_MS = 120_000
export const CONFIG_TIMEOUT_MS = 30_000
export const OUTPUT_TAIL_BYTES = 4096
// A resolved compose file is tens of kilobytes. Anything near this is not one, and must not grow unbounded.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

const LIFECYCLE_ARGS: Record<LifecycleAction, string[]> = {
    start: ['up', '-d', '--no-build', '--pull', 'never'],
    stop: ['stop'],
    restart: ['restart'],
}

// What compose needs to resolve or run a project: every ProjectEntry has these, but so does a folder
// that provisioning has just cloned and not registered yet, which is the whole reason this is its own
// type rather than ProjectEntry itself.
export type ComposeLocation = { dir: string, composePaths: string[] }

export function composeBase(project: ComposeLocation): string[] {
    // One -f per registered file, in the registry's order, because compose merges them left to right.
    // An explicit -f also stops compose loading docker-compose.override.yml on its own, so a site with
    // an override is only described correctly when the registry names it too.
    return ['compose', '--project-directory', project.dir, ...project.composePaths.flatMap(path => ['-f', path])]
}

export function lifecycleArgv(project: ProjectEntry, action: LifecycleAction): string[] {
    return [...composeBase(project), ...LIFECYCLE_ARGS[action]]
}

export function configArgv(project: ComposeLocation): string[] {
    // --no-env-resolution keeps env_file as the path list the guard reads, instead of compose inlining
    // every project's env values (database passwords among them) into this captured stdout. On a compose
    // too old to know the flag, the command exits non-zero and resolveCompose fails closed.
    return [...composeBase(project), 'config', '--no-env-resolution', '--format', 'json']
}

export type RunResult = { exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }
export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>

// Keeps the most recent bytes only, so a chatty command cannot exhaust memory.
class Capture {
    private chunks: Buffer[] = []
    private size = 0

    add(chunk: Buffer): void {
        this.chunks.push(chunk)
        this.size += chunk.length
        if (this.size > 2 * MAX_CAPTURE_BYTES) {
            const joined = Buffer.concat(this.chunks)
            const kept = joined.subarray(joined.length - MAX_CAPTURE_BYTES)
            this.chunks = [kept]
            this.size = kept.length
        }
    }

    text(): string {
        const joined = Buffer.concat(this.chunks)
        return joined.subarray(Math.max(0, joined.length - MAX_CAPTURE_BYTES)).toString('utf8')
    }
}

// Only what the child needs, taken from process.env when set. Phase 2 puts secrets (RESTIC_PASSWORD, the
// R2 credentials) in this process's environment specifically to keep them out of reach of a compromised
// api, so nothing else from process.env may reach the child: compose interpolates ${VAR} from the child's
// environment into a project's own compose file. This allowlist is shared by the fetcher's git runs too,
// since createSpawnRunner is the only spawn path either process has: GIT_TERMINAL_PROMPT (see
// ../fetcher/git.ts) is here for that reason, and is simply never set in the agent's own environment.
// restic gets its own allowlist in restic.ts that includes RESTIC_PASSWORD, safe because restic never
// runs compose and has no interpolation risk.
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'TZ', 'GIT_TERMINAL_PROMPT'] as const

export function childEnv(keys: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of keys) {
        const value = process.env[key]
        if (value !== undefined) env[key] = value
    }
    return env
}

export function createSpawnRunner(spawn: typeof nodeSpawn = nodeSpawn, envKeys: readonly string[] = DOCKER_ENV_KEYS): Runner {
    return (command, args, timeoutMs) => new Promise(resolve => {
        const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(envKeys) })
        const stdout = new Capture()
        const stderr = new Capture()
        child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
        child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))

        let timedOut = false
        let settled = false
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, timeoutMs)

        const finish = (exitCode: number | null, error?: string) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            const errorText = stderr.text()
            resolve({ exitCode, stdout: stdout.text(), stderr: error ? (errorText ? `${errorText}\n${error}` : error) : errorText, timedOut })
        }
        child.on('error', error => finish(null, error.message))
        child.on('close', code => finish(code))
    })
}

export function tail(text: string, bytes = OUTPUT_TAIL_BYTES): string {
    const buffer = Buffer.from(text)
    return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString('utf8')
}

export type LifecycleResult = { ok: true, output: string } | { ok: false, message: string, output: string }

export async function runLifecycle(project: ProjectEntry, action: LifecycleAction, run: Runner): Promise<LifecycleResult> {
    const result = await run('docker', lifecycleArgv(project, action), LIFECYCLE_TIMEOUT_MS)
    // Compose writes its progress to stderr, so both streams are the output.
    const output = tail([result.stdout, result.stderr].filter(text => text !== '').join('\n'))
    if (result.timedOut) return { ok: false, message: `${action} timed out after ${LIFECYCLE_TIMEOUT_MS / 1000} seconds`, output }
    if (result.exitCode === null) return { ok: false, message: `${action} could not run`, output }
    if (result.exitCode !== 0) return { ok: false, message: `${action} exited with code ${result.exitCode}`, output }
    return { ok: true, output }
}

export type ResolvedService = {
    volumes?: Array<{ type?: string, source?: string }>
    // This shape ({ path: string }, not a bare string) only holds because configArgv passes
    // --no-env-resolution; without it compose resolves env files away and this key is absent. Do not
    // remove that flag.
    env_file?: Array<string | { path?: string }>
    build?: string | { context?: string, dockerfile?: string }
    image?: string
    // As `docker compose config --format json` writes them: published is a string ("5012", or a range
    // like "6000-6002") or, from some compose versions, a number. Absent when the port is not published.
    ports?: Array<{ target?: number, published?: string | number, host_ip?: string, protocol?: string }>
}
export type ResolvedCompose = { name: string, services: Record<string, ResolvedService> }

export async function resolveCompose(
    project: ComposeLocation,
    run: Runner,
): Promise<{ ok: true, resolved: ResolvedCompose } | { ok: false, problem: string }> {
    const result = await run('docker', configArgv(project), CONFIG_TIMEOUT_MS)
    if (result.timedOut) return { ok: false, problem: 'docker compose config timed out' }
    if (result.exitCode !== 0) return { ok: false, problem: `docker compose config failed: ${tail(result.stderr.trim(), 500)}` }
    try {
        const parsed: unknown = JSON.parse(result.stdout)
        if (!isRecord(parsed) || typeof parsed.name !== 'string' || !isRecord(parsed.services)) throw new Error('shape')
        return { ok: true, resolved: parsed as ResolvedCompose }
    } catch {
        return { ok: false, problem: 'docker compose config returned unreadable output' }
    }
}

// Every single host port some service publishes. A range is skipped: hostd hands out one port per
// environment, and a range cannot be the one the portal chose.
export function publishedPortsOf(resolved: ResolvedCompose): number[] {
    const ports: number[] = []
    for (const service of Object.values(resolved.services)) {
        for (const port of service.ports ?? []) {
            const published = typeof port.published === 'number' ? String(port.published) : port.published
            if (published !== undefined && /^\d{1,5}$/.test(published)) ports.push(Number(published))
        }
    }
    return ports
}

// What an environment already on disk publishes, for a port change: the same config call create makes.
export async function resolvePublished(
    location: ComposeLocation, run: Runner,
): Promise<{ ok: true, ports: number[] } | { ok: false, problem: string }> {
    const result = await resolveCompose(location, run)
    return result.ok ? { ok: true, ports: publishedPortsOf(result.resolved) } : result
}

// Shared by guard.ts (the ongoing sweep, over an already-registered project) and resolveNewProject below
// (at create time, before anything is registered), so the two can never drift into naming this two
// different ways. A start under the wrong compose project name would create a second copy of the site
// beside whatever is already running under the real one.
//
// collidesWith is only ever the live environment's own expected name, passed by resolveNewProject while
// creating a test environment: an unpinned compose file resolving to test's own folder is the ordinary
// case and passes; one pinning live's name instead is not just "wrong", it is the specific danger the
// runbook warns about, since starting test would then take over live's already-running containers, so it
// gets a message that says that instead of only "not what was expected".
export function composeNameProblem(resolvedName: string, expectedName: string, collidesWith?: string): string | null {
    if (resolvedName === expectedName) return null
    if (collidesWith !== undefined && resolvedName === collidesWith) {
        return `compose resolves the project name ${resolvedName}, the same as the live environment; a test environment cannot share live's compose project name, since starting it would take over live's already-running containers instead of starting a separate stack. Set name: ${expectedName} in the compose file, or rename the registry entry.`
    }
    return `compose resolves the project name ${resolvedName}, not ${expectedName}; set name: ${expectedName} in the compose file, or rename the registry entry`
}

export type GuessedService = { role: 'site' } | { role: 'database', engine: Exclude<Engine, 'sqlite'> }

// A starting point for the operator to correct, not a guarantee: matches the image's repository part
// (the part before a tag or digest) against the common database images by name. Anything that does not
// match, including a database run from a custom or renamed image, comes back site. The storage guard
// (guard.ts) also refuses a project with storage but no service marked database, specifically so a
// database this guessed wrong does not silently keep its data directory unprotected.
const DATABASE_IMAGES: Array<{ match: string, engine: Exclude<Engine, 'sqlite'> }> = [
    { match: 'postgres', engine: 'postgres' },
    { match: 'mariadb', engine: 'mariadb' },
    { match: 'mysql', engine: 'mysql' },
    { match: 'mongo', engine: 'mongodb' },
    { match: 'redis', engine: 'redis' },
]

// Everything up to a tag or digest: a registry port (registry.example.com:5000/repo) must not be mistaken
// for a tag separator, so this looks for the last ':' after the last '/', not the first ':' anywhere.
function repositoryOf(image: string): string {
    const withoutDigest = image.split('@')[0] ?? image
    const lastSlash = withoutDigest.lastIndexOf('/')
    const tagColon = withoutDigest.indexOf(':', lastSlash + 1)
    return tagColon === -1 ? withoutDigest : withoutDigest.slice(0, tagColon)
}

function guessRole(service: ResolvedService): GuessedService {
    if (service.image) {
        const repository = repositoryOf(service.image).toLowerCase()
        const database = DATABASE_IMAGES.find(({ match }) => repository.includes(match))
        if (database) return { role: 'database', engine: database.engine }
    }
    return { role: 'site' }
}

// What a freshly cloned, not-yet-registered project resolves to. There is no registry entry yet to say
// which service plays which role, so each one is guessed from its image (see guessRole); the project
// comes back needs-setup, and the operator's own review and edit of the registry, correcting whatever
// this guessed wrong, is what happens next, exactly like enrolling a project by hand today.
//
// expectedName is checked here too, not only later by guard.ts's ongoing sweep: the spec's step 3 says the
// same guards run at creation, and without this a repo whose compose file pins a mismatched name: would
// clone and register cleanly, only to go invalid at the next sweep with the folder already on disk.
//
// expectedName is the environment's own folder basename (what an unpinned compose file resolves to by
// default), not the registry id: those are the same thing for live (/var/www/<id>), but not for test
// (/var/www/<id>-test), and comparing test's resolved name against the bare id would refuse the ordinary,
// unpinned case for every repo, which is most of them. collidesWith is passed only when creating a test
// environment, so a compose file pinning live's own name gets the specific collision message above rather
// than a plain "not what was expected" one.
export async function resolveNewProject(
    location: ComposeLocation,
    expectedName: string,
    run: Runner,
    collidesWith?: string,
): Promise<{ ok: true, services: Record<string, GuessedService>, published: number[] } | { ok: false, problem: string }> {
    const result = await resolveCompose(location, run)
    if (!result.ok) return result
    const nameProblem = composeNameProblem(result.resolved.name, expectedName, collidesWith)
    if (nameProblem) return { ok: false, problem: nameProblem }
    const services: Record<string, GuessedService> = {}
    for (const [name, service] of Object.entries(result.resolved.services)) services[name] = guessRole(service)
    return { ok: true, services, published: publishedPortsOf(result.resolved) }
}
