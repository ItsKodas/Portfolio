// Turns the current session into a hostd caller, and nothing else may. The route handlers have no other way
// to say who is asking, so a browser cannot name a client: it only gets the one the cookie it presented
// already belongs to.

import 'server-only'

import { isAdminSession } from '../auth/allow'
import { callerForAdmin, callerForClient, type Caller } from './actor'

// clientId is null for the operator, who owns every project, and is what the relay checks ownership with
// for everyone else.
export type Who = {
    caller: Caller
    clientId: string | null
}

export type SessionSources = {
    adminSession: () => Promise<{ user?: { email?: string | null } | null } | null>
    adminEmail: string | undefined
    clientSession: () => Promise<{ client: { id: string } } | null>
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
})

export async function callerFromSession(sources: SessionSources = liveSources()): Promise<Who | null> {
    // The operator first, and answered without reading the client session: an admin owns every project, so
    // there is nothing a second lookup could add.
    const session = await sources.adminSession()
    const email = session?.user?.email
    if (email && isAdminSession(session, sources.adminEmail)) return { caller: callerForAdmin(email), clientId: null }

    const client = await sources.clientSession()
    if (client) return { caller: callerForClient(client.client.id), clientId: client.client.id }

    return null
}
