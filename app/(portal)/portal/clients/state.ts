// The state shown in the admin area, derived rather than stored. There is no status column on the Client
// table on purpose: a stored status could say ACTIVE while the row has no password hash.

export type ClientState = 'Invited' | 'Setup incomplete' | 'Suspended' | 'Locked' | 'Active'

type Fields = { passwordHash: string | null, totpConfirmedAt: Date | null, suspendedAt: Date | null, lockedUntil: Date | null }

export function clientState(client: Fields, now: Date): ClientState {
    // First, because it is the one that stops everything regardless of the rest
    if (client.suspendedAt) return 'Suspended'
    if (!client.passwordHash) return 'Invited'
    if (!client.totpConfirmedAt) return 'Setup incomplete'
    if (client.lockedUntil && client.lockedUntil.getTime() > now.getTime()) return 'Locked'
    return 'Active'
}

export const STATE_COLOURS: Record<ClientState, 'default' | 'info' | 'warning' | 'error' | 'success'> = {
    Invited: 'info',
    'Setup incomplete': 'warning',
    Suspended: 'error',
    Locked: 'warning',
    Active: 'success',
}
