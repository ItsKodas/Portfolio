// gatherSite is tested on its own. This renders the real page component over the real ui/ components,
// because a page that throws at request time passes every one of those tests.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listProjects = vi.fn()
const listDeploys = vi.fn()
const getProject = vi.fn()
const assertOwned = vi.fn()
const callerFromSession = vi.fn()

vi.mock('next/navigation', () => ({
    // Both of these work by throwing in Next. Throwing something recognisable here is what lets a test
    // compare two outcomes rather than two rendered pages.
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) },
    useRouter: () => ({ push: () => {}, refresh: () => {} }),
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
}))
vi.mock('@/server/hostd/deploys', () => ({ listDeploys: (...args: unknown[]) => listDeploys(...args) }))

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
    assertOwned.mockResolvedValue(true)
})

describe('the site page', () => {
    it('shows the site, its containers and its tabs', async () => {
        render(await page())

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ASOT')
        expect(screen.getByText('asot-web')).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
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

    it('says of the other sites that it could not read them, rather than calling them stopped', async () => {
        listProjects.mockResolvedValue({ ok: true, value: [
            { id: 'asot', name: 'ASOT', valid: true, capabilities: [] },
            { id: 'pmpc-group', name: 'PMPC Group', valid: true, capabilities: [] },
        ] })

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
