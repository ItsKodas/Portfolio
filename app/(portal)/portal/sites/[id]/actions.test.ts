import { beforeEach, describe, expect, it, vi } from 'vitest'

// A server action's arguments arrive off the wire, so the only thing these exercise is the runtime shape
// check each action makes of its own before anything else happens. Everything the actions reach for after
// that (the session, the database, hostd) is stood in for, because none of it is reached here.
const callerFromSession = vi.fn()
const writeSettings = vi.fn()
const setPort = vi.fn()
const removeProject = vi.fn()
const deleteSites = vi.fn()
const listEnvironments = vi.fn()
const startDeploy = vi.fn()
const writeEnvFile = vi.fn()
const addDomain = vi.fn()
const addEnvironment = vi.fn()
const deleteEnvironment = vi.fn()
const restoreEnvironment = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/server/db', () => ({ getDb: () => ({ site: { deleteMany: (...args: unknown[]) => deleteSites(...args) } }) }))
vi.mock('@/server/hostd/remove', () => ({ removeProject: (...args: unknown[]) => removeProject(...args) }))
vi.mock('@/server/hostd/config', () => ({ readHostd: () => ({ url: 'http://hostd', token: 't' }) }))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/settings', () => ({ writeSettings: (...args: unknown[]) => writeSettings(...args) }))
vi.mock('@/server/hostd/ports', () => ({ setPort: (...args: unknown[]) => setPort(...args) }))
vi.mock('@/server/hostd/projects', () => ({
    assertOwned: async () => true,
    lifecycle: vi.fn(),
    listEnvironments: (...args: unknown[]) => listEnvironments(...args),
}))
vi.mock('@/server/hostd/deploys', () => ({
    startDeploy: (...args: unknown[]) => startDeploy(...args),
    rollback: vi.fn(),
    setBranch: vi.fn(),
}))
vi.mock('@/server/hostd/env', async importOriginal => ({
    ...(await importOriginal<typeof import('@/server/hostd/env')>()),
    writeEnvFile: (...args: unknown[]) => writeEnvFile(...args),
}))
vi.mock('@/server/hostd/domains', () => ({
    addDomain: (...args: unknown[]) => addDomain(...args),
    adoptSite: vi.fn(),
    previewAdopt: vi.fn(),
    removeDomain: vi.fn(),
    verifyDomain: vi.fn(),
}))

vi.mock('@/server/hostd/environments', () => ({
    addEnvironment: (...args: unknown[]) => addEnvironment(...args),
    deleteEnvironment: (...args: unknown[]) => deleteEnvironment(...args),
    restoreEnvironment: (...args: unknown[]) => restoreEnvironment(...args),
}))

const {
    addDomainAction, addEnvironmentAction, deleteEnvironmentAction, restoreEnvironmentAction, changePrimaryDomainAction, deleteSiteAction, deployAction, saveEnvAction, saveSettingsAction,
    setPortAction, setPrimaryDomainAction,
} = await import('./actions')

const ADMIN = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }
const CLIENT = { caller: { actor: 'client:cl_1', user: 'cl_1' }, clientId: 'cl_1' }
const env = (name: string) => ({ name, branch: null, domain: null, certificate: null, deployed: null })

const CANNOT = { ok: false, error: 'That is not something this page can do.' }

beforeEach(() => {
    vi.clearAllMocks()
    // No session, which is the first thing past the shape check: a well-formed object gets this answer
    // and a malformed one never gets that far.
    callerFromSession.mockResolvedValue(null)
    listEnvironments.mockResolvedValue({ ok: true, value: [env('live')] })
})

