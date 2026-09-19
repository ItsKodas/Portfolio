// The fixed choices on the quote form, and the words shown for each, in one place so the form, the emails and the
// admin area can't drift apart. The values match the enums in prisma/schema.prisma (labels.test.ts checks that).
// No server-only import: the browser form uses this file too.

export const PROJECT_TYPES = ['NEW_SITE', 'REDESIGN', 'WEB_APP', 'ONLINE_STORE', 'OTHER'] as const
export const BUDGETS = ['UNDER_2K', 'FROM_2K_TO_5K', 'FROM_5K_TO_10K', 'OVER_10K', 'NOT_SURE'] as const
export const TIMELINES = ['ASAP', 'ONE_TO_THREE_MONTHS', 'OVER_THREE_MONTHS', 'FLEXIBLE'] as const
export const STATUSES = ['NEW', 'REPLIED', 'WON', 'LOST'] as const

export type ProjectType = typeof PROJECT_TYPES[number]
export type Budget = typeof BUDGETS[number]
export type Timeline = typeof TIMELINES[number]
export type Status = typeof STATUSES[number]

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
    NEW_SITE: 'New website',
    REDESIGN: 'Redesign',
    WEB_APP: 'Web app',
    ONLINE_STORE: 'Online store',
    OTHER: 'Other',
}

// In Australian dollars
export const BUDGET_LABELS: Record<Budget, string> = {
    UNDER_2K: 'Under $2k',
    FROM_2K_TO_5K: '$2k to $5k',
    FROM_5K_TO_10K: '$5k to $10k',
    OVER_10K: '$10k+',
    NOT_SURE: 'Not sure yet',
}

export const TIMELINE_LABELS: Record<Timeline, string> = {
    ASAP: 'As soon as possible',
    ONE_TO_THREE_MONTHS: '1 to 3 months',
    OVER_THREE_MONTHS: '3+ months',
    FLEXIBLE: 'Flexible',
}

export const STATUS_LABELS: Record<Status, string> = {
    NEW: 'New',
    REPLIED: 'Replied',
    WON: 'Won',
    LOST: 'Lost',
}
