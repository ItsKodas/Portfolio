// One environment's visits, for the Overview's analytics panel. hostd counts them out of the access log
// Apache writes for the environment, so nothing is added to the client's site to collect them. Any
// actor who may see the site may read them: hostd checks them against its status policy.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'
import type { EnvironmentName } from './env'
import { PROJECT_ID } from './logs'

// These mirror hostd/src/shared/analytics.ts. Days are Brisbane calendar days, YYYY-MM-DD, oldest
// first, with every day of the window present. visitors is distinct visitors within that one day.
export type AnalyticsDay = { date: string, views: number, visitors: number }
export type AnalyticsCount = { key: string, count: number }

export type Analytics = {
    days: AnalyticsDay[]
    pages: AnalyticsCount[]
    referrers: AnalyticsCount[]
    // Two-letter country codes, only for a site behind Cloudflare
    countries: AnalyticsCount[]
    // The first day anything was ever counted, or null
    since: string | null
    // Whether Apache is writing this environment's access log at all
    logging: boolean
}

export const ANALYTICS_DAYS = 30

export async function getAnalytics(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    days: number = ANALYTICS_DAYS,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Analytics>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    const result = await hostdRequest<Analytics>(config, caller, `/projects/${id}/${environment}/analytics?days=${days}`, {}, fetchImpl)
    if (!result.ok) return result
    // Rebuilt rather than passed through, so hostd's envelope does not travel inside the value
    const { days: series, pages, referrers, countries, since, logging } = result.value
    return { ok: true, value: { days: series, pages, referrers, countries, since, logging } }
}
