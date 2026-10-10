// Every kind of thing the activity log records, with the words the Logs page shows for it. A plain module
// with no imports, so the page, the recorder and the tests all read the same list.

export const CATEGORIES = {
    auth: 'Sign-ins',
    site: 'Sites',
    deploy: 'Deploys',
    env: 'Environments',
    domain: 'Domains',
    backup: 'Backups',
    access: 'Access',
    client: 'Clients',
    quote: 'Quotes',
} as const

export type Category = keyof typeof CATEGORIES

// The part before the first dot is the category, which is what the page filters by
export const KINDS = {
    'auth.adminSignIn': 'Operator signed in',
    'auth.adminSignOut': 'Operator signed out',
    'auth.signIn': 'Client signed in',
    'auth.signInRefused': 'Sign-in refused',
    'auth.codeRefused': 'Second factor refused',
    'auth.signOut': 'Client signed out',
    'auth.inviteAccepted': 'Invite accepted',
    'auth.enrolled': 'Authenticator set up',
    'auth.resetRequested': 'Password reset asked for',
    'auth.resetCompleted': 'Password reset',
    'auth.passwordChanged': 'Password changed',
    'auth.codesRegenerated': 'Recovery codes replaced',
    'auth.signedOutElsewhere': 'Other sessions signed out',

    'site.create': 'Site created',
    'site.delete': 'Site deleted',
    'site.start': 'Site started',
    'site.stop': 'Site stopped',
    'site.restart': 'Site restarted',
    'site.settings': 'Settings saved',
    'site.adopt': 'Configuration adopted',

    'deploy.start': 'Deploy started',
    'deploy.rollback': 'Rolled back',
    'deploy.branch': 'Branch changed',

    'env.file': 'Env file saved',
    'env.add': 'Environment added',
    'env.delete': 'Environment deleted',
    'env.restore': 'Environment restored',
    'env.copy': 'Live copied in',
    'env.port': 'Port changed',

    'domain.add': 'Domain added',
    'domain.remove': 'Domain removed',
    'domain.verify': 'Domain checked',
    'domain.primary': 'Address set',

    'backup.start': 'Backup started',
    'backup.delete': 'Backup deleted',
    'backup.schedule': 'Backup schedule saved',
    'backup.download': 'Backup downloaded',
    'backup.restore': 'Backup restore started',

    'access.grant': 'Access given',
    'access.permissions': 'Access changed',
    'access.revoke': 'Access taken away',

    'client.create': 'Client created',
    'client.update': 'Client details changed',
    'client.invite': 'Invite sent again',
    'client.reset': 'Reset link sent',
    'client.twoFactorReset': 'Authenticator reset',
    'client.twoFactorRequired': 'Two-step sign-in required',
    'client.twoFactorOptional': 'Two-step sign-in turned off',
    'client.suspend': 'Client suspended',
    'client.unsuspend': 'Client restored',
    'client.unlock': 'Lock cleared',
    'client.delete': 'Client deleted',
    'client.publicContact': 'Public contact changed',
    'client.viewAsStart': 'Started viewing as client',
    'client.viewAsStop': 'Stopped viewing as client',

    'quote.submit': 'Quote received',
    'quote.status': 'Quote status changed',
    'quote.archive': 'Quote archived',
    'quote.unarchive': 'Quote unarchived',
    'quote.note': 'Note added',
    'quote.noteDelete': 'Note deleted',
    'quote.delete': 'Quote deleted',
    'quote.resend': 'Quote emails sent again',
} as const satisfies Record<`${Category}.${string}`, string>

export type Kind = keyof typeof KINDS

export const isCategory = (value: unknown): value is Category =>
    typeof value === 'string' && Object.hasOwn(CATEGORIES, value)

export const categoryOf = (kind: string): Category | null => {
    const head = kind.split('.')[0]
    return isCategory(head) ? head : null
}

// A kind recorded by an older build and since renamed still shows, as itself, rather than as nothing
export const kindLabel = (kind: string): string => (Object.hasOwn(KINDS, kind) ? KINDS[kind as Kind] : kind)
