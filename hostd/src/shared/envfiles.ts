// Which files the portal may edit. Deliberately narrow: an env file, inside one environment's folder,
// nothing else. This is the whole reason the env capability cannot be used to change code.

export const MAX_ENV_BYTES = 64 * 1024
export const MAX_ENV_DEPTH = 4
export const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', '.next'])

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
