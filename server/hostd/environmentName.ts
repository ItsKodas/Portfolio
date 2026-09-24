// The environment name rule, once. A copy of hostd's own (ENV_NAME and the reserved list in
// hostd/src/shared/formats.ts): the portal never imports hostd code, so this is the one place the rule is
// written down on this side. env.ts hands it on to the server code; this file is its own module, with no
// server-only import, because the Settings form checks a new name in the browser before it is sent.

// An environment's name. Any string that passes isEnvironmentName, since a site can have any number of
// environments beside live; the type says what a value is for, and the check says it is well formed.
export type EnvironmentName = string

// Lowercase letters and digits, starting with a letter, sixteen at most. No hyphen on purpose: hostd joins
// `<id>-<env>` into compose project and vhost file names, and a hyphen would let two pairs collide.
export const ENV_NAME = /^[a-z][a-z0-9]{0,15}$/

// Folders of a site's nested layout (git, next, prev) and route segments hostd matches before an
// environment (environments, backups). Never a name, whatever the pattern says.
export const RESERVED_ENVIRONMENT_NAMES: readonly string[] = ['git', 'next', 'prev', 'environments', 'backups']

// The one environment every site has. Valid as a name, but never added, deleted or restored.
export const LIVE = 'live'

// Checked rather than cast wherever a name arrives from a browser or a URL
export function isEnvironmentName(value: unknown): value is EnvironmentName {
    return typeof value === 'string' && ENV_NAME.test(value) && !RESERVED_ENVIRONMENT_NAMES.includes(value)
}

// Why a name cannot be given to a new environment, in a sentence for the form, or null when it can.
// hostd has the final word, since only it knows which names the site already has or has deleted.
export function newEnvironmentProblem(name: string): string | null {
    if (name === LIVE) return 'Every site has live already.'
    if (RESERVED_ENVIRONMENT_NAMES.includes(name)) return `${name} is reserved. Choose another name.`
    if (!isEnvironmentName(name)) {
        return 'Use lowercase letters and digits, starting with a letter, up to 16 characters.'
    }
    return null
}
