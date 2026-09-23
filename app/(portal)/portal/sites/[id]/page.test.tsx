// gatherSite is tested on its own. This renders the real page component over the real ui/ components,
// because a page that throws at request time passes every one of those tests.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listProjects = vi.fn()
const listDeploys = vi.fn()
const listDomains = vi.fn()
const getProject = vi.fn()
const assertOwned = vi.fn()
const callerFromSession = vi.fn()

vi.mock('next/navigation', () => ({
    // Both of these work by throwing in Next. Throwing something recognisable here is what lets a test
    // compare two outcomes rather than two rendered pages.
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) },
    useRouter: () => ({ push: () => {}, refresh: () => {} }),
    usePathname: () => '/portal/sites/asot',
}))
vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/projects', () => ({
    listProjects: (...args: unknown[]) => listProjects(...args),
    getProject: (...args: unknown[]) => getProject(...args),
    assertOwned: (...args: unknown[]) => assertOwned(...args),
}))
vi.mock('@/server/db', () => ({ getDb: () => ({ site: { findUnique: async () => null } }) }))
// The server action is a round trip this page never makes while rendering, and importing it for real
// would drag Prisma and next/cache into a jsdom test for nothing.
vi.mock('./actions', () => ({
    lifecycleAction: async () => ({ ok: true, message: 'ok' }),
    deployAction: async () => ({ ok: true, message: 'ok' }),
    rollbackAction: async () => ({ ok: true, message: 'ok' }),
    setBranchAction: async () => ({ ok: true, message: 'ok' }),
    addDomainAction: async () => ({ ok: true, message: 'ok' }),
    removeDomainAction: async () => ({ ok: true, message: 'ok' }),
    verifyDomainAction: async () => ({ ok: true, message: 'ok' }),
    adoptAction: async () => ({ ok: true, message: 'ok' }),
    adoptPreviewAction: async () => ({ ok: false, error: 'not asked in a test' }),
}))
vi.mock('@/server/hostd/deploys', () => ({ listDeploys: (...args: unknown[]) => listDeploys(...args) }))
vi.mock('@/server/hostd/domains', () => ({ listDomains: (...args: unknown[]) => listDomains(...args) }))
const listBranches = vi.fn()
vi.mock('@/server/hostd/branches', () => ({ listBranches: (...args: unknown[]) => listBranches(...args) }))
const listCredentials = vi.fn()
vi.mock('@/server/hostd/credentials', () => ({ listCredentials: (...args: unknown[]) => listCredentials(...args) }))

const { default: SitePage } = await import('./page')

const service = (state: string) => ({
    service: 'asot-web', role: 'site' as const, state,
    health: null, startedAt: null, restartCount: null, image: null,
})

const page = (search: Record<string, string> = {}) =>
    SitePage({ params: Promise.resolve({ id: 'asot' }), searchParams: Promise.resolve(search) })

const client = { caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }

async function thrownBy(run: () => Promise<unknown>): Promise<string> {
    try {
        await run()
    } catch (error) {
        return (error as Error).message
    }
    return 'nothing was thrown'
}

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null })
    listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'logs'] }] })
    getProject.mockResolvedValue({ ok: true, value: [service('running')] })
    listDomains.mockResolvedValue({ ok: true, value: [] })
    assertOwned.mockResolvedValue(true)
    listBranches.mockResolvedValue({ ok: true, value: [] })
    listCredentials.mockResolvedValue({ ok: true, value: [] })
})

