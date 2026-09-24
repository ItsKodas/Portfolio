import { describe, expect, it } from 'vitest'

import { relayDeployWatch, relayLogs } from './relay'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function deps(open: unknown, owns = true) {
    return {
        config,
        caller: admin,
        clientId: null as string | null,
        assertOwned: async () => owns,
        openLogStream: open as never,
        openDeployStream: open as never,
    }
}

describe('relayLogs', () => {
    it('passes the stream through as server-sent events', async () => {
        const body = 'event: line\ndata: {"text":"Ready"}\n\n'
        const open = async () => ({ ok: true, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe(body)
    })

    it('refuses without a service, since hostd requires one', async () => {
        const open = async () => { throw new Error('should not be called') }
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams())
        expect(response.status).toBe(400)
    })

    it('refuses a site belonging to another client, before hostd is asked', async () => {
        const open = async () => { throw new Error('should not be called') }
        const withClient = { ...deps(open, false), clientId: 'cl_8F2K1ABC' }
        const response = await relayLogs(withClient, 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(404)
    })

    it('turns a hostd refusal into a status, without passing its words to the browser', async () => {
        const open = async () => ({ ok: false, code: 'agent-unavailable', message: '/run/hostd/agent.sock is not answering' })
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('/run/hostd')
    })
})

describe('relayDeployWatch', () => {
    it('passes the stream through as server-sent events', async () => {
        const body = 'event: line\ndata: {"kind":"step","text":"building"}\n\n'
        const open = async () => ({ ok: true, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
        const response = await relayDeployWatch(deps(open), 'acme-bakery', new URLSearchParams({ environment: 'live' }))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe(body)
    })

    // The one piece of logic here that the log relay's own tests do not already cover. An environment is
    // part of the path hostd is asked for, so a value that is not a name is refused here rather than sent on.
    it('refuses an environment that is not a valid name, before hostd is asked', async () => {
        const open = async () => { throw new Error('should not be called') }
        for (const environment of ['uat-1', '../live', 'next']) {
            const response = await relayDeployWatch(deps(open), 'acme-bakery', new URLSearchParams({ environment }))
            expect(response.status, environment).toBe(400)
        }
    })

    it('passes a named environment beside live through to hostd', async () => {
        const asked: string[] = []
        const open = async (_c: unknown, _a: unknown, _id: string, environment: string) => {
            asked.push(environment)
            return { ok: true, response: new Response('', { headers: { 'content-type': 'text/event-stream' } }) }
        }
        const response = await relayDeployWatch(deps(open as never), 'acme-bakery', new URLSearchParams({ environment: 'uat1' }))
        expect(response.status).toBe(200)
        expect(asked).toEqual(['uat1'])
    })

    it('refuses without an environment, since hostd watches one at a time', async () => {
        const open = async () => { throw new Error('should not be called') }
        const response = await relayDeployWatch(deps(open), 'acme-bakery', new URLSearchParams())
        expect(response.status).toBe(400)
    })

    it('refuses a site belonging to another client, before hostd is asked', async () => {
        const open = async () => { throw new Error('should not be called') }
        const withClient = { ...deps(open, false), clientId: 'cl_8F2K1ABC' }
        const response = await relayDeployWatch(withClient, 'acme-bakery', new URLSearchParams({ environment: 'live' }))
        expect(response.status).toBe(404)
    })
})
