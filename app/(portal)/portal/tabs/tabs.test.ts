import { describe, expect, it } from 'vitest'

import { tabsFor } from './tabs'

const active = (admin: boolean, pathname: string) =>
    tabsFor(admin, pathname).filter(tab => tab.active).map(tab => tab.label)

describe('tabsFor', () => {
    it('gives the operator the sites, the quotes and the clients', () => {
        expect(tabsFor(true, '/portal').map(tab => tab.label)).toEqual(['Sites', 'Quotes', 'Clients'])
    })

    it('gives a client their overview and their account, and nothing of the operator\'s', () => {
        expect(tabsFor(false, '/portal').map(tab => tab.label)).toEqual(['Overview', 'Account'])
    })

    it('lights the dashboard\'s tab on a site page, since the dashboard is what lists them', () => {
        expect(active(true, '/portal/sites/asot')).toEqual(['Sites'])
        expect(active(false, '/portal/sites/asot')).toEqual(['Overview'])
    })

    it('lights a section\'s tab on the pages under it', () => {
        expect(active(true, '/portal/quotes/42')).toEqual(['Quotes'])
        expect(active(true, '/portal/clients/new')).toEqual(['Clients'])
    })

    it('does not let /portal claim every page beneath it', () => {
        expect(active(true, '/portal/quotes')).toEqual(['Quotes'])
        expect(active(false, '/portal/account')).toEqual(['Account'])
    })

    it('does not match a path that only starts with the same letters', () => {
        expect(active(true, '/portal/quotesque')).toEqual([])
    })

    it('lights nothing on a page that is none of them', () => {
        expect(active(true, '/portal/ui')).toEqual([])
        expect(active(true, '')).toEqual([])
    })
})
