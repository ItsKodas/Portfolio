// The Environments tab: the list of a site's environments beside the chosen one's Summary, Domains and
// Env files. Env files is an async server component that asks hostd itself, which this renderer cannot
// resolve inside a tree, so it is stood in for here and tested on its own in env.test.tsx.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const copyRunsAction = vi.fn()
const verifyDomainAction = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))
vi.mock('./actions', () => ({
    addEnvironmentAction: async () => ({ ok: true, message: 'ok' }),
    deleteEnvironmentAction: async () => ({ ok: true, message: 'ok' }),
    restoreEnvironmentAction: async () => ({ ok: true, message: 'ok' }),
    copyFromLiveAction: async () => ({ ok: true, run: 'r1', message: 'ok' }),
    copyRunsAction: (...args: unknown[]) => copyRunsAction(...args),
    addDomainAction: async () => ({ ok: true, message: 'ok' }),
    removeDomainAction: async () => ({ ok: true, message: 'ok' }),
    verifyDomainAction: (...args: unknown[]) => verifyDomainAction(...args),
    adoptAction: async () => ({ ok: true, message: 'ok' }),
    adoptPreviewAction: async () => ({ ok: false, error: 'not asked in a test' }),
    setPrimaryDomainAction: async () => ({ ok: true, message: 'ok' }),
    changePrimaryDomainAction: async () => ({ ok: true, message: 'ok' }),
}))
vi.mock('./env', () => ({
    EnvPanel: ({ environment, file }: { environment: string, file: string | null }) =>
        <p>{`env files of ${environment}${file ? ` at ${file}` : ''}`}</p>,
}))

const { EnvironmentsTab } = await import('./environmentsTab')

const environment = (name: string, over: Record<string, unknown> = {}) => ({
    name, branch: null, domain: null, certificate: null, deployed: null, ...over,
})

