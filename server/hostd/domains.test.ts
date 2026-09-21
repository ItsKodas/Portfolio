import { describe, expect, it, vi } from 'vitest'

import { listDomains, addDomain, removeDomain, adoptSite } from './domains'

const config = { url: 'http://hostd:8080', token: 'secret' }
const caller = { actor: 'admin' as const, user: 'koda@horizons.gg', clientId: null }

const answering = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('listDomains', () => {
    it('asks the environment\'s own path and unwraps the list', async () => {
        const fetchImpl = answering({ ok: true, domains: [{ hostname: 'acme.com', primary: true, state: 'active' }] })
        const result = await listDomains(config, caller, 'acme', 'live', fetchImpl as unknown as typeof fetch)
        expect(result.ok && result.value[0]?.hostname).toBe('acme.com')
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://hostd:8080/projects/acme/live/domains')
    })

    it('refuses a project id that is not one, without asking hostd', async () => {
        const fetchImpl = answering({})
        const result = await listDomains(config, caller, '../etc', 'live', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

describe('addDomain', () => {
    it('refuses a hostname that is not one, without asking hostd', async () => {
        const fetchImpl = answering({})
        for (const bad of ['localhost', 'not a host', 'https://acme.com', '']) {
            const result = await addDomain(config, caller, 'acme', 'live', bad, fetchImpl as unknown as typeof fetch)
            expect(result.ok, bad).toBe(false)
        }
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('posts the hostname and returns the new list', async () => {
        const fetchImpl = answering({ ok: true, domains: [{ hostname: 'www.acme.com', primary: false, state: 'pending' }] })
        const result = await addDomain(config, caller, 'acme', 'live', 'www.acme.com', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(true)
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ hostname: 'www.acme.com' })
    })
})

describe('removeDomain', () => {
    it('puts the hostname in the path, encoded', async () => {
        const fetchImpl = answering({ ok: true, domains: [] })
        await removeDomain(config, caller, 'acme', 'live', 'www.acme.com', fetchImpl as unknown as typeof fetch)
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://hostd:8080/projects/acme/live/domains/www.acme.com')
    })
})

describe('adoptSite', () => {
    it('sends the confirmation hostd asks for', async () => {
        const fetchImpl = answering({ ok: true, domains: [] })
        await adoptSite(config, caller, 'acme', 'live', 'Acme Bakery', fetchImpl as unknown as typeof fetch)
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ confirm: 'Acme Bakery' })
    })

    it('carries hostd\'s refusal through rather than inventing one', async () => {
        const fetchImpl = answering({ ok: false, code: 'bad-request', message: 'acme.conf cannot be read well enough to adopt' }, 400)
        const result = await adoptSite(config, caller, 'acme', 'live', 'wrong', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.message).toMatch(/cannot be read/)
    })
})
