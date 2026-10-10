// The panel is an async server component, so it is awaited and its result rendered, the same way
// backupPanel.test.tsx does it.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const getAnalytics = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/analytics', () => ({ getAnalytics: (...args: unknown[]) => getAnalytics(...args) }))

// jsdom has no ResizeObserver; the chart only needs one to exist
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver

const { SiteAnalytics } = await import('./analytics')

const admin = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }
const client = { caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }

const report = (over: Record<string, unknown> = {}) => ({
    ok: true,
    value: {
        days: [
            { date: '2026-10-08', views: 0, visitors: 0 },
            { date: '2026-10-09', views: 12, visitors: 7 },
            { date: '2026-10-10', views: 5, visitors: 3 },
        ],
        pages: [{ key: '/', count: 10 }, { key: '/pricing', count: 7 }],
        referrers: [{ key: 'google.com', count: 4 }],
        countries: [{ key: 'AU', count: 9 }],
        since: '2026-10-08',
        logging: true,
        ...over,
    },
})

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue(client)
})

describe('SiteAnalytics', () => {
    it('shows the totals, the chart and what was read most, for the live environment', async () => {
        getAnalytics.mockResolvedValue(report())
        render(await SiteAnalytics({ id: 'asot', isAdmin: false }))

        expect(getAnalytics.mock.calls[0]?.[2]).toBe('asot')
        expect(getAnalytics.mock.calls[0]?.[3]).toBe('live')
        expect(screen.getByText('17')).toBeTruthy()
        expect(screen.getByRole('img', { name: /Visits and unique visitors per day/ })).toBeTruthy()
        expect(screen.getByText('/pricing')).toBeTruthy()
        expect(screen.getByText('google.com')).toBeTruthy()
        expect(screen.getByText('Australia')).toBeTruthy()
    })

    it('leaves the countries out for a site hostd cannot tell them for', async () => {
        getAnalytics.mockResolvedValue(report({ countries: [] }))
        render(await SiteAnalytics({ id: 'asot', isAdmin: false }))
        expect(screen.queryByText('Countries')).toBeNull()
    })

    it('says the site is not being counted rather than drawing an empty chart', async () => {
        getAnalytics.mockResolvedValue(report({ logging: false, since: null }))
        render(await SiteAnalytics({ id: 'asot', isAdmin: false }))
        expect(screen.getByText('Not being counted yet')).toBeTruthy()
        expect(screen.queryByRole('img')).toBeNull()
    })

    it('tells the operator hostd\'s own words and a client a fixed sentence when the read fails', async () => {
        getAnalytics.mockResolvedValue({ ok: false, code: 'unavailable', message: 'analytics are not configured' })
        callerFromSession.mockResolvedValue(admin)
        render(await SiteAnalytics({ id: 'asot', isAdmin: true }))
        expect(screen.getByText(/analytics are not configured/)).toBeTruthy()

        callerFromSession.mockResolvedValue(client)
        render(await SiteAnalytics({ id: 'asot', isAdmin: false }))
        expect(screen.getByText(/temporarily unavailable/)).toBeTruthy()
    })
})