const view = {
    id: 'acme',
    name: 'Acme Bakery',
    capabilities: ['domains', 'env'],
    // Out of order on purpose: live is listed first whatever order they arrive in
    environments: [
        environment('uat1', { branch: 'uat', domain: 'uat1.acme.com', port: 5011 }),
        environment('live', { branch: 'main', domain: 'acme.com', deployed: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3', port: 5010 }),
    ],
}

const domain = (hostname: string) => ({
    hostname, primary: true, state: 'active' as const, certificate: 'cloudflare-origin' as const,
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null,
})

const props = {
    view,
    isAdmin: true,
    selected: 'live',
    adding: false,
    file: null,
    domains: { domains: [domain('acme.com')], trouble: null },
    branches: ['main', 'uat'],
    branchesError: null,
    deleted: [{
        environment: 'uat2', deletedAt: '2026-09-20T10:00:00.000Z', purgeAt: '2026-10-20T10:00:00.000Z',
        branch: null, domain: null, aliases: [],
    }],
    deletedError: null,
}

type Props = Partial<Parameters<typeof EnvironmentsTab>[0]>
const tab = (over: Props = {}) => render(<EnvironmentsTab {...props} {...over} />)
const region = (name: string) => screen.queryByRole('region', { name })

beforeEach(() => {
    vi.clearAllMocks()
    copyRunsAction.mockResolvedValue({ ok: true, runs: [], running: false })
    verifyDomainAction.mockResolvedValue({ ok: true, message: 'uat1.acme.com answers.' })
})

describe('the list', () => {
    it('lists every environment, live first, with its branch and deployed commit', () => {
        tab()
        const links = within(screen.getByRole('navigation', { name: 'Environments' })).getAllByRole('link')
        expect(links).toHaveLength(2)
        expect(links[0]).toHaveTextContent('live')
        expect(links[0]).toHaveTextContent('main')
        expect(links[0]).toHaveTextContent('5f0ac31')
        expect(links[1]).toHaveTextContent('uat1')
        expect(links[1]).toHaveTextContent('uat')
        expect(links[1]).toHaveTextContent('not deployed')
    })

    it('links each to itself on this tab, and marks the one shown', () => {
        tab({ selected: 'uat1' })
        const nav = within(screen.getByRole('navigation', { name: 'Environments' }))
        const live = nav.getByRole('link', { name: /live/ })
        const uat1 = nav.getByRole('link', { name: /uat1/ })
        expect(live).toHaveAttribute('href', '/portal/sites/acme?tab=environments&env=live')
        expect(uat1).toHaveAttribute('href', '/portal/sites/acme?tab=environments&env=uat1')
        expect(uat1).toHaveAttribute('aria-current', 'page')
        expect(live).not.toHaveAttribute('aria-current')
    })

    it('offers the operator Add environment, with the deleted ones under the list', () => {
        tab()
        expect(screen.getByRole('link', { name: 'Add environment' })).toHaveAttribute('href', '/portal/sites/acme?tab=environments&add=1')
        const deleted = screen.getByRole('list', { name: 'Deleted environments' })
        expect(within(deleted).getByText('uat2')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Restore uat2' })).toBeInTheDocument()
    })

    it('offers a client neither', () => {
        tab({ isAdmin: false })
        expect(screen.queryByRole('link', { name: 'Add environment' })).toBeNull()
        expect(screen.queryByRole('heading', { name: 'Deleted environments' })).toBeNull()
        expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
    })

    it('says so when the environments could not be read', () => {
        tab({ view: { ...view, environments: [] } })
        expect(screen.getByText(/environments could not be read/i)).toBeInTheDocument()
    })
})

describe('the detail, for the operator', () => {
    it('shows the Summary, Domains and Env files of the one chosen', () => {
        tab({ selected: 'uat1', domains: { domains: [domain('uat1.acme.com')], trouble: null }, file: '.env' })
        expect(screen.getByRole('heading', { level: 2, name: 'uat1' })).toBeInTheDocument()
        expect(within(region('Summary')!).getByText('5011')).toBeInTheDocument()
        expect(within(region('Domains')!).getByText('uat1.acme.com', { selector: 'p' })).toBeInTheDocument()
        expect(within(region('Env files')!).getByText('env files of uat1 at .env')).toBeInTheDocument()
    })

    it('offers Copy and Delete on an environment other than live', () => {
        tab({ selected: 'uat1' })
        expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Delete uat1' })).toBeInTheDocument()
    })

    it('offers neither on live', () => {
        tab()
        expect(screen.queryByRole('button', { name: /copy data/i })).toBeNull()
        expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull()
    })

    // live's main address is changed from Settings now
    it('draws live\'s Domains with no control that changes the main address', () => {
        tab()
        const domains = within(region('Domains')!)
        expect(domains.queryByRole('button', { name: /change the address|set the address/i })).toBeNull()
        expect(domains.queryByLabelText(/new address/i)).toBeNull()
        expect(domains.getByText(/Settings tab/)).toBeInTheDocument()
    })

    it('says Domains is not switched on, rather than drawing it, without the capability', () => {
        tab({ view: { ...view, capabilities: ['env'] } })
        expect(within(region('Domains')!).getByText(/Domains are not switched on for this site/)).toBeInTheDocument()
        expect(screen.queryByRole('table')).toBeNull()
    })

    it('says Env files is not switched on, rather than drawing it, without the capability', () => {
        tab({ view: { ...view, capabilities: ['domains'] } })
        expect(within(region('Env files')!).getByText(/Environment files are not switched on for this site/)).toBeInTheDocument()
        expect(screen.queryByText(/env files of/)).toBeNull()
    })

    it("tells the add form why the repository's branches are not listed", () => {
        tab({ adding: true, branches: null, branchesError: 'hostd could not be reached.' })
        expect(screen.getByText("The repository's branches could not be read: hostd could not be reached.")).toBeInTheDocument()
    })

    it('opens the add form in place of the detail when Add environment is chosen', () => {
        tab({ adding: true })
        expect(screen.getByRole('heading', { name: 'Add an environment' })).toBeInTheDocument()
        expect(screen.getByLabelText('Name')).toBeInTheDocument()
        expect(region('Summary')).toBeNull()
        expect(screen.getByRole('link', { name: 'Add environment' })).toHaveAttribute('aria-current', 'page')
        // No environment is the one shown while adding
        expect(within(screen.getByRole('navigation', { name: 'Environments' })).getByRole('link', { name: /live/ }))
            .not.toHaveAttribute('aria-current')
    })

    // live's primary domain is the second base the form offers, taken from the site's own environments
    it("offers live's primary domain as a base in the add form, and only horizons.gg without one", () => {
        const { unmount } = tab({ adding: true })
        const bases = () => within(screen.getByLabelText('Base')).getAllByRole('option').map(option => option.textContent)
        expect(bases()).toEqual(['horizons.gg', 'acme.com'])
        unmount()

        tab({
            adding: true,
            view: { ...view, environments: [environment('live', { domain: null }), environment('uat1')] },
        })
        expect(bases()).toEqual(['horizons.gg'])
    })

    // Deleting an environment goes back to live by navigating on this same route, which rerenders rather
    // than remounts. The Domains table keys its rows by position, so without a key on the detail a row's
    // open confirm or its last result would land on live's row beside a different hostname.
    it("does not carry one environment's domain row state onto the next one shown", async () => {
        const rows = (name: string, host: string) => ({
            domains: [domain(host), { ...domain(`www.${host}`), primary: false }],
            trouble: null,
        })
        const { rerender } = render(<EnvironmentsTab {...props} selected="uat1" domains={rows('uat1', 'uat1.acme.com')} />)

        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]) })
        expect(screen.getByText('uat1.acme.com answers.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
        expect(screen.getByRole('dialog', { name: 'Remove this address' })).toBeInTheDocument()

        rerender(<EnvironmentsTab {...props} selected="live" domains={rows('live', 'acme.com')} />)
        expect(screen.queryByText('uat1.acme.com answers.')).toBeNull()
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('says an environment that could not be read could not be read, rather than drawing nothing in it', () => {
        tab({ view: { ...view, environments: [] } })
        expect(within(region('Summary')!).getByText(/could not be read/i)).toBeInTheDocument()
    })
})

describe('the detail, for a client', () => {
    const client = { isAdmin: false }

    it('shows the Summary without a port and the Domains as a client sees them, but no Env files', () => {
        tab({ ...client, selected: 'uat1', domains: { domains: [domain('uat1.acme.com')], trouble: null } })
        const summary = within(region('Summary')!)
        expect(summary.getByText('uat')).toBeInTheDocument()
        expect(summary.queryByText('5011')).toBeNull()
        expect(within(region('Domains')!).getByText('Your website address')).toBeInTheDocument()
        expect(region('Env files')).toBeNull()
        expect(screen.queryByText(/env files of/)).toBeNull()
    })

    it('offers a client no action at all', () => {
        tab({ ...client, selected: 'uat1' })
        expect(screen.queryByRole('button')).toBeNull()
        expect(copyRunsAction).not.toHaveBeenCalled()
    })

    it('never opens the add form for a client', () => {
        tab({ ...client, adding: true })
        expect(screen.queryByLabelText('Name')).toBeNull()
        expect(region('Summary')).not.toBeNull()
    })
})
