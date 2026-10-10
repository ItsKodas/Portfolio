// The Logs page's address bar: what its filters and page number read from it, and the links that change one
// of them. Everything here arrived in a URL, so each value is checked rather than trusted.

import { isCategory, type Category } from '@/server/audit/kinds'

export type ActivityQuery = { category: Category | null, actor: string | null, site: string | null, page: number }

type Params = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined): string | null => {
    const text = Array.isArray(value) ? value[0] : value
    const trimmed = text?.trim()
    return trimmed ? trimmed.slice(0, 200) : null
}

// A page number from the address bar, falling back to the first on anything that is not a whole number
export function readPage(value: string | string[] | undefined): number {
    const page = Number(one(value))
    return Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1
}

export function readActivityQuery(params: Params): ActivityQuery {
    const type = one(params.type)
    return {
        category: isCategory(type) ? type : null,
        actor: one(params.actor),
        site: one(params.site),
        page: readPage(params.page),
    }
}

// The same filters with something changed. A changed filter starts again from the first page, because page 4
// of a different list is nothing in particular.
export function activityHref(query: ActivityQuery, change: Partial<ActivityQuery>): string {
    const next = { ...query, ...('page' in change ? {} : { page: 1 }), ...change }
    const search = new URLSearchParams()
    if (next.category) search.set('type', next.category)
    if (next.actor) search.set('actor', next.actor)
    if (next.site) search.set('site', next.site)
    if (next.page > 1) search.set('page', String(next.page))
    const text = search.toString()
    return text ? `/portal/logs?${text}` : '/portal/logs'
}

export const emailsHref = (page: number) => (page > 1 ? `/portal/logs/emails?page=${page}` : '/portal/logs/emails')
