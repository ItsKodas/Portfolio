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

const { saveSettingsAction, setPrimaryDomainAction } = await import('./actions')

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

// Setting the site's address goes through configure rather than the domains verb, because it edits the
// registry entry rather than writing a vhost, so it reaches hostd through writeSettings like the
// Settings form does.
describe('setPrimaryDomainAction', () => {
    it('refuses an environment or a hostname the page could not have sent, before the session is read', async () => {
        expect(await setPrimaryDomainAction('acme', 'staging', 'acme.com')).toEqual(CANNOT)
        expect(await setPrimaryDomainAction('acme', 'live', 5 as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(writeSettings).not.toHaveBeenCalled()
    })

    // The grammar hostd checks this against has no capital letters in it, and a pasted hostname often
    // does, so the same lowercasing the domain actions do happens here.
    it('sends the trimmed, lowercased hostname as that environment\'s domain', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        writeSettings.mockResolvedValue({ ok: true, data: { ok: true } })

        const result = await setPrimaryDomainAction('acme', 'live', '  ACME.com  ')

        expect(result.ok).toBe(true)
        expect(writeSettings).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), 'acme', { domains: { live: 'acme.com' } },
        )
    })

    // Recording the address writes no vhost: the hand-written file still serving the site is displaced
    // by adopting it, and an operator who is not told that will wonder why nothing changed.
    it('says nothing is served from the address until the environment is adopted', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        writeSettings.mockResolvedValue({ ok: true, data: { ok: true } })

        const result = await setPrimaryDomainAction('acme', 'live', 'acme.com')

        expect(result.ok && result.message).toMatch(/adopted/i)
    })

    // This pane is admin-only: hostd puts configure among its admin-only policy verbs ahead of
    // ownership, and this is the same rule a step earlier.
    it('refuses a client outright', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'client' }, clientId: 'cl_1' })

        expect(await setPrimaryDomainAction('acme', 'live', 'acme.com')).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(writeSettings).not.toHaveBeenCalled()
    })
})
