// The panel is an async server component, so it is awaited and its result rendered, the same way
// deployPanel.test.tsx does it.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const listBackups = vi.fn()
const getSchedule = vi.fn()
const listRestores = vi.fn()
const accessOf = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/backups', () => ({
    listBackups: (...args: unknown[]) => listBackups(...args),
    getSchedule: (...args: unknown[]) => getSchedule(...args),
    listRestores: (...args: unknown[]) => listRestores(...args),
}))
vi.mock('./actions', () => ({
    backupNowAction: async () => ({ ok: true, message: 'ok' }),
    deleteBackupAction: async () => ({ ok: true, message: 'ok' }),
    saveScheduleAction: async () => ({ ok: true, message: 'ok' }),
    restoreBackupAction: async () => ({ ok: true, message: 'ok', run: 'r1' }),
    restoresAction: async () => ({ ok: true, restores: [], running: false }),
}))
vi.mock('@/server/sites/access', () => ({ accessOf: (...args: unknown[]) => accessOf(...args) }))
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
    listRestores.mockResolvedValue({ ok: true, value: { restores: [], running: false } })
    accessOf.mockResolvedValue(['BACKUPS'])
})

const restore = (over: Record<string, unknown> = {}) => ({
    run: 'abcdef0123456789',
    actor: 'admin',
    startedAt: '2026-10-06T09:00:00.000Z',
    durationMs: 90_000,
    outcome: 'ok',
    step: null,
    reason: null,
    snapshot: '4f1c2a9b',
    safety: '9e8d7c6b',
    ...over,
})

describe('the backups tab, for a client', () => {
    it('lists each copy with who made it, and how to download or delete it', async () => {
        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('made by you')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/sites/asot/backups/4f1c2a9b')
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
        // restic's id is the operator's detail
        expect(screen.queryByText('4f1c2a9b')).not.toBeInTheDocument()
    })

    it('gives a client no Restore, says to ask, and that test is not backed up', async () => {
        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
        // hostd refuses a client the restores, so they are not even asked for
        expect(listRestores).not.toHaveBeenCalled()
        expect(screen.getByText(/Ask Koda/)).toBeInTheDocument()
        expect(screen.getByText(/Only the live site is backed up/)).toBeInTheDocument()
        expect(screen.queryByText(/offsite/)).not.toBeInTheDocument()
    })

    it('turns Back up now off with the reason when five copies made by hand exist', async () => {
        const five = ['a', 'b', 'c', 'd', 'e'].map(letter => ({ id: letter.repeat(8), at: '2026-10-01T00:00:00Z', tag: 'manual' }))
        listBackups.mockResolvedValue(listed({ snapshots: five, runs: [] }))

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
        expect(screen.getByText(/Delete one to make another/)).toBeInTheDocument()
    })

    it('says a failed copy saved nothing, without hostd\'s reason', async () => {
        listBackups.mockResolvedValue(listed({ runs: [run({ outcome: 'failed', snapshot: null, reason: 'pg_dumpall exited 1 in asot-db' })] }))

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The last copy did not work')).toBeInTheDocument()
        expect(screen.queryByText(/pg_dumpall/)).not.toBeInTheDocument()
    })

    it('shows the fixed sentence when the list cannot be read', async () => {
        listBackups.mockResolvedValue({ ok: false, code: 'agent-unavailable', message: '/run/hostd/agent.sock refused' })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The backups could not be read')).toBeInTheDocument()
        expect(screen.queryByText(/agent.sock/)).not.toBeInTheDocument()
    })

    it('says a copy is being made while hostd is running one', async () => {
        listBackups.mockResolvedValue(listed({ running: true }))

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('Making a copy')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    })

    it('keeps the rest of the tab when only the schedule cannot be read', async () => {
        getSchedule.mockResolvedValue({ ok: false, code: 'unavailable', message: 'backup schedules are not configured' })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The schedule could not be read')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled()
    })
})

describe('the backups tab, for a client given Restore backups', () => {
    beforeEach(() => accessOf.mockResolvedValue(['BACKUPS', 'RESTORE_BACKUPS']))

    it('puts a Restore button on each copy and says how it works', async () => {
        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled()
        expect(screen.getByText(/a fresh copy of the live site is made first so it can be undone/)).toBeInTheDocument()
        expect(screen.queryByText(/Ask Koda/)).not.toBeInTheDocument()
        expect(listRestores).toHaveBeenCalledWith(expect.anything(), client.caller, 'asot')
    })

    it('says a failed restore stopped, without hostd\'s reason or restic\'s ids', async () => {
        listRestores.mockResolvedValue({ ok: true, value: {
            restores: [restore({ outcome: 'failed', step: 'load:db', reason: 'psql exited 3 in /var/www/asot' })], running: false,
        } })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The last restore did not work')).toBeInTheDocument()
        expect(screen.getByText(/holds your site as it was/)).toBeInTheDocument()
        expect(screen.queryByText(/psql/)).not.toBeInTheDocument()
        expect(screen.queryByText(/9e8d7c6b/)).not.toBeInTheDocument()
    })
})

describe('the backups tab, for the operator', () => {
    beforeEach(() => callerFromSession.mockResolvedValue(admin))

    it('names restic\'s id and who made each copy', async () => {
        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('4f1c2a9b')).toBeInTheDocument()
        expect(screen.getByText(/made by the client/)).toBeInTheDocument()
    })

    it('gives hostd\'s reason for a failed run, and says the copies are on the dedi alone', async () => {
        listBackups.mockResolvedValue(listed({ runs: [run({ outcome: 'failed', snapshot: null, reason: 'pg_dumpall exited 1' })] }))

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText(/pg_dumpall exited 1/)).toBeInTheDocument()
        expect(screen.getByText(/no offsite copy yet/)).toBeInTheDocument()
    })

    it('puts a Restore button on each copy', async () => {
        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled()
        expect(screen.getByText(/Restore on a copy above does it/)).toBeInTheDocument()
    })

    it('says where a running restore is, and holds the buttons while it runs', async () => {
        listRestores.mockResolvedValue({ ok: true, value: { restores: [restore({ outcome: 'running', step: 'safety', safety: null })], running: true } })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('Restoring')).toBeInTheDocument()
        expect(screen.getByText(/Making a fresh copy of the live site first/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    })

    it('says the last restore worked, naming the safety copy', async () => {
        listRestores.mockResolvedValue({ ok: true, value: { restores: [restore()], running: false } })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The last restore worked')).toBeInTheDocument()
        expect(screen.getByText(/9e8d7c6b/)).toBeInTheDocument()
    })

    it('gives hostd\'s reason and the step when the last restore failed', async () => {
        listRestores.mockResolvedValue({ ok: true, value: {
            restores: [restore({ outcome: 'failed', step: 'load:db', reason: 'psql exited 3' })], running: false,
        } })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('The last restore did not work')).toBeInTheDocument()
        expect(screen.getByText(/Putting the db database back/)).toBeInTheDocument()
        expect(screen.getByText(/psql exited 3/)).toBeInTheDocument()
    })

    it('keeps the copies but offers no Restore when the restores cannot be read', async () => {
        listRestores.mockResolvedValue({ ok: false, code: 'agent-unavailable', message: 'agent.sock refused' })

        render(await BackupPanel({ id: 'asot', name: 'A State of Trance' }))

        expect(screen.getByText('Restores could not be read')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
    })
})
