// The grammar every identifier and path must satisfy before anything else looks at it. Pure, and shared
// by both processes, so api and agent can never disagree about what a valid value is.

// Also the compose project name, so it follows compose's own rules, minus underscores.
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
// A project folder's name under /var/www, chosen at create. Also what an unpinned compose file takes as
// its project name, so it keeps to compose's own rule (lowercase, digits, hyphen, underscore) even though
// the registry's dir grammar alone would accept more.
export const DIR_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Docker Compose's own rule for a project name: lowercase letters, digits, dashes and underscores,
// starting with a letter or digit.
export const COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
export const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
export const STORAGE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
export const USER_ID = /^[A-Za-z0-9_@.:+-]{1,128}$/
// An environment variable's name, as the registry's portEnv and dump keys spell one.
export const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
// A site environment's name: live, test, uat1, staging. No hyphen, on purpose: hostd joins <id>-<env> into
// flag, vhost and compose names, and project ids may carry hyphens, so the last hyphen must always split
// the two. Short and lowercase, since it is also a folder of the nested layout and part of a compose name.
export const ENV_NAME = /^[a-z][a-z0-9]{0,15}$/
export const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

// The operator's own stacks. A registry mistake must never be able to enrol them.
export const RESERVED_PROJECT_IDS = new Set(['hostd', 'mail', 'horizons'])
// The other folders of a nested site (/var/www/<site>/{git, prev/<env>, next/<env>}), which an
// environment of the same name would collide with.
export const RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['git', 'next', 'prev'])

export function isEnvironmentName(name: unknown): name is string {
    return typeof name === 'string' && ENV_NAME.test(name) && !RESERVED_ENVIRONMENT_NAMES.has(name)
}

export const MAX_SEGMENT_BYTES = 255
export const MAX_PATH_BYTES = 4096

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Returns null when the path is acceptable, otherwise the reason it is not. Deliberately stricter than
// POSIX: no '.' or empty segments either, so there is exactly one spelling of every path and nothing
// downstream ever has to normalise.
export function relativePathProblem(path: string): string | null {
    if (path === '') return 'path is empty'
    if (Buffer.byteLength(path) > MAX_PATH_BYTES) return `path is longer than ${MAX_PATH_BYTES} bytes`
    if (path.startsWith('/')) return 'path must be relative'
    if (path.includes('\\')) return 'path contains a backslash'
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) return 'path contains a control character'
    for (const segment of path.split('/')) {
        if (segment === '') return 'path contains an empty segment'
        if (segment === '..') return 'path contains ..'
        if (segment === '.') return 'path contains .'
        if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return `a path segment is longer than ${MAX_SEGMENT_BYTES} bytes`
    }
    return null
}

// POSIX absolute paths that are already normalised: everything the agent compares comes either from
// posix.join over grammar-checked parts or from compose's own resolved output.
export function isWithin(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

export function overlaps(a: string, b: string): boolean {
    return isWithin(a, b) || isWithin(b, a)
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
