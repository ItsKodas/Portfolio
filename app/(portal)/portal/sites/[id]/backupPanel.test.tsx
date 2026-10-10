// The panel is an async server component, so it is awaited and its result rendered, the same way
// deployPanel.test.tsx does it.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const listBackups = vi.fn()
const getSchedule = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/backups', () => ({
    listBackups: (...args: unknown[]) => listBackups(...args),
    getSchedule: (...args: unknown[]) => getSchedule(...args),
}))
vi.mock('./actions', () => ({
    backupNowAction: async () => ({ ok: true, message: 'ok' }),
    deleteBackupAction: async () => ({ ok: true, message: 'ok' }),
    saveScheduleAction: async () => ({ ok: true, message: 'ok' }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

const { BackupPanel } = await import('./backupPanel')

const admin = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }
const client = { caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }

const run = (over: Record<string, unknown> = {}) => ({
    run: '0123456789abcdef',
    tag: 'manual',
    actor: 'client',
    startedAt: '2026-10-05T06:00:00.000Z',
    durationMs: 42_000,
    outcome: 'ok',
    snapshot: '4f1c2a9be7d0aa11',
    reason: null,
    disruptive: false,
    ...over,
})

const listed = (over: Record<string, unknown> = {}) => ({
    ok: true,
    value: {
        snapshots: [{ id: '4f1c2a9b', at: '2026-10-05T06:00:42.000Z', tag: 'manual' }],
        runs: [run()],
        running: false,
        ...over,
    },
})

const schedule = { mode: 'daily', hour: 2, minute: 0, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } }

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue(client)
    listBackups.mockResolvedValue(listed())
    getSchedule.mockResolvedValue({ ok: true, value: schedule })
})

describe('the backups tab, for a client', () => {
    it('lists each copy with who made it, and how to download or delete it', async () => {
        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('made by you')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/sites/asot/backups/4f1c2a9b')
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
        // restic's id is the operator's detail
        expect(screen.queryByText('4f1c2a9b')).not.toBeInTheDocument()
    })

    it('says why there is no restore button, and that test is not backed up', async () => {
        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText(/There is no button for this, on purpose/)).toBeInTheDocument()
        expect(screen.getByText(/Ask Koda/)).toBeInTheDocument()
        expect(screen.getByText(/Only the live site is backed up/)).toBeInTheDocument()
        expect(screen.queryByText(/offsite/)).not.toBeInTheDocument()
    })

    it('turns Back up now off with the reason when five copies made by hand exist', async () => {
        const five = ['a', 'b', 'c', 'd', 'e'].map(letter => ({ id: letter.repeat(8), at: '2026-10-01T00:00:00Z', tag: 'manual' }))
        listBackups.mockResolvedValue(listed({ snapshots: five, runs: [] }))

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
        expect(screen.getByText(/Delete one to make another/)).toBeInTheDocument()
    })

    it('says a failed copy saved nothing, without hostd\'s reason', async () => {
        listBackups.mockResolvedValue(listed({ runs: [run({ outcome: 'failed', snapshot: null, reason: 'pg_dumpall exited 1 in asot-db' })] }))

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('The last copy did not work')).toBeInTheDocument()
        expect(screen.queryByText(/pg_dumpall/)).not.toBeInTheDocument()
    })

    it('shows the fixed sentence when the list cannot be read', async () => {
        listBackups.mockResolvedValue({ ok: false, code: 'agent-unavailable', message: '/run/hostd/agent.sock refused' })

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('The backups could not be read')).toBeInTheDocument()
        expect(screen.queryByText(/agent.sock/)).not.toBeInTheDocument()
    })

    it('says a copy is being made while hostd is running one', async () => {
        listBackups.mockResolvedValue(listed({ running: true }))

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('Making a copy')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    })

    it('keeps the rest of the tab when only the schedule cannot be read', async () => {
        getSchedule.mockResolvedValue({ ok: false, code: 'unavailable', message: 'backup schedules are not configured' })

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('The schedule could not be read')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled()
    })
})

describe('the backups tab, for the operator', () => {
    beforeEach(() => callerFromSession.mockResolvedValue(admin))

    it('names restic\'s id and who made each copy', async () => {
        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText('4f1c2a9b')).toBeInTheDocument()
        expect(screen.getByText(/made by the client/)).toBeInTheDocument()
    })

    it('gives hostd\'s reason for a failed run, and says the copies are on the dedi alone', async () => {
        listBackups.mockResolvedValue(listed({ runs: [run({ outcome: 'failed', snapshot: null, reason: 'pg_dumpall exited 1' })] }))

        render(await BackupPanel({ id: 'asot' }))

        expect(screen.getByText(/pg_dumpall exited 1/)).toBeInTheDocument()
        expect(screen.getByText(/no offsite copy yet/)).toBeInTheDocument()
    })
})
