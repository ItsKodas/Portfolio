// What a client may be given on a site, beyond its Overview, which any access to the site shows. Each one is
// a tab or a control the site page offers a client; everything else on a site (Settings, env files,
// deploying, changing domains, environments themselves) is the operator's alone and cannot be granted.
// Deliberately no 'server-only' import: the admin forms draw the same list the server checks.

// prisma/schema.prisma's SitePermission enum, in its order. A test keeps the two in step.
export const PERMISSIONS = ['LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS'] as const
export type Permission = typeof PERMISSIONS[number]

export const PERMISSION_LABELS: Record<Permission, { label: string, note: string }> = {
    LOGS: { label: 'Logs', note: 'Read the site\'s logs as they happen.' },
    LIFECYCLE: { label: 'Start and stop', note: 'Start, stop and restart the site.' },
    ENVIRONMENTS: { label: 'Environments', note: 'See each environment and its domains, without changing them.' },
    DEPLOYS: { label: 'Deploys', note: 'See what was deployed and watch a deploy run, without starting one.' },
}

// What a new grant starts with, and what every link from before site access was carried across with: the
// whole of what a client could do then.
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS

export function isPermission(value: unknown): value is Permission {
    return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

// A list that arrived from a browser, read strictly: anything that is not a list of known permissions is
// refused whole rather than filtered, and the answer is in PERMISSIONS order with no repeats.
export function parsePermissions(input: unknown): Permission[] | null {
    if (!Array.isArray(input) || !input.every(isPermission)) return null
    return PERMISSIONS.filter(permission => input.includes(permission))
}
