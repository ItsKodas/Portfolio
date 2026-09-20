// Everything the agent runs through the docker CLI. Every argv is built here from registry values only,
// and every spawn is shell-free, so no value from a request can ever reach a command line.

import { spawn as nodeSpawn } from 'node:child_process'
import { isRecord } from '../shared/formats.ts'
import type { ProjectEntry } from '../shared/registry.ts'
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

export function composeBase(project: ProjectEntry): string[] {
    // One -f per registered file, in the registry's order, because compose merges them left to right.
    // An explicit -f also stops compose loading docker-compose.override.yml on its own, so a site with
    // an override is only described correctly when the registry names it too.
    return ['compose', '--project-directory', project.dir, ...project.composePaths.flatMap(path => ['-f', path])]
}

export function lifecycleArgv(project: ProjectEntry, action: LifecycleAction): string[] {
    return [...composeBase(project), ...LIFECYCLE_ARGS[action]]
}

export function configArgv(project: ProjectEntry): string[] {
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

// Only what docker itself needs, taken from process.env when set. Phase 2 puts secrets (RESTIC_PASSWORD,
// the R2 credentials) in this process's environment specifically to keep them out of reach of a
// compromised api, so nothing else from process.env may reach the child: compose interpolates ${VAR}
// from the child's environment into a project's own compose file.
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'TZ'] as const

function dockerEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of DOCKER_ENV_KEYS) {
        const value = process.env[key]
        if (value !== undefined) env[key] = value
    }
    return env
}

export function createSpawnRunner(spawn: typeof nodeSpawn = nodeSpawn): Runner {
    return (command, args, timeoutMs) => new Promise(resolve => {
        const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: dockerEnv() })
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
}
export type ResolvedCompose = { name: string, services: Record<string, ResolvedService> }

export async function resolveCompose(
    project: ProjectEntry,
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
