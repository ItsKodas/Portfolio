import { describe, expect, it } from 'vitest'

import { getAnalytics } from './analytics'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const client = { actor: 'client:cl_1', user: 'someone@example.com' }

function fakeFetch(body: unknown, status = 200) {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

const report = {
    days: [{ date: '2026-10-10', views: 3, visitors: 2 }],
    pages: [{ key: '/', count: 3 }],
    referrers: [],
    countries: [],
    since: '2026-10-10',
    logging: true,
}

describe('getAnalytics', () => {
    it('asks for one environment\'s window and leaves hostd\'s envelope behind', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, environment: 'live', ...report })
        const result = await getAnalytics(config, client, 'acme', 'live', 30, fetchImpl)
        expect(result).toEqual({ ok: true, value: report })
        expect(calls[0]).toBe('http://hostd-api:8080/projects/acme/live/analytics?days=30')
    })

    it('passes a refusal through', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'unavailable', message: 'analytics are not configured' }, 503)
        expect(await getAnalytics(config, client, 'acme', 'live', 30, fetchImpl))
            .toEqual({ ok: false, code: 'unavailable', message: 'analytics are not configured' })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch(report)
        expect((await getAnalytics(config, client, 'Not An Id', 'live', 30, fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
