import { describe, expect, it } from 'vitest'

import { addEnvironment, deleteEnvironment, listDeletedEnvironments, restoreEnvironment } from './environments'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown, headers?: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body, headers: init.headers as Record<string, string> })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('addEnvironment', () => {
    it('posts the name, the branch and the hostname', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: 'acme uat1 was added on port 5014' })
        const result = await addEnvironment(config, admin, 'acme', { name: 'uat1', branch: 'uat', domain: 'uat.acme.com' }, fetchImpl)
        expect(result).toEqual({ ok: true, value: { output: 'acme uat1 was added on port 5014' } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/environments')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].headers?.['content-type']).toBe('application/json')
        expect(JSON.parse(calls[0].body as string)).toEqual({ name: 'uat1', branch: 'uat', domain: 'uat.acme.com' })
    })

    it('sends no hostname as null', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await addEnvironment(config, admin, 'acme', { name: 'uat1', branch: 'uat', domain: null }, fetchImpl)
        expect(JSON.parse(calls[0].body as string)).toEqual({ name: 'uat1', branch: 'uat', domain: null })
    })

    it('carries a vhost that could not be written back beside the environment that was added', async () => {
        const { fetchImpl } = fakeFetch({ ok: true, vhost: { ok: false, message: 'Apache refused it' } })
        const result = await addEnvironment(config, admin, 'acme', { name: 'uat1', branch: 'uat', domain: 'uat.acme.com' }, fetchImpl)
        expect(result).toEqual({ ok: true, value: { vhost: { ok: false, message: 'Apache refused it' } } })
    })

    it('refuses live, a reserved name, a bad name or a bad hostname before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        for (const name of ['live', 'next', 'uat-1']) {
            expect((await addEnvironment(config, admin, 'acme', { name, branch: 'uat', domain: null }, fetchImpl)).ok, name).toBe(false)
        }
        expect((await addEnvironment(config, admin, 'acme', { name: 'uat1', branch: 'uat', domain: 'not a host' }, fetchImpl)).ok).toBe(false)
        expect((await addEnvironment(config, admin, '../x', { name: 'uat1', branch: 'uat', domain: null }, fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })

    it('carries hostd\'s refusal through', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'conflict', message: 'acme already has uat1' }, 409)
        expect(await addEnvironment(config, admin, 'acme', { name: 'uat1', branch: 'uat', domain: null }, fetchImpl))
            .toEqual({ ok: false, code: 'conflict', message: 'acme already has uat1' })
    })
})

describe('deleteEnvironment', () => {
    it('sends a DELETE for the environment with the site name typed back', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: 'uat1 was stopped and moved to the trash' })
        const result = await deleteEnvironment(config, admin, 'acme', 'uat1', 'Acme Bakery', fetchImpl)
        expect(result).toEqual({ ok: true, value: { output: 'uat1 was stopped and moved to the trash' } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/environments/uat1')
        expect(calls[0].method).toBe('DELETE')
        expect(JSON.parse(calls[0].body as string)).toEqual({ name: 'Acme Bakery' })
    })

    it('refuses live, and any name that could not be an environment, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        for (const environment of ['live', 'git', '../live']) {
            expect((await deleteEnvironment(config, admin, 'acme', environment, 'Acme', fetchImpl)).ok, environment).toBe(false)
        }
        expect(calls).toHaveLength(0)
    })
})

describe('listDeletedEnvironments', () => {
    it('unwraps the list hostd answers for the project', async () => {
        const environments = [{
            environment: 'uat1',
            deletedAt: '2026-09-20T10:00:00.000Z',
            purgeAt: '2026-10-20T10:00:00.000Z',
            branch: 'uat',
            domain: 'uat.acme.com',
            aliases: [],
        }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, environments })
        expect(await listDeletedEnvironments(config, admin, 'acme', fetchImpl)).toEqual({ ok: true, value: environments })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/deleted-environments')
        expect(calls[0].method).toBeUndefined()
    })

    it('refuses a malformed id before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, environments: [] })
        expect((await listDeletedEnvironments(config, admin, '../x', fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})

describe('restoreEnvironment', () => {
    it('posts which deletion to restore, and answers the port and any dropped hostnames', async () => {
        const reply = { ok: true, port: 5019, portChanged: true, droppedHostnames: ['uat.acme.com'] }
        const { fetchImpl, calls } = fakeFetch(reply)
        const result = await restoreEnvironment(config, admin, 'acme', 'uat1', '2026-09-20T10:00:00.000Z', fetchImpl)
        expect(result).toEqual({ ok: true, value: { port: 5019, portChanged: true, droppedHostnames: ['uat.acme.com'] } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/deleted-environments/uat1/restore')
        expect(calls[0].method).toBe('POST')
        expect(JSON.parse(calls[0].body as string)).toEqual({ deletedAt: '2026-09-20T10:00:00.000Z' })
    })

    it('reads a reply with no dropped hostnames as none', async () => {
        const { fetchImpl } = fakeFetch({ ok: true, port: 5014, portChanged: false })
        expect(await restoreEnvironment(config, admin, 'acme', 'uat1', '2026-09-20T10:00:00.000Z', fetchImpl))
            .toEqual({ ok: true, value: { port: 5014, portChanged: false, droppedHostnames: [] } })
    })

    it('refuses live before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        expect((await restoreEnvironment(config, admin, 'acme', 'live', '2026-09-20T10:00:00.000Z', fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
