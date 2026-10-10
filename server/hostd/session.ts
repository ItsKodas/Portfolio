// Turns the current session into a hostd caller, and nothing else may. The route handlers have no other way
// to say who is asking, so a browser cannot name a client: it only gets the one the cookie it presented
// already belongs to.

import 'server-only'

import { isAdminSession } from '../auth/allow'
import { callerForAdmin, callerForClient, type Caller } from './actor'

// clientId is null for the operator, who reaches every project, and is what the relay checks access with
// for everyone else.
export type Who = {
    caller: Caller
    clientId: string | null
    // Set only while the operator is viewing as a client: everything else about this caller is that client's,
    // and this is who is really asking, for the banner and for anything that records who did what.
    impersonatedBy?: string
    clientName?: string
}

export type SessionSources = {
    adminSession: () => Promise<{ user?: { email?: string | null } | null } | null>
    adminEmail: string | undefined
    clientSession: () => Promise<{ client: { id: string } } | null>
    // The projects a client has been given access to, and those of them whose env files they may edit, read
    // on every request so a grant taken away stops working at once rather than when the session ends
    clientSites: (clientId: string) => Promise<{ sites: string[], envSites: string[] }>
    // The client the operator has chosen to view as, if any. Only ever asked once the admin session has
    // been checked, so on its own the cookie behind it makes nobody anybody.
    impersonating: (adminEmail: string) => Promise<{ id: string, name: string } | null>
}

// Imported where they are used rather than at the top of the file: server/auth builds a NextAuth instance on
// import and server/clients/auth reaches for cookies and Postgres, so a static import would drag both into
// every module that only wants the type. It also means an admin request never loads the client session code.
const liveSources = (): SessionSources => ({
    adminSession: async () => {
        const { auth } = await import('../auth')
        return auth()
    },
    adminEmail: process.env.ADMIN_EMAIL,
    clientSession: async () => {
        const { currentClient } = await import('../clients/auth')
        return currentClient()
    },
    clientSites: async clientId => {
        const { hostdSitesOf } = await import('../sites/access')
        return hostdSitesOf(clientId)
    },
    impersonating: async adminEmail => {
        const { impersonatedClient } = await import('../clients/impersonating')
        return impersonatedClient(adminEmail)
    },
})

export async function callerFromSession(sources: SessionSources = liveSources()): Promise<Who | null> {
    // The operator first, and answered without reading the client session: an admin owns every project, so
    // there is nothing a second lookup could add.
    const session = await sources.adminSession()
    const email = session?.user?.email
    if (email && isAdminSession(session, sources.adminEmail)) {
        // Viewing as a client makes the operator that client in every respect the portal and hostd check,
        // read from the same grants the client's own session would be, so what shows is what they would see.
        // Only hostd's audit line still names the operator.
        const viewing = await sources.impersonating(email)
        if (viewing) {
            const { sites, envSites } = await sources.clientSites(viewing.id)
            return {
                caller: callerForClient(viewing.id, sites, email, envSites),
                clientId: viewing.id,
                impersonatedBy: email,
                clientName: viewing.name,
            }
        }
        return { caller: callerForAdmin(email), clientId: null }
    }

    const client = await sources.clientSession()
    if (client) {
        const { sites, envSites } = await sources.clientSites(client.client.id)
        return { caller: callerForClient(client.client.id, sites, client.client.id, envSites), clientId: client.client.id }
    }

    return null
}
