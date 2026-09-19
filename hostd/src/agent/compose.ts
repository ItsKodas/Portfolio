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
    return ['compose', '--project-directory', project.dir, '-f', project.composePath]
}

export function lifecycleArgv(project: ProjectEntry, action: LifecycleAction): string[] {
    return [...composeBase(project), ...LIFECYCLE_ARGS[action]]
}

export function configArgv(project: ProjectEntry): string[] {
    return [...composeBase(project), 'config', '--format', 'json']
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

export function createSpawnRunner(spawn: typeof nodeSpawn = nodeSpawn): Runner {
    return (command, args, timeoutMs) => new Promise(resolve => {
        const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
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
