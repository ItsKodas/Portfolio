import { beforeEach, describe, expect, it, vi } from 'vitest'

// A server action's arguments arrive off the wire, so the only thing these exercise is the runtime shape
// check each action makes of its own before anything else happens. Everything the actions reach for after
// that (the session, the database, hostd) is stood in for, because none of it is reached here.
const callerFromSession = vi.fn()
const writeSettings = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/server/db', () => ({ getDb: () => ({}) }))
vi.mock('@/server/hostd/config', () => ({ readHostd: () => ({ url: 'http://hostd', token: 't' }) }))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/settings', () => ({ writeSettings: (...args: unknown[]) => writeSettings(...args) }))

const { saveSettingsAction } = await import('./actions')

const CANNOT = { ok: false, error: 'That is not something this page can do.' }

beforeEach(() => {
    vi.clearAllMocks()
    // No session, which is the first thing past the shape check: a well-formed object gets this answer
    // and a malformed one never gets that far.
    callerFromSession.mockResolvedValue(null)
})

describe('saveSettingsAction', () => {
    it('refuses a settings argument the page could not have sent, before the session is read', async () => {
        const nonsense = [
            'lifecycle',
            null,
            ['lifecycle'],
            { capabilities: 'lifecycle' },
            { capabilities: [1, 2] },
            { repo: 5 },
            { branches: 'live' },
            { branches: { live: 5 } },
            { branches: ['live'] },
            { capabilities: [], surprise: true },
        ]
        for (const settings of nonsense) {
            expect(await saveSettingsAction('acme', settings as never)).toEqual(CANNOT)
        }
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(writeSettings).not.toHaveBeenCalled()
    })

    it('lets the body the form actually sends through to the gate', async () => {
        const result = await saveSettingsAction('acme', {
            capabilities: ['lifecycle', 'logs'],
            repo: null,
            branches: { live: null },
        })
        expect(result).toEqual({ ok: false, error: 'Your session has expired. Sign in again.' })
        expect(callerFromSession).toHaveBeenCalled()
    })

    it('says nothing was started or stopped', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        writeSettings.mockResolvedValue({ ok: true, data: { ok: true } })

        const result = await saveSettingsAction('acme', { capabilities: ['env'] })

        expect(result.ok).toBe(true)
        expect(result.ok && result.message).toMatch(/nothing was started or stopped/i)
    })
})
