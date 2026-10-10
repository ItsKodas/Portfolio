// What a client may be given on a site, beyond its Overview, which any access to the site shows. Each one is
// a tab or a control the site page offers a client; everything else on a site (Settings, deploying, changing
// domains, environments themselves) is the operator's alone and cannot be granted.
// Deliberately no 'server-only' import: the admin forms draw the same list the server checks.

// prisma/schema.prisma's SitePermission enum, in its order. A test keeps the two in step.
export const PERMISSIONS = ['LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS', 'BACKUPS', 'ENV_FILES', 'RESTORE_BACKUPS'] as const
export type Permission = typeof PERMISSIONS[number]

export const PERMISSION_LABELS: Record<Permission, { label: string, note: string }> = {
    LOGS: { label: 'Logs', note: 'Read the site\'s logs as they happen.' },
    LIFECYCLE: { label: 'Start and stop', note: 'Start, stop and restart the site.' },
    ENVIRONMENTS: { label: 'Environments', note: 'See each environment and its domains, without changing them.' },
    DEPLOYS: { label: 'Deploys', note: 'See what was deployed and watch a deploy run, without starting one.' },
    BACKUPS: { label: 'Backups', note: 'Make, download, delete and schedule copies of the site\'s data.' },
    ENV_FILES: { label: 'Edit env files', note: 'Read and edit each environment\'s env files, which restarts it. Needs Environments.' },
    RESTORE_BACKUPS: { label: 'Restore backups', note: 'Put a copy back over the live site, after a fresh copy is made. Needs Backups.' },
}

// Everything, which is what the operator holds on every site.
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS

// What a new grant starts with: everything but the env files, which hold the site's secrets, and restoring,
// which replaces the live site's data; both are only ever given on purpose. Links from before site access were
// carried across with the four that existed then; BACKUPS, ENV_FILES and RESTORE_BACKUPS came after, and a
// grant made before any of them does not gain it by itself (see their migrations).
const ON_PURPOSE: readonly Permission[] = ['ENV_FILES', 'RESTORE_BACKUPS']
export const DEFAULT_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(permission => !ON_PURPOSE.includes(permission))

// Editing env files is done from the Environments tab, so it means nothing without that tab, and restoring is
// done from the Backups tab. Each is the level above, rather than a permission of its own.
export const NEEDS: Partial<Record<Permission, Permission>> = { ENV_FILES: 'ENVIRONMENTS', RESTORE_BACKUPS: 'BACKUPS' }

export function isPermission(value: unknown): value is Permission {
    return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

// A list that arrived from a browser, read strictly: anything that is not a list of known permissions is
// refused whole rather than filtered, and so is one holding a permission without the one it needs. The
// answer is in PERMISSIONS order with no repeats.
export function parsePermissions(input: unknown): Permission[] | null {
    if (!Array.isArray(input) || !input.every(isPermission)) return null
    if (input.some(permission => NEEDS[permission] && !input.includes(NEEDS[permission]))) return null
    return PERMISSIONS.filter(permission => input.includes(permission))
}