// An environment is any valid name now, so which ones exist is the site's own list, read from hostd,
// rather than a fixed pair written here.
describe('an action naming an environment', () => {
    it('accepts uat1 when the site has it', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        listEnvironments.mockResolvedValue({ ok: true, value: [env('live'), env('uat1')] })
        startDeploy.mockResolvedValue({ ok: true, value: { environment: 'uat1', trigger: 'manual' } })

        expect((await deployAction('acme', 'uat1')).ok).toBe(true)
        expect(listEnvironments).toHaveBeenCalledWith(expect.anything(), ADMIN.caller, 'acme')
        expect(startDeploy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'uat1')
    })

    it('refuses a well formed name the site does not have, without asking hostd to act', async () => {
        callerFromSession.mockResolvedValue(ADMIN)

        expect(await deployAction('acme', 'uat1')).toEqual({ ok: false, error: 'This site has no uat1 environment.' })
        expect(startDeploy).not.toHaveBeenCalled()
    })

    it('refuses a name that could never be one, before the session is read', async () => {
        for (const name of ['uat-1', 'next', 'Live', '', 5]) {
            expect(await deployAction('acme', name as never)).toEqual(CANNOT)
        }
        expect(callerFromSession).not.toHaveBeenCalled()
    })

    it('says so when the list itself could not be read', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        listEnvironments.mockResolvedValue({ ok: false, code: 'unavailable', message: 'hostd is not answering' })

        const result = await deployAction('acme', 'live')

        expect(result.ok).toBe(false)
        expect(startDeploy).not.toHaveBeenCalled()
    })
})

describe('saveEnvAction', () => {
    it('writes to the environment it was given, not always live', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        listEnvironments.mockResolvedValue({ ok: true, value: [env('live'), env('uat1')] })
        writeEnvFile.mockResolvedValue({ ok: true, value: { output: 'written' } })

        expect((await saveEnvAction('acme', 'uat1', '.env', 'A=1')).ok).toBe(true)
        expect(writeEnvFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'uat1', '.env', 'A=1')
    })

    it('refuses an environment the site does not have', async () => {
        callerFromSession.mockResolvedValue(ADMIN)

        expect(await saveEnvAction('acme', 'uat1', '.env', 'A=1')).toEqual({ ok: false, error: 'This site has no uat1 environment.' })
        expect(writeEnvFile).not.toHaveBeenCalled()
    })

    it('refuses a client outright', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'client' }, clientId: 'cl_1' })

        expect(await saveEnvAction('acme', 'live', '.env', 'A=1')).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(writeEnvFile).not.toHaveBeenCalled()
    })
})

describe('addDomainAction', () => {
    it('adds the hostname to the environment chosen, which need not be the one being viewed', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        listEnvironments.mockResolvedValue({ ok: true, value: [env('live'), env('uat1')] })
        addDomain.mockResolvedValue({ ok: true, value: { ok: true } })

        expect((await addDomainAction('acme', 'uat1', ' UAT.acme.com ')).ok).toBe(true)
        expect(addDomain).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'uat1', 'uat.acme.com')
    })
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
        expect(await setPortAction('acme', 'uat-1', 5013)).toEqual(CANNOT)
        expect(await setPortAction('acme', 'live', 5013.5 as never)).toEqual(CANNOT)
        expect(await setPortAction('acme', 'live', '5013' as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(setPort).not.toHaveBeenCalled()
    })

    it('sends the admin\'s call through to setPort, answering with hostd\'s own output', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        setPort.mockResolvedValue({ ok: true, value: { output: 'acme live now uses port 5013, and its containers were recreated on it' } })

        const result = await setPortAction('acme', 'live', 5013)

        expect(setPort).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'live', 5013)
        expect(result).toEqual({ ok: true, message: 'acme live now uses port 5013, and its containers were recreated on it.' })
    })
})