describe('the site page', () => {
    it('shows the site, its containers and its tabs', async () => {
        render(await page())

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ASOT')
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')

        // The container is named twice on the Overview, and they are two different things: the bar
        // beside the log says what the site is made of, and the toggle says whose log is being read.
        const bar = within(screen.getByRole('complementary'))
        expect(bar.getByText('asot-web')).toBeInTheDocument()
        expect(bar.getByText('running')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'asot-web' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('draws itself when the containers could not be read, rather than throwing', async () => {
        getProject.mockResolvedValue({ ok: false, code: 'agent-unavailable', message: 'the agent is not answering' })

        render(await page())

        expect(screen.getByRole('alert')).toHaveTextContent(/not answering/i)
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ASOT')
    })

    // The one thing on this page that must not be got wrong. "No such site" to a client asking about
    // somebody else's project confirms it does not exist; "not yours" confirms it does.
    it('answers a site that is not yours exactly as it answers one that is not there', async () => {
        callerFromSession.mockResolvedValue(client)
        assertOwned.mockResolvedValue(false)
        const notYours = await thrownBy(page)

        vi.clearAllMocks()
        callerFromSession.mockResolvedValue({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null })
        listProjects.mockResolvedValue({ ok: true, value: [] })
        const notThere = await thrownBy(page)

        expect(notYours).toBe('NEXT_NOT_FOUND')
        expect(notThere).toBe(notYours)
    })

    it('never asks hostd about a project the client does not own', async () => {
        callerFromSession.mockResolvedValue(client)
        assertOwned.mockResolvedValue(false)

        await thrownBy(page)

        expect(listProjects).not.toHaveBeenCalled()
        expect(getProject).not.toHaveBeenCalled()
    })

    it('sends a stranger to sign in', async () => {
        callerFromSession.mockResolvedValue(null)
        expect(await thrownBy(page)).toBe('NEXT_REDIRECT:/portal/sign-in')
    })

    it('gives a client no Environment tab, because hostd refuses them env outright', async () => {
        callerFromSession.mockResolvedValue(client)

        render(await page())

        expect(screen.queryByRole('tab', { name: 'Environment' })).toBeNull()
    })

    // Otherwise a client could reach a panel by typing its name into the address bar, which is the kind
    // of gate that only works until somebody tries the obvious thing.
    it('lands a client asking for the Environment tab on Overview', async () => {
        callerFromSession.mockResolvedValue(client)

        render(await page({ tab: 'env' }))

        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    })

    it('shows the tabs hostd cannot serve yet, marked but still reachable', async () => {
        render(await page())

        for (const name of ['Deploys', 'Backups', 'Domains']) {
            const tab = screen.getByRole('tab', { name })
            expect(tab).toHaveAttribute('aria-disabled', 'true')
            expect(tab).not.toHaveAttribute('disabled')
        }
    })

    it('explains one of them rather than showing an empty panel', async () => {
        render(await page({ tab: 'backups' }))

        expect(screen.getByRole('tab', { name: 'Backups' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByText(/ask for a copy/)).toBeInTheDocument()
    })

    it('says a restart count it could not read is not available, rather than zero', async () => {
        render(await page())

        expect(screen.getByText('not available')).toBeInTheDocument()
    })

    // The listing here carries no status at all, which is what a list fetched without status=1 answers,
    // and what an older hostd answers whatever it is asked. The page asked about this one project
    // separately and was told it is running, so its own row in the list says so.
    it('draws the open site from the reading it took of that site', async () => {
        render(await page())

        expect(screen.getByRole('link', { name: /ASOT/ })).toHaveTextContent('up')
    })

    // A listing with no status field is what a hostd older than that flag answers. Every other site in
    // the nav read as unknown, and the only way to see what one was doing was to open it.
    it('asks about the other sites on their own when the listing said nothing about them', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [
            { id: 'asot', name: 'ASOT', valid: true, capabilities: [] },
            { id: 'pmpc-group', name: 'PMPC Group', valid: true, capabilities: [] },
        ] })

        render(await page())

        expect(screen.getByRole('link', { name: /PMPC Group/ })).toHaveTextContent('up')
        // Once for the site being looked at, once for the other one, and no more: the reading this page
        // already took stands in for its own project rather than being asked for twice.
        expect(getProject.mock.calls.map(call => call[2])).toEqual(['asot', 'pmpc-group'])
    })

    it('says of a site it still could not read that it could not read it', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [
            { id: 'asot', name: 'ASOT', valid: true, capabilities: [] },
            { id: 'pmpc-group', name: 'PMPC Group', valid: true, capabilities: [] },
        ] })
        getProject.mockImplementation(async (_config: unknown, _caller: unknown, id: string) =>
            id === 'asot'
                ? { ok: true, value: [service('running')] }
                : { ok: false, code: 'failed', message: 'the Docker API could not be read' })

        render(await page())

        expect(screen.getByRole('link', { name: /PMPC Group/ })).toHaveTextContent('unknown')
    })

    it('counts no services and no restarts when the containers could not be read', async () => {
        getProject.mockResolvedValue({ ok: false, code: 'failed', message: 'the Docker API could not be read' })

        render(await page())

        // state, and then the two figures it has no reading for
        expect(screen.getByRole('link', { name: /ASOT/ })).toHaveTextContent('unknown')
        expect(screen.getAllByText('not available')).toHaveLength(2)
    })
})

