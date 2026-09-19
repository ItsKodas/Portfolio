// Who may use the admin area: one Google account, named by ADMIN_EMAIL. Plain functions with no server-only import,
// because the middleware uses them too.

const normalise = (email: string) => email.trim().toLowerCase()

export function isAllowedAdmin(profile: { email?: string | null, email_verified?: unknown } | null | undefined, adminEmail: string | undefined): boolean {
    if (!adminEmail?.trim() || !profile?.email || profile.email_verified !== true) return false
    return normalise(profile.email) === normalise(adminEmail)
}

export function isAdminSession(session: { user?: { email?: string | null } | null } | null | undefined, adminEmail: string | undefined): boolean {
    const email = session?.user?.email
    if (!adminEmail?.trim() || !email) return false
    return normalise(email) === normalise(adminEmail)
}
