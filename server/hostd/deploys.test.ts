import { describe, expect, it } from 'vitest'

import { listCommits, listDeploys, rollback, setBranch, startDeploy } from './deploys'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

const record = {
    commit: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
    subject: 'Fix the booking form',
    actor: 'hostd',
    trigger: 'poll' as const,
    startedAt: '2026-09-21T21:06:00.000Z',
    durationMs: 74_000,
    outcome: 'ok' as const,
    reason: null,
    output: null,
}

// Exactly what hostd's DeployHistoryReply carries, minus the ok flag this module unwraps
const history = {
    ok: true,
    environment: 'live',
    branch: 'main',
    deployed: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
    paused: false,
    consecutiveFailures: 0,
    deploys: [record],
}

describe('listDeploys', () => {
    it('asks the environment for its history and hands back everything but the flag', async () => {
        const { fetchImpl, calls } = fakeFetch(history)
        const result = await listDeploys(config, admin, 'acme-bakery', 'live', fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/live/deploys')
        expect(result).toEqual({
            ok: true,
            value: {
                environment: 'live',
                branch: 'main',
                deployed: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
                paused: false,
                consecutiveFailures: 0,
                deploys: [record],
            },
        })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch(history)
        const result = await listDeploys(config, admin, '../etc', 'live', fetchImpl)

        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })

    it('passes a refusal through rather than inventing an empty history', async () => {
        // An environment with deploys turned off is refused, and an empty list would read as a site that
        // has never been deployed, which is a different thing entirely.
        const { fetchImpl } = fakeFetch({ ok: false, code: 'capability-disabled', message: 'deploy is off' }, 403)
        const result = await listDeploys(config, admin, 'acme-bakery', 'live', fetchImpl)

        expect(result).toEqual({ ok: false, code: 'capability-disabled', message: 'deploy is off' })
    })
})

describe('listCommits', () => {
    it('leaves the limit off when none was asked for, so hostd picks its own default', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, commits: [] })
        await listCommits(config, admin, 'acme-bakery', 'test', undefined, fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/test/commits')
    })

    it('sends a limit it was given, and unwraps the commits', async () => {
        const commits = [{ commit: '5f0ac31', subject: 'Fix the booking form', author: 'Koda', at: '2026-09-21T21:00:00.000Z' }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, commits })
        const result = await listCommits(config, admin, 'acme-bakery', 'live', 10, fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/live/commits?limit=10')
        expect(result).toEqual({ ok: true, value: commits })
    })

    it('refuses a limit outside what hostd accepts, before asking', async () => {
        // hostd answers 1 to 100 and 400s anything else. Spending a request to be told that is pointless.
        const { fetchImpl, calls } = fakeFetch({ ok: true, commits: [] })
        for (const limit of [0, -1, 101, 2.5]) {
            const result = await listCommits(config, admin, 'acme-bakery', 'live', limit, fetchImpl)
            expect(result.ok).toBe(false)
        }
        expect(calls).toHaveLength(0)
    })
})

describe('startDeploy and rollback', () => {
    it('posts to the environment and unwraps what was started', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, started: { environment: 'live', trigger: 'manual' } })
        const result = await startDeploy(config, admin, 'acme-bakery', 'live', fetchImpl)

        expect(calls[0]).toMatchObject({ url: 'http://hostd-api:8080/projects/acme-bakery/live/deploy', method: 'POST' })
        expect(result).toEqual({ ok: true, value: { environment: 'live', trigger: 'manual' } })
    })

    it('rolls back through its own route', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, started: { environment: 'live', trigger: 'rollback' } })
        const result = await rollback(config, admin, 'acme-bakery', 'live', fetchImpl)

        expect(calls[0]).toMatchObject({ url: 'http://hostd-api:8080/projects/acme-bakery/live/rollback', method: 'POST' })
        expect(result).toEqual({ ok: true, value: { environment: 'live', trigger: 'rollback' } })
    })

    it('passes the refusal through when one is already running', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'busy', message: 'acme-bakery live already has a deploy running' }, 409)
        const result = await startDeploy(config, admin, 'acme-bakery', 'live', fetchImpl)

        expect(result).toEqual({ ok: false, code: 'busy', message: 'acme-bakery live already has a deploy running' })
    })
})

describe('setBranch', () => {
    it('PUTs the branch as JSON, which is the only body hostd reads here', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, started: { environment: 'test', trigger: 'branch' } })
        const result = await setBranch(config, admin, 'acme-bakery', 'test', 'release/2026-09', fetchImpl)

        expect(calls[0]).toMatchObject({
            url: 'http://hostd-api:8080/projects/acme-bakery/test/branch',
            method: 'PUT',
            body: JSON.stringify({ branch: 'release/2026-09' }),
        })
        expect(result).toEqual({ ok: true, value: { environment: 'test', trigger: 'branch' } })
    })

    it('refuses a name git itself would not take, before asking', async () => {
        // The same grammar hostd checks (GIT_REF in hostd/src/shared/registry.ts). Checked here too so the
        // box on the page can say so immediately rather than after a round trip.
        const { fetchImpl, calls } = fakeFetch({ ok: true, started: { environment: 'live', trigger: 'branch' } })
        for (const branch of ['', ' ', '-main', 'a..b', 'main.lock', 'main.', 'main branch', 'a'.repeat(200)]) {
            const result = await setBranch(config, admin, 'acme-bakery', 'live', branch, fetchImpl)
            expect(result, branch).toEqual({ ok: false, code: 'bad-request', message: 'branch must be a plain branch name' })
        }
        expect(calls).toHaveLength(0)
    })

    it('takes the names git does take', async () => {
        const { fetchImpl } = fakeFetch({ ok: true, started: { environment: 'live', trigger: 'branch' } })
        for (const branch of ['main', 'Master', 'release/2026-09', 'fix-the-thing', 'v1.2.3']) {
            const result = await setBranch(config, admin, 'acme-bakery', 'live', branch, fetchImpl)
            expect(result.ok, branch).toBe(true)
        }
    })
})
