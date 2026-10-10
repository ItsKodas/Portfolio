import { describe, expect, it } from 'vitest'

import { deleteBackup, getSchedule, listBackups, openBackupDownload, setSchedule, startBackup } from './backups'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const client = { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }

function fakeFetch(body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) {
    const calls: { url: string, method?: string, body?: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body })
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

const run = {
    run: '0123456789abcdef',
    tag: 'manual' as const,
    actor: 'client',
    startedAt: '2026-10-05T16:00:00.000Z',
    durationMs: 42_000,
    outcome: 'ok' as const,
    snapshot: '4f1c2a9be7d0aa11223344556677889900aabbccddeeff00112233445566',
    reason: null,
    disruptive: false,
}

const schedule = { mode: 'daily' as const, hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } }

describe('listBackups', () => {
    it('asks the project for its copies and runs, and drops the flag', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, snapshots: [{ id: '4f1c2a9b', at: run.startedAt, tag: 'manual' }], runs: [run], running: false })
        const result = await listBackups(config, client, 'acme-bakery', fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/backups')
        expect(result).toEqual({
            ok: true,
            value: { snapshots: [{ id: '4f1c2a9b', at: run.startedAt, tag: 'manual' }], runs: [run], running: false },
        })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect(await listBackups(config, client, '../etc', fetchImpl)).toMatchObject({ ok: false, code: 'not-found' })
        expect(calls).toHaveLength(0)
    })

    it('passes on hostd refusing a project without the capability', async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'capability-disabled', message: 'backups is not enabled' }, 403)
        expect(await listBackups(config, client, 'acme-bakery', fetchImpl)).toEqual({
            ok: false, code: 'capability-disabled', message: 'backups is not enabled',
        })
    })
})

describe('startBackup', () => {
    it('posts to the project and answers the run hostd started', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, run: 'feedfacecafebeef' }, 202)
        const result = await startBackup(config, client, 'acme-bakery', fetchImpl)

        expect(calls[0]).toMatchObject({ url: 'http://hostd-api:8080/projects/acme-bakery/backups', method: 'POST' })
        expect(result).toEqual({ ok: true, value: { run: 'feedfacecafebeef' } })
    })
})

describe('deleteBackup', () => {
    it('deletes one copy by its id', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        const result = await deleteBackup(config, client, 'acme-bakery', '4f1c2a9b', fetchImpl)

        expect(calls[0]).toMatchObject({ url: 'http://hostd-api:8080/projects/acme-bakery/backups/4f1c2a9b', method: 'DELETE' })
        expect(result).toEqual({ ok: true, value: null })
    })

    it('never builds a path from something that is not a snapshot id', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        for (const bad of ['schedule', '../runs', '4F1C2A9B', 'abc']) {
            expect(await deleteBackup(config, client, 'acme-bakery', bad, fetchImpl)).toMatchObject({ ok: false, code: 'not-found' })
        }
        expect(calls).toHaveLength(0)
    })
})

describe('the schedule', () => {
    it('reads it', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, schedule })
        expect(await getSchedule(config, client, 'acme-bakery', fetchImpl)).toEqual({ ok: true, value: schedule })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/backups/schedule')
    })

    it('writes it as JSON and hands back what hostd saved, which may be clamped', async () => {
        const clamped = { ...schedule, keep: { daily: 7, weekly: 4, monthly: 1 } }
        const { fetchImpl, calls } = fakeFetch({ ok: true, schedule: clamped })
        const result = await setSchedule(config, client, 'acme-bakery', { ...schedule, keep: { daily: 7, weekly: 4, monthly: 12 } }, fetchImpl)

        expect(calls[0].method).toBe('PUT')
        expect(JSON.parse(calls[0].body as string)).toEqual({ ...schedule, keep: { daily: 7, weekly: 4, monthly: 12 } })
        expect(result).toEqual({ ok: true, value: clamped })
    })
})

describe('openBackupDownload', () => {
    it('opens the archive as a stream', async () => {
        const { fetchImpl, calls } = fakeFetch('archive bytes', 200, { 'content-type': 'application/gzip' })
        const result = await openBackupDownload(config, client, 'acme-bakery', '4f1c2a9b', fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/backups/4f1c2a9b/download')
        expect(result.ok).toBe(true)
        if (result.ok) expect(await result.response.text()).toBe('archive bytes')
    })

    it('refuses a snapshot id before asking', async () => {
        const { fetchImpl, calls } = fakeFetch('')
        expect(await openBackupDownload(config, client, 'acme-bakery', 'nope', fetchImpl)).toMatchObject({ ok: false, code: 'not-found' })
        expect(calls).toHaveLength(0)
    })
})
