'use server'

// Starting and stopping "View as client". Both are the operator's alone and run requireAdmin() first, the
// same as every other admin action: the cookie they write only ever counts beside the operator's session.

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin } from '@/server/auth'
import { CLIENT_ID_PATTERN } from '@/server/clients/ids'
import { record } from '@/server/audit/record'
import { impersonationEntry } from '@/server/clients/impersonation'
import { clearImpersonationCookie, setImpersonationCookie } from '@/server/clients/impersonating'
import { repo } from '@/server/clients/wiring'

const clientId = z.string().regex(CLIENT_ID_PATTERN)

export async function startViewingAsAction(id: string): Promise<void> {
    const session = await requireAdmin()
    const admin = session.user?.email
    if (!admin || !clientId.safeParse(id).success) redirect('/portal/clients')
    const client = await repo().byId(id)
    // A suspended client cannot sign in, so there is nothing of theirs to look at. The button is not offered
    // for one; this is the line the server holds whatever the page drew.
    if (!client || client.suspendedAt) redirect(`/portal/clients/${encodeURIComponent(id)}`)

    await setImpersonationCookie(client.id, admin)
    await record(impersonationEntry({ kind: 'start', admin, client }))
    redirect('/portal')
}

export async function stopViewingAsAction(): Promise<void> {
    const session = await requireAdmin()
    const admin = session.user?.email ?? null
    const stopped = await clearImpersonationCookie(admin)
    if (admin && stopped) {
        // Named if they are still there; a client deleted while being viewed is recorded by id alone
        const client = await repo().byId(stopped).catch(() => null)
        await record(impersonationEntry({ kind: 'stop', admin, client: { id: stopped, name: client?.name ?? null } }))
    }
    // Back to where it started, so the next change to their access is one click away
    redirect(stopped ? `/portal/clients/${stopped}` : '/portal/clients')
}
