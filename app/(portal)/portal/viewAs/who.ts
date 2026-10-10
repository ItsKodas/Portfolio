import type { Who } from '@/server/hostd/session'

// The name of the client the operator is viewing as, or null when this caller is just who they are
export function viewingAsName(who: Who | null): string | null {
    if (!who?.impersonatedBy) return null
    return who.clientName ?? 'this client'
}
