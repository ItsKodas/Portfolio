import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSiteAction = vi.fn()
const newSiteOptionsAction = vi.fn()
const checkPortAction = vi.fn()
const push = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: (path: string) => push(path) }) }))
vi.mock('./actions', () => ({
    createSiteAction: (...args: unknown[]) => createSiteAction(...args),
    newSiteOptionsAction: () => newSiteOptionsAction(),
}))
vi.mock('../sites/portActions', () => ({ checkPortAction: (...args: unknown[]) => checkPortAction(...args) }))

const { NewSiteButton } = await import('./NewSite')

beforeEach(() => {
    vi.clearAllMocks()
    newSiteOptionsAction.mockResolvedValue({ ok: true, clients: [{ id: 'cl_2', name: 'Acme' }], credentials: ['acme'], credentialsError: null })
    createSiteAction.mockResolvedValue({ ok: true, id: 'the-bakery', warnings: [] })
    checkPortAction.mockImplementation(async (port: number | null) => ({
        ok: true, suggested: 5012, problem: port === 5004 ? 'port 5004 is in use on the host' : null,
    }))
})

async function open() {
    render(<NewSiteButton />)
    await userEvent.click(screen.getByRole('button', { name: /new site/i }))
    // The client list arrives after the dialog opens
    await screen.findByRole('option', { name: 'Acme' })
}

describe('the New site form', () => {
    it('fills the id and folder in from the name until one is typed into', async () => {
        await open()
        await userEvent.type(screen.getByLabelText('Name'), 'The Bakery!')
        expect(screen.getByLabelText('Project id')).toHaveValue('the-bakery')
        expect(screen.getByLabelText('Folder')).toHaveValue('the-bakery')

        await userEvent.clear(screen.getByLabelText('Folder'))
        await userEvent.type(screen.getByLabelText('Folder'), 'bakery_www')
        await userEvent.type(screen.getByLabelText('Name'), ' Co')
        expect(screen.getByLabelText('Project id')).toHaveValue('the-bakery-co')
        expect(screen.getByLabelText('Folder')).toHaveValue('bakery_www')
    })

    it('says what is missing instead of sending it', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled())
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))
        expect(screen.getByText('Enter a name.')).toBeInTheDocument()
        expect(createSiteAction).not.toHaveBeenCalled()
    })

    it('sends everything the form holds, and opens the new site', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.type(screen.getByLabelText('Name'), 'The Bakery')
        await userEvent.selectOptions(screen.getByLabelText('Client'), 'cl_2')
        await userEvent.type(screen.getByLabelText('Repo'), 'git@github.com:ItsKodas/bakery.git')
        await userEvent.selectOptions(screen.getByLabelText('Account'), 'acme')
        await userEvent.click(screen.getByRole('button', { name: 'Add a compose file' }))
        await userEvent.type(screen.getByLabelText('Compose file 2'), 'docker-compose.prod.yml')
        await userEvent.click(within(screen.getByRole('group', { name: 'Features' })).getByRole('checkbox', { name: 'logs' }))
        await userEvent.click(screen.getByRole('checkbox', { name: 'WebSockets' }))
        await userEvent.type(screen.getByLabelText('Domain'), 'bakery.com')
        await userEvent.click(screen.getByRole('checkbox', { name: 'Deploy after creating' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled())
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))

        expect(createSiteAction).toHaveBeenCalledWith({
            name: 'The Bakery', id: 'the-bakery', dir: 'the-bakery', client: 'cl_2',
            repo: 'git@github.com:ItsKodas/bakery.git', credential: 'acme', branch: 'main',
            compose: ['docker-compose.yml', 'docker-compose.prod.yml'],
            capabilities: ['lifecycle', 'domains', 'env', 'deploy'],
            websockets: true, flexibleSsl: false, domain: 'bakery.com', certificate: 'letsencrypt', deploy: true,
            port: '5012',
        })
        expect(push).toHaveBeenCalledWith('/portal/sites/the-bakery')
    })

    it('fills the port in with the lowest free one', async () => {
        await open()
        expect(await screen.findByDisplayValue('5012')).toBe(screen.getByLabelText('Port'))
    })

    it('does not ask hostd again once the field fills with the port it suggested, and leaves Create enabled', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        expect(checkPortAction).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled()
    })

    it('says a taken port is taken, and does not send it', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.clear(screen.getByLabelText('Port'))
        await userEvent.type(screen.getByLabelText('Port'), '5004')
        expect(await screen.findByText('port 5004 is in use on the host')).toBeInTheDocument()
        await userEvent.type(screen.getByLabelText('Name'), 'Bakery')
        await userEvent.type(screen.getByLabelText('Repo'), 'git@github.com:ItsKodas/bakery.git')
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))
        expect(createSiteAction).not.toHaveBeenCalled()
    })

    it('refuses a port below 5000', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.clear(screen.getByLabelText('Port'))
        await userEvent.type(screen.getByLabelText('Port'), '3000')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled())
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))
        expect(screen.getByText('Use a port from 5000 to 65535.')).toBeInTheDocument()
    })

    it('cannot deploy a site without the deploy feature', async () => {
        await open()
        await userEvent.click(within(screen.getByRole('group', { name: 'Features' })).getByRole('checkbox', { name: 'deploy' }))
        expect(screen.getByRole('checkbox', { name: 'Deploy after creating' })).toBeDisabled()
    })

    it('keeps the dialog open to say what is left to do on a site that was created', async () => {
        createSiteAction.mockResolvedValue({ ok: true, id: 'the-bakery', warnings: ['The vhost was not written: x.conf serves it.'] })
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.type(screen.getByLabelText('Name'), 'The Bakery')
        await userEvent.type(screen.getByLabelText('Repo'), 'git@github.com:ItsKodas/bakery.git')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled())
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))

        expect(await screen.findByText('The vhost was not written: x.conf serves it.')).toBeInTheDocument()
        expect(push).not.toHaveBeenCalled()
        await userEvent.click(screen.getByRole('button', { name: 'Open the site' }))
        expect(push).toHaveBeenCalledWith('/portal/sites/the-bakery')
    })

    it('shows hostd\'s refusal and keeps what was typed', async () => {
        createSiteAction.mockResolvedValue({ ok: false, error: '/var/www/the-bakery already exists' })
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.type(screen.getByLabelText('Name'), 'The Bakery')
        await userEvent.type(screen.getByLabelText('Repo'), 'git@github.com:ItsKodas/bakery.git')
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create site' })).toBeEnabled())
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))

        expect(await screen.findByText('/var/www/the-bakery already exists')).toBeInTheDocument()
        expect(screen.getByLabelText('Name')).toHaveValue('The Bakery')
    })
})
