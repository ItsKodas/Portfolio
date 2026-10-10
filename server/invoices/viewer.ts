// Whose billing a portal page is showing: the signed-in client's own, or the client the operator is viewing as.
// Read from the session alone, the same way every site page decides (server/hostd/session.ts), so nothing in a
// request can point a page at somebody else's invoices.

import 'server-only'

import { getDb } from '../db'
import { callerFromSession } from '../hostd/session'

export type BillingViewer = {
    clientId: string
    name: string
    // Set while the operator is viewing as this client: they see what the client sees and can pay for nothing
    viewingAs: boolean
}

// 'admin' for the operator as themselves, whose invoices page is elsewhere; null for nobody signed in
export async function billingViewer(): Promise<BillingViewer | 'admin' | null> {
    const who = await callerFromSession()
    if (!who) return null
    if (!who.clientId) return 'admin'
    const client = await getDb().client.findUnique({ where: { id: who.clientId }, select: { id: true, name: true } })
    if (!client) return null
    return { clientId: client.id, name: client.name, viewingAs: !!who.impersonatedBy }
}