describe('the settings tab', () => {
    it('gives the operator a Settings tab', async () => {
        render(await page())
        expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
    })

    it('gives a client none, because what their site is allowed to do is not theirs to see', async () => {
        callerFromSession.mockResolvedValue(client)
        render(await page())
        expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull()
    })

    it('lands a client asking for it on Overview', async () => {
        callerFromSession.mockResolvedValue(client)
        render(await page({ tab: 'settings' }))
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    })

    it('shows the form with the entry as it stands', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [
            { id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle'], repo: 'git@github.com:ItsKodas/asot.git', environments: [{ name: 'live', branch: null }] },
        ] })
        render(await page({ tab: 'settings' }))
        expect(screen.getByLabelText(/repo/i)).toHaveValue('git@github.com:ItsKodas/asot.git')
    })

    // configure runs the same checkStructure every verb does, so hostd would refuse it the same way
    it('offers no form for an entry the registry could not parse', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', valid: false, reason: 'dir must be /var/www/<one segment>', environments: [] }] })
        render(await page({ tab: 'settings' }))
        expect(screen.getByText(/dir must be/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    })

    // Rendering the form here would show eight unticked capability boxes over a site that may have every
    // one of them on: nothing about the project is actually known when hostd could not be reached.
    it('offers no form, only hostd\'s own trouble, when hostd could not be reached at all', async () => {
        delete process.env.HOSTD_URL
        render(await page({ tab: 'settings' }))
        const panel = within(screen.getByRole('tabpanel'))
        expect(panel.getByText(/HOSTD_URL/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
        expect(screen.queryByLabelText(/repo/i)).toBeNull()
    })

    it('reads the branch list for this project when the Settings tab renders', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [
            { id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle'], environments: [{ name: 'live', branch: null }] },
        ] })
        listBranches.mockResolvedValue({ ok: true, value: ['main', 'develop'] })
        render(await page({ tab: 'settings' }))
        expect(listBranches.mock.calls[0]?.[2]).toBe('asot')
        const branch = screen.getByLabelText(/branch/i)
        expect(branch.tagName).toBe('SELECT')
        const optionValues = Array.from(branch.querySelectorAll('option')).map(o => o.getAttribute('value'))
        expect(optionValues).toEqual(expect.arrayContaining(['main', 'develop']))
    })

    it('never asks for the branch list on a tab other than Settings', async () => {
        render(await page())
        expect(listBranches).not.toHaveBeenCalled()
    })

    // Failure is not an error: the field stays a plain input and a line underneath says why, in hostd's
    // own words. A save must never be blocked by a list that did not load, so the form still renders.
    it('still renders the form, with the field degraded to plain text, when the branch list could not be read', async () => {
        listBranches.mockResolvedValue({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
        render(await page({ tab: 'settings' }))
        expect(screen.getByText(/hostd is not answering/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
        expect(document.querySelector('datalist')).toBeNull()
    })
})

describe('the environment tab', () => {
    it('disables the Environment tab until the capability is on, and says where it is turned on', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle'], environments: [] }] })
        render(await page({ tab: 'env' }))
        expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByText(/Settings tab/)).toBeInTheDocument()
    })

    it('enables it once it is', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'env'], environments: [] }] })
        render(await page())
        expect(screen.getByRole('tab', { name: 'Environment' })).not.toHaveAttribute('aria-disabled')
    })
})

describe('the deploys tab', () => {
    it('stays disabled, and says why, for a site hostd has no deploys for', async () => {
        // The default listing above carries no deploy capability, so hostd would refuse every call the
        // panel makes, the history included. A tab that opens onto a refusal is worse than a marked one.
        render(await page({ tab: 'deploys' }))

        expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByText(/not switched on for this site/)).toBeInTheDocument()
        expect(listDeploys).not.toHaveBeenCalled()
    })

    it('becomes a working tab once the project has the capability', async () => {
        // The panel itself is an async server component, which this renderer cannot resolve inside a
        // tree; deployPanel.test.tsx renders it on its own. What belongs here is the decision this page
        // makes, which is whether the tab is a tab at all.
        listProjects.mockResolvedValue({
            ok: true,
            value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'logs', 'deploy'] }],
        })

        render(await page())

        expect(screen.getByRole('tab', { name: 'Deploys' })).not.toHaveAttribute('aria-disabled')
    })
})

describe('the domains tab', () => {
    // It was built admin-only and disabled, on the reasoning that domains would never be a client's to
    // read. hostd leaves 'domains-read' out of its admin-only verbs, so that reasoning is gone: a client
    // reads their own site's addresses, and only acting on them is the operator's.
    it('shows a client the Domains tab, which used to be hidden from them', async () => {
        callerFromSession.mockResolvedValue(client)

        render(await page())

        expect(screen.getByRole('tab', { name: 'Domains' })).toBeInTheDocument()
    })

    // It used to be disabled for everyone, whatever the project could do. Now the capability is the only
    // thing that disables it, exactly as it is for Deploys.
    it('does not disable the Domains tab for a project hostd serves domains for', async () => {
        listProjects.mockResolvedValue({
            ok: true,
            value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'logs', 'domains'] }],
        })

        render(await page())

        expect(screen.getByRole('tab', { name: 'Domains' })).not.toHaveAttribute('aria-disabled')
    })

    it('never asks hostd for a list it would refuse, on a site with no domains capability', async () => {
        render(await page({ tab: 'domains' }))

        expect(listDomains).not.toHaveBeenCalled()
        expect(screen.getByText(/not switched on for this site/)).toBeInTheDocument()
    })
})
