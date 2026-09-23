import { describe, expect, it } from 'vitest'

import { createProject, type NewSite } from './create'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

const site: NewSite = {
    id: 'bakery', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git', branch: 'main',
    domain: 'bakery.com', certificate: 'letsencrypt', dir: 'bakery', compose: ['docker-compose.yml'],
    capabilities: ['lifecycle', 'deploy'], websockets: false, flexibleSsl: false,
}

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown, signal?: AbortSignal | null }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body, signal: init.signal })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('createProject', () => {
    it('posts the whole site, leaving out a client and credential it was not given', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, project: { id: 'bakery', state: 'needs-setup' }, envFiles: [] })
        const result = await createProject(config, admin, site, fetchImpl)

        expect(result).toEqual({ ok: true, value: {} })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects')
        expect(calls[0].method).toBe('POST')
        const sent = JSON.parse(calls[0].body as string)
        expect(sent).toEqual(site)
        expect('client' in sent).toBe(false)
        expect('credential' in sent).toBe(false)
    })

    it('answers the vhost outcome hostd reported beside the create', async () => {
        const vhost = { ok: false, message: 'bakery.com is already served by /etc/apache2/sites-enabled/bakery.conf.' }
        const { fetchImpl } = fakeFetch({ ok: true, project: { id: 'bakery', state: 'needs-setup' }, envFiles: [], vhost })
        expect(await createProject(config, admin, site, fetchImpl)).toEqual({ ok: true, value: { vhost } })
    })

    it('carries hostd\'s refusal through', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'bad-request', message: '/var/www/bakery already exists' }, 400)
        expect(await createProject(config, admin, site, fetchImpl))
            .toEqual({ ok: false, code: 'bad-request', message: '/var/www/bakery already exists' })
    })

    it('refuses an id or hostname hostd would not take, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        expect((await createProject(config, admin, { ...site, id: '../x' }, fetchImpl)).ok).toBe(false)
        expect((await createProject(config, admin, { ...site, domain: 'not a host' }, fetchImpl)).ok).toBe(false)
        expect(calls).toEqual([])
    })
})
