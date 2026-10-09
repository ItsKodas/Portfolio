// The site's Access tab: every client who may reach this site, what each may do, and a way to give it to
// another. The operator's alone; the page only draws it for them, and every action behind it checks again.
// Reads the portal's own database rather than hostd, because access is the portal's record and hostd is only
// ever told it.

import { repo } from '@/server/clients/wiring'
import { Callout } from '@/ui/Callout/Callout'
import { AccessRow, GrantClientForm } from '../../access/controls'
import styles from '../../access/access.module.css'

export async function SiteAccessPanel({ projectId, name }: { projectId: string, name: string }) {
    let granted
    let clients
    try {
        [granted, clients] = await Promise.all([repo().accessToSite(projectId), repo().list()])
    } catch (error) {
        console.error(`[portal] reading access to ${projectId} failed: ${String(error)}`)
        return <Callout tone="warn" title="Access could not be read">The database did not answer. Try reloading the page.</Callout>
    }

    const holding = new Set(granted.map(row => row.client.id))
    const label = (client: { name: string, company: string | null }) =>
        (client.company ? `${client.name} (${client.company})` : client.name)

    return (
        <div>
            {granted.length === 0
                ? <p className={styles.empty}>No client has access to this site. Only you can see it.</p>
                : granted.map(row => (
                    <AccessRow
                        key={row.client.id}
                        clientId={row.client.id}
                        siteId={row.siteId}
                        title={label(row.client)}
                        subtitle={row.client.email}
                        href={`/portal/clients/${row.client.id}`}
                        permissions={row.permissions}
                    />
                ))}
            <h2 className={styles.title}>Give a client access</h2>
            <GrantClientForm
                projectId={projectId}
                name={name}
                clients={clients
                    .filter(client => !holding.has(client.id))
                    .map(client => ({ id: client.id, name: label(client) }))
                    .sort((a, b) => a.name.localeCompare(b.name))}
            />
        </div>
    )
}