describe('setPrimaryDomainAction', () => {
    it('refuses an environment or a hostname the page could not have sent, before the session is read', async () => {
        expect(await setPrimaryDomainAction('acme', 'uat-1', 'acme.com')).toEqual(CANNOT)
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
        expect(await changePrimaryDomainAction('acme', 'uat-1', 'acme.com', 'acme.com')).toEqual(CANNOT)
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

describe('deleteSiteAction', () => {
    it('refuses a client outright, without asking hostd', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'client' }, clientId: 'cl_1' })

        expect(await deleteSiteAction('acme', 'Acme')).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(removeProject).not.toHaveBeenCalled()
        expect(deleteSites).not.toHaveBeenCalled()
    })

    it('sends the name as typed, then drops the client link', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        removeProject.mockResolvedValue({ ok: true, value: { ok: true } })
        deleteSites.mockResolvedValue({ count: 1 })

        expect(await deleteSiteAction('acme', 'Acme')).toEqual({ ok: true, message: 'Deleted.' })
        expect(removeProject).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', 'Acme')
        expect(deleteSites).toHaveBeenCalledWith({ where: { projectId: 'acme' } })
    })

    // A refusal leaves the site in hostd, so its client link has to stay too.
    it('keeps the client link when hostd refuses', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        removeProject.mockResolvedValue({ ok: false, code: 'bad-request', message: 'name must match the project name to confirm deletion' })

        const result = await deleteSiteAction('acme', 'acme')

        expect(result.ok).toBe(false)
        expect(deleteSites).not.toHaveBeenCalled()
    })

    it('still says deleted when only the unlink failed', async () => {
        callerFromSession.mockResolvedValue({ caller: { kind: 'admin' }, clientId: null })
        removeProject.mockResolvedValue({ ok: true, value: { ok: true } })
        deleteSites.mockRejectedValue(new Error('connection lost'))

        const result = await deleteSiteAction('acme', 'Acme')

        expect(result.ok).toBe(true)
        expect(result.ok && result.message).toMatch(/still linked/)
    })
})

describe('addEnvironmentAction', () => {
    it('sends the name, the branch and a trimmed, lowercased hostname', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        addEnvironment.mockResolvedValue({ ok: true, value: {} })

        const result = await addEnvironmentAction('acme', 'uat1', 'uat', '  UAT.acme.com ')

        expect(result).toEqual({ ok: true, message: 'uat1 is added. Its first deploy starts it.' })
        expect(addEnvironment).toHaveBeenCalledWith(expect.anything(), ADMIN.caller, 'acme', { name: 'uat1', branch: 'uat', domain: 'uat.acme.com' })
    })

    it('sends a blank hostname as none', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        addEnvironment.mockResolvedValue({ ok: true, value: {} })

        await addEnvironmentAction('acme', 'uat1', 'uat', '  ')

        expect(addEnvironment).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'acme', { name: 'uat1', branch: 'uat', domain: null })
    })

    it('says the environment exists when only its address could not be set up', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        addEnvironment.mockResolvedValue({ ok: true, value: { vhost: { ok: false, message: 'Apache refused it' } } })

        const result = await addEnvironmentAction('acme', 'uat1', 'uat', 'uat.acme.com')

        expect(result.ok).toBe(true)
        expect(result.ok && result.message).toMatch(/uat1 is added.*Apache refused it.*Domains tab/)
    })

    it('refuses live, a reserved name or a hyphen with the reason, before the session is read', async () => {
        expect(await addEnvironmentAction('acme', 'live', 'uat', null)).toEqual({ ok: false, error: 'Every site has live already.' })
        expect(await addEnvironmentAction('acme', 'next', 'uat', null)).toEqual({ ok: false, error: 'next is reserved. Choose another name.' })
        expect((await addEnvironmentAction('acme', 'uat-1', 'uat', null)).ok).toBe(false)
        expect(await addEnvironmentAction('acme', 'uat1', '', null)).toEqual(CANNOT)
        expect(await addEnvironmentAction('acme', 'uat1', 'uat', 5 as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
    })

    it('refuses a client outright', async () => {
        callerFromSession.mockResolvedValue(CLIENT)

        expect(await addEnvironmentAction('acme', 'uat1', 'uat', null)).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(addEnvironment).not.toHaveBeenCalled()
    })

    it('shows hostd\'s refusal to the operator', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        addEnvironment.mockResolvedValue({ ok: false, code: 'conflict', message: 'uat1 was deleted on 2026-09-20; restore it or wait for it to be purged' })

        const result = await addEnvironmentAction('acme', 'uat1', 'uat', null)

        expect(result.ok).toBe(false)
        expect(!result.ok && result.error).toMatch(/restore it or wait/)
    })
})

