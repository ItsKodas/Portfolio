import { beforeEach, describe, expect, it, vi } from 'vitest'

// Everything past the form's own rules is stood in for: the session, the client list, and hostd.
const callerFromSession = vi.fn()
const createProject = vi.fn()
const startDeploy = vi.fn()
const listCredentials = vi.fn()
const clients = { byId: vi.fn(), createSite: vi.fn(), list: vi.fn() }

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/server/clients/wiring', () => ({ repo: () => clients }))
vi.mock('@/server/hostd/config', () => ({ readHostd: () => ({ url: 'http://hostd', token: 't' }) }))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/create', () => ({ createProject: (...args: unknown[]) => createProject(...args) }))
vi.mock('@/server/hostd/deploys', () => ({ startDeploy: (...args: unknown[]) => startDeploy(...args) }))
vi.mock('@/server/hostd/credentials', () => ({ listCredentials: (...args: unknown[]) => listCredentials(...args) }))

const { createSiteAction, newSiteOptionsAction } = await import('./actions')

const ADMIN = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }
const FORM = {
    name: 'Bakery', id: 'bakery', dir: 'bakery', client: '', repo: 'git@github.com:ItsKodas/bakery.git', credential: '',
    branch: 'main', compose: ['docker-compose.yml'], capabilities: ['lifecycle', 'deploy'],
    websockets: false, flexibleSsl: true, domain: 'Bakery.com', certificate: 'letsencrypt', deploy: false,
    port: '5012',
}

beforeEach(() => {
    vi.clearAllMocks()
    callerFromSession.mockResolvedValue(ADMIN)
    createProject.mockResolvedValue({ ok: true, value: { vhost: { ok: true } } })
    startDeploy.mockResolvedValue({ ok: true, value: {} })
    clients.byId.mockResolvedValue({ id: 'cl_2' })
})

describe('createSiteAction', () => {
    it('refuses what the form would not send, before the session is read', async () => {
        for (const input of [null, 'bakery', { ...FORM, id: '../x' }, { ...FORM, compose: [] }, { ...FORM, compose: ['../x.yml'] }, { ...FORM, capabilities: ['root'] }]) {
            expect((await createSiteAction(input)).ok).toBe(false)
        }
        expect(callerFromSession).not.toHaveBeenCalled()
        expect(createProject).not.toHaveBeenCalled()
    })

    it('refuses a client, with the same answer the site page gives', async () => {
        callerFromSession.mockResolvedValue({ caller: { actor: 'client:cl_2', user: 'cl_2' }, clientId: 'cl_2' })
        expect(await createSiteAction(FORM)).toEqual({ ok: false, error: 'This is not set up yet.' })
        expect(createProject).not.toHaveBeenCalled()
    })

    it('creates a site of the operator\'s own without a client, credential or link', async () => {
        expect(await createSiteAction(FORM)).toEqual({ ok: true, id: 'bakery', warnings: [] })
        expect(createProject.mock.calls[0][2]).toEqual({
            id: 'bakery', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git', branch: 'main',
            domain: 'bakery.com', certificate: 'letsencrypt', dir: 'bakery', compose: ['docker-compose.yml'],
            capabilities: ['lifecycle', 'deploy'], websockets: false, flexibleSsl: true, port: 5012,
        })
        expect(clients.createSite).not.toHaveBeenCalled()
        expect(startDeploy).not.toHaveBeenCalled()
    })

    it('sends no certificate without a domain', async () => {
        await createSiteAction({ ...FORM, domain: '' })
        expect(createProject.mock.calls[0][2]).toMatchObject({ domain: null, certificate: null })
    })

    it('links the site to the client it was created for, after hostd created it', async () => {
        await createSiteAction({ ...FORM, client: 'cl_2', credential: 'acme' })
        expect(createProject.mock.calls[0][2]).toMatchObject({ client: 'cl_2', credential: 'acme' })
        expect(clients.createSite).toHaveBeenCalledWith('cl_2', { projectId: 'bakery', name: 'Bakery' })
    })

    it('refuses a client that no longer exists without asking hostd', async () => {
        clients.byId.mockResolvedValue(null)
        expect((await createSiteAction({ ...FORM, client: 'cl_gone' })).ok).toBe(false)
        expect(createProject).not.toHaveBeenCalled()
    })

    it('writes nothing to the database when hostd refuses', async () => {
        createProject.mockResolvedValue({ ok: false, code: 'bad-request', message: '/var/www/bakery already exists' })
        const result = await createSiteAction({ ...FORM, client: 'cl_2', deploy: true })
        expect(result.ok).toBe(false)
        expect(!result.ok && result.error).toMatch(/already exists/)
        expect(clients.createSite).not.toHaveBeenCalled()
        expect(startDeploy).not.toHaveBeenCalled()
    })

    it('deploys live only when asked, and reports what did not happen as warnings on a site that exists', async () => {
        createProject.mockResolvedValue({ ok: true, value: { vhost: { ok: false, message: 'bakery.com is already served by x.conf.' } } })
        startDeploy.mockResolvedValue({ ok: false, code: 'busy', message: 'a deploy is already running' })
        clients.createSite.mockRejectedValue(new Error('Site_projectId_key'))

        const result = await createSiteAction({ ...FORM, client: 'cl_2', deploy: true })

        expect(startDeploy.mock.calls[0].slice(2)).toEqual(['bakery', 'live'])
        expect(result.ok).toBe(true)
        expect(result.ok && result.warnings).toHaveLength(3)
    })

    it('does not ask for a deploy the site has no feature for', async () => {
        const result = await createSiteAction({ ...FORM, capabilities: ['lifecycle'], deploy: true })
        expect(startDeploy).not.toHaveBeenCalled()
        expect(result.ok && result.warnings[0]).toMatch(/deploy feature is off/)
    })
})

describe('newSiteOptionsAction', () => {
    it('offers the clients by name and the host\'s accounts', async () => {
        clients.list.mockResolvedValue([{ id: 'cl_2', name: 'Zed', company: null }, { id: 'cl_1', name: 'Amy', company: 'Acme' }])
        listCredentials.mockResolvedValue({ ok: true, value: ['acme'] })
        expect(await newSiteOptionsAction()).toEqual({
            ok: true,
            clients: [{ id: 'cl_1', name: 'Amy (Acme)' }, { id: 'cl_2', name: 'Zed' }],
            credentials: ['acme'],
            credentialsError: null,
        })
    })

    it('refuses anyone but the operator', async () => {
        callerFromSession.mockResolvedValue(null)
        expect((await newSiteOptionsAction()).ok).toBe(false)
        expect(clients.list).not.toHaveBeenCalled()
    })
})
