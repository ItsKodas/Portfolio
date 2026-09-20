// Which files the portal may edit. Deliberately narrow: an env file, inside one environment's folder,
// nothing else. This is the whole reason the env capability cannot be used to change code.

export const MAX_ENV_BYTES = 64 * 1024
export const MAX_ENV_DEPTH = 4
export const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', '.next'])

// The shape of a directory listing of env files. Lives here, not in agent/env-files.ts (which walks the
// disk to build one), so the wire protocol can name it without importing from the agent.
export type EnvFileList = { path: string, example: string | null, bytes: number }[]

const ENV_FILE = /^(\.env(\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.env)$/

export const isEnvFileName = (name: string) => ENV_FILE.test(name)

export function envPathProblem(relative: string): string | null {
    if (!relative || relative.startsWith('/')) return 'the path must be relative to the environment folder'
    if (relative.includes('\0') || relative.includes('\\')) return 'the path is not valid'
    const parts = relative.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) return 'the path must not point outside the environment folder'
    if (parts.length > MAX_ENV_DEPTH) return `the path is more than ${MAX_ENV_DEPTH} folders deep`
    // Non-null: parts is never empty, since split on a non-empty string always yields at least one part.
    if (!isEnvFileName(parts[parts.length - 1]!)) return 'that is not an env file'
    return null
}

// The write-only half of the boundary. isEnvFileName deliberately still recognises a leading-dot example
// (.env.example) as an env file, so envPathProblem lets it be listed and read like any other, letting the
// portal show it beside the real file for review. A write is where the line has to be drawn instead: a
// repo commits its .example to Git, so writing one here would dirty a file the repo tracks, for a file
// that is never itself what a running site reads.
export function envWriteProblem(relative: string): string | null {
    const problem = envPathProblem(relative)
    if (problem) return problem
    return relative.endsWith('.example') ? 'an .example file is read-only; edit the real env file instead' : null
}
