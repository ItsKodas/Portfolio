// What the portal's analytics panel is drawn from: one environment's page views and visitors per day,
// read out of the access log Apache writes for it. Shared because api and the agent both name it, and
// the portal mirrors it in server/hostd/analytics.ts.

import type { EnvironmentName } from './registry.ts'

// How far back one request may look. The access logs themselves only go back as far as logrotate keeps
// them (fourteen days on Debian), so anything older comes out of the agent's own record of past days.
export const MAX_ANALYTICS_DAYS = 90
export const DEFAULT_ANALYTICS_DAYS = 30
// How many rows each top list carries. Enough to fill a short table on the overview, no more.
export const TOP_ROWS = 10

// Days are calendar days in the agent's analytics time zone (Brisbane unless configured), YYYY-MM-DD.
// visitors is the distinct visitors seen that day, so it is a true count within the day, and adding it up
// across days counts a returning visitor once per day.
export type AnalyticsDay = { date: string, views: number, visitors: number }
export type AnalyticsCount = { key: string, count: number }

export type AnalyticsReply = {
    ok: true
    environment: EnvironmentName
    // Every day of the window, oldest first, zeros included, so the chart never has to fill gaps itself
    days: AnalyticsDay[]
    // Over the whole window
    pages: AnalyticsCount[]
    referrers: AnalyticsCount[]
    // Two-letter codes from Cloudflare's CF-IPCountry header. Empty for a site not behind Cloudflare.
    countries: AnalyticsCount[]
    // The first day anything was counted, or null when nothing ever has been. Lets the panel say that
    // the numbers start there rather than drawing the days before it as a site nobody visited.
    since: string | null
    // Whether Apache is writing this environment's access log at all. False until hostd has rewritten
    // its vhost with the log line, and for an environment served by a hand-written vhost.
    logging: boolean
}
