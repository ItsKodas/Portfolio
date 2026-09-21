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

// ui/Chip has three tones and a neutral. Invited was MUI's `info`, which has no tone here and is not a
// problem, so it takes the neutral chip rather than borrowing a colour that would read as a warning.
export const STATE_TONES: Record<ClientState, 'good' | 'warn' | 'crit' | undefined> = {
    Invited: undefined,
    'Setup incomplete': 'warn',
    Suspended: 'crit',
    Locked: 'warn',
    Active: 'good',
}
