// The portal's record of which clients may reach which sites, read for one signed-in client. The operator is
// never looked up here: they reach every site, and the callers check for them first.

import 'server-only'

import { getDb } from '../db'
import type { Permission } from './permissions'

// What this client may do on this site, or null when they have no access to it at all
export async function accessOf(clientId: string, projectId: string): Promise<Permission[] | null> {
    const row = await getDb().siteAccess.findFirst({
        where: { clientId, site: { projectId } },
        select: { permissions: true },
    })
    return row ? row.permissions : null
}

// Every project this client has access to, which is what hostd is told so it can hold the same line
export async function sitesOf(clientId: string): Promise<string[]> {
    const rows = await getDb().siteAccess.findMany({
        where: { clientId },
        select: { site: { select: { projectId: true } } },
        orderBy: { site: { projectId: 'asc' } },
    })
    return rows.map(row => row.site.projectId)
}
