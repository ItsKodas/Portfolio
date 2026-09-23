import { beforeEach, describe, expect, it, vi } from 'vitest'

// A server action's arguments arrive off the wire, so the only thing these exercise is the runtime shape
// check each action makes of its own before anything else happens. Everything the actions reach for after
// that (the session, the database, hostd) is stood in for, because none of it is reached here.
const callerFromSession = vi.fn()
const writeSettings = vi.fn()
const setPort = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/server/db', () => ({ getDb: () => ({}) }))
vi.mock('@/server/hostd/config', () => ({ readHostd: () => ({ url: 'http://hostd', token: 't' }) }))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/settings', () => ({ writeSettings: (...args: unknown[]) => writeSettings(...args) }))
vi.mock('@/server/hostd/ports', () => ({ setPort: (...args: unknown[]) => setPort(...args) }))

const { changePrimaryDomainAction, saveSettingsAction, setPortAction, setPrimaryDomainAction } = await import('./actions')

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
            { websockets: true },
            { websockets: { live: 'on' } },
            { websockets: ['live'] },
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
            websockets: { live: true },
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
describe('setPortAction', () => {
    it('refuses a client outright, without calling hostd', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'client' }, clientId: 'cl_1' })

        expect(await setPortAction('acme', 'live', 5013)).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(setPort).not.toHaveBeenCalled()
    })

    it('refuses an environment or a port the page could not have sent, before the session is read', async () => {
        expect(await setPortAction('acme', 'staging', 5013)).toEqual(CANNOT)
        expect(await setPortAction('acme', 'live', 5013.5 as never)).toEqual(CANNOT)
        expect(await setPortAction('acme', 'live', '5013' as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(setPort).not.toHaveBeenCalled()
    })

    it('sends the admin\'s call through to setPort, answering with hostd\'s own output', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        setPort.mockResolvedValue({ ok: true, value: { output: 'containers recreated' } })

        const result = await setPortAction('acme', 'live', 5013)

        expect(setPort).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'live', 5013)
        expect(result).toEqual({ ok: true, message: 'live now uses port 5013. containers recreated.' })
    })
})

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

// Moving an address that already exists is the same request behind a confirmation, and the confirmation
// is checked here rather than only in the dialog: a server action is a request like any other, so a
// disabled button proves nothing about what actually arrived.
describe('changePrimaryDomainAction', () => {
    it('refuses an environment, a hostname or a confirmation the page could not have sent', async () => {
        expect(await changePrimaryDomainAction('acme', 'staging', 'acme.com', 'acme.com')).toEqual(CANNOT)
        expect(await changePrimaryDomainAction('acme', 'live', 5 as never, 'acme.com')).toEqual(CANNOT)
        expect(await changePrimaryDomainAction('acme', 'live', 'acme.com', 5 as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(writeSettings).not.toHaveBeenCalled()
    })

    it('refuses a confirmation that is not the new hostname, without asking hostd', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })

        const result = await changePrimaryDomainAction('acme', 'live', 'shop.acme.com', 'shop.acme.co')

        expect(result).toEqual({ ok: false, error: 'Type the new address back exactly to confirm the change.' })
        expect(writeSettings).not.toHaveBeenCalled()
    })

    it('sends the trimmed, lowercased hostname once it has been named back', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        writeSettings.mockResolvedValue({ ok: true, data: { ok: true } })

        const result = await changePrimaryDomainAction('acme', 'live', '  SHOP.acme.com ', 'shop.acme.com')

        expect(result.ok).toBe(true)
        expect(writeSettings).toHaveBeenCalledWith(
            expect.anything(), expect.anything(), 'acme', { domains: { live: 'shop.acme.com' } },
        )
    })

    it('refuses a client outright, exactly as setting a first address does', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'client' }, clientId: 'cl_1' })

        expect(await changePrimaryDomainAction('acme', 'live', 'acme.com', 'acme.com'))
            .toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(writeSettings).not.toHaveBeenCalled()
    })
})
