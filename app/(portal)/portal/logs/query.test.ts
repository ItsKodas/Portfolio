import { describe, expect, it } from 'vitest'

import { activityHref, emailsHref, readActivityQuery, readPage } from './query'

describe('readActivityQuery', () => {
    it('reads every filter and the page', () => {
        expect(readActivityQuery({ type: 'deploy', actor: 'cl_ABCD1234', site: 'asot', page: '3' }))
            .toEqual({ category: 'deploy', actor: 'cl_ABCD1234', site: 'asot', page: 3 })
    })

    it('drops a type that is not one of the categories', () => {
        expect(readActivityQuery({ type: 'nonsense' }).category).toBeNull()
        expect(readActivityQuery({ type: 'constructor' }).category).toBeNull()
    })

    it('treats empty values as no filter', () => {
        expect(readActivityQuery({ type: '', actor: '  ', site: '' })).toEqual({ category: null, actor: null, site: null, page: 1 })
    })

    it('takes the first of a repeated parameter', () => {
        expect(readActivityQuery({ site: ['asot', 'other'] }).site).toBe('asot')
    })
})

describe('readPage', () => {
    it('falls back to the first page on anything that is not a whole number from one up', () => {
        for (const bad of ['0', '-2', '1.5', 'two', '', undefined, '1e9']) expect(readPage(bad)).toBe(1)
        expect(readPage('7')).toBe(7)
    })
})

describe('activityHref', () => {
    const query = { category: 'site' as const, actor: 'koda@horizons.gg', site: 'asot', page: 4 }

    it('keeps the filters when only the page changes', () => {
        expect(activityHref(query, { page: 5 })).toBe('/portal/logs?type=site&actor=koda%40horizons.gg&site=asot&page=5')
    })

    it('goes back to the first page when a filter changes', () => {
        expect(activityHref(query, { site: null })).toBe('/portal/logs?type=site&actor=koda%40horizons.gg')
    })

    it('is the bare page with nothing set', () => {
        expect(activityHref({ category: null, actor: null, site: null, page: 1 }, {})).toBe('/portal/logs')
    })
})

describe('emailsHref', () => {
    it('leaves the first page off', () => {
        expect(emailsHref(1)).toBe('/portal/logs/emails')
        expect(emailsHref(2)).toBe('/portal/logs/emails?page=2')
    })
})