describe('deleteEnvironmentAction', () => {
    it('sends the site name as typed, for an environment the site has', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        listEnvironments.mockResolvedValue({ ok: true, value: [env('live'), env('uat1')] })
        deleteEnvironment.mockResolvedValue({ ok: true, value: {} })

        const result = await deleteEnvironmentAction('acme', 'uat1', 'Acme Bakery')

        expect(deleteEnvironment).toHaveBeenCalledWith(expect.anything(), ADMIN.caller, 'acme', 'uat1', 'Acme Bakery')
        expect(result.ok && result.message).toMatch(/kept for 30 days/)
    })

    it('never deletes live, whatever is sent', async () => {
        expect(await deleteEnvironmentAction('acme', 'live', 'Acme Bakery')).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
    })

    it('refuses an environment the site does not have', async () => {
        callerFromSession.mockResolvedValue(ADMIN)

        expect(await deleteEnvironmentAction('acme', 'uat1', 'Acme Bakery')).toEqual({ ok: false, error: 'This site has no uat1 environment.' })
        expect(deleteEnvironment).not.toHaveBeenCalled()
    })

    it('refuses a client outright', async () => {
        callerFromSession.mockResolvedValue(CLIENT)

        expect(await deleteEnvironmentAction('acme', 'uat1', 'Acme Bakery')).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(deleteEnvironment).not.toHaveBeenCalled()
    })
})

describe('restoreEnvironmentAction', () => {
    it('says it is back, and nothing more, when nothing changed on the way', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        restoreEnvironment.mockResolvedValue({ ok: true, value: { port: 5014, portChanged: false, droppedHostnames: [] } })

        const result = await restoreEnvironmentAction('acme', 'uat1', '2026-09-20T10:00:00.000Z')

        expect(restoreEnvironment).toHaveBeenCalledWith(expect.anything(), ADMIN.caller, 'acme', 'uat1', '2026-09-20T10:00:00.000Z')
        expect(result).toEqual({ ok: true, message: 'uat1 is back and starting.' })
    })

    it('names a new port and every hostname it came back without', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        restoreEnvironment.mockResolvedValue({ ok: true, value: { port: 5019, portChanged: true, droppedHostnames: ['uat.acme.com', 'beta.acme.com'] } })

        const result = await restoreEnvironmentAction('acme', 'uat1', '2026-09-20T10:00:00.000Z')

        expect(result).toEqual({
            ok: true,
            message: 'uat1 is back and starting. Its old port was taken, so it is on port 5019 now. '
                + 'These hostnames were taken while it was deleted, so it came back without them: uat.acme.com, beta.acme.com.',
        })
    })

    it('says the port changed without naming one hostd did not send', async () => {
        callerFromSession.mockResolvedValue(ADMIN)
        restoreEnvironment.mockResolvedValue({ ok: true, value: { port: null, portChanged: true, droppedHostnames: [] } })

        expect(await restoreEnvironmentAction('acme', 'uat1', '2026-09-20T10:00:00.000Z'))
            .toEqual({ ok: true, message: 'uat1 is back and starting. Its old port was taken, so it is on another port now.' })
    })

    it('never restores live, and wants to know which deletion', async () => {
        expect(await restoreEnvironmentAction('acme', 'live', '2026-09-20T10:00:00.000Z')).toEqual(CANNOT)
        expect(await restoreEnvironmentAction('acme', 'uat1', 5 as never)).toEqual(CANNOT)
        expect(callerFromSession).not.toHaveBeenCalled()
    })

    it('refuses a client outright', async () => {
        callerFromSession.mockResolvedValue(CLIENT)

        expect(await restoreEnvironmentAction('acme', 'uat1', '2026-09-20T10:00:00.000Z')).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(restoreEnvironment).not.toHaveBeenCalled()
    })
})
