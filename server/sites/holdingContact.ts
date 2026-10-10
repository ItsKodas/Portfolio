// Keeps each site's holding page contact in step with the client accounts that may be listed on it. The
// portal holds the details (a client edits them, the operator lists them); hostd holds what each site
// actually shows, in its registry. So whenever either side of that changes, every site it touches is sent
// its contact again, worked out from scratch rather than patched, and a site nobody is listed on is sent
// none at all.

import 'server-only'

import { getDb } from '../db'
import type { Caller } from '../hostd/actor'
import { readHostd } from '../hostd/config'
import { forAdmin } from '../hostd/errors'
import { writeSettings } from '../hostd/settings'

export type HoldingContact = { name: string | null, email: string | null, phone: string | null }

type Candidate = {
    publicName: string | null
    publicEmail: string | null
    publicPhone: string | null
    publicContactListed: boolean
}

// The first listed client, in the order they were given the site, with some way to be reached. Several
// clients can share a site, and the one given it first is the closest thing a site has to an owner.
export function holdingContactOf(clients: Candidate[]): HoldingContact | null {
    for (const client of clients) {
        if (!client.publicContactListed || (!client.publicEmail && !client.publicPhone)) continue
        return { name: client.publicName, email: client.publicEmail, phone: client.publicPhone }
    }
    return null
}

// Answers what could not be sent, one sentence per site, rather than throwing: the portal's own change has
// already been saved, and the caller decides how much of hostd's answer its reader should see.
export async function syncHoldingContacts(projectIds: string[], caller: Caller): Promise<string[]> {
    const unique = [...new Set(projectIds)]
    if (unique.length === 0) return []

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length > 0) return [`hostd is not configured: ${problems.join('; ')}`]

    for (const projectId of unique) {
        const rows = await getDb().siteAccess.findMany({
            where: { site: { projectId } },
            orderBy: { createdAt: 'asc' },
            select: { client: { select: { publicName: true, publicEmail: true, publicPhone: true, publicContactListed: true } } },
        })
        const result = await writeSettings(config, caller, projectId, { contact: holdingContactOf(rows.map(row => row.client)) })
        if (!result.ok) problems.push(`${projectId}: ${forAdmin(result.code, result.message)}`)
    }
    return problems
}
