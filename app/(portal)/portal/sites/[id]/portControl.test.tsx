import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setPortAction = vi.fn()
const checkPortAction = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))
vi.mock('./actions', () => ({ setPortAction: (...args: unknown[]) => setPortAction(...args) }))
vi.mock('../portActions', () => ({ checkPortAction: (...args: unknown[]) => checkPortAction(...args) }))

const { PortControl } = await import('./portControl')

beforeEach(() => {
    vi.clearAllMocks()
    checkPortAction.mockImplementation(async (port: number | null) => ({
        ok: true, suggested: 5012, problem: port === 5011 ? 'port 5011 is taken by other (live)' : null,
    }))
    setPortAction.mockResolvedValue({ ok: true, message: 'live now uses port 5013.' })
})

describe('the port control', () => {
    it('shows the environment\'s port, and does not offer to save it unchanged', () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        expect(screen.getByLabelText('live port')).toHaveValue('5010')
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
        expect(checkPortAction).not.toHaveBeenCalled()
    })

    it('checks a new port for this environment and says when it is taken', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5011')
        expect(await screen.findByText('port 5011 is taken by other (live)')).toBeInTheDocument()
        expect(checkPortAction).toHaveBeenLastCalledWith(5011, { project: 'acme', environment: 'live' })
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
    })

    it('says saving restarts the site, then saves', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        expect(screen.getByText(/recreates this environment's containers/)).toBeInTheDocument()
        const button = screen.getByRole('button', { name: 'Change port' })
        await vi.waitFor(() => expect(button).toBeEnabled())
        await userEvent.click(button)
        expect(setPortAction).toHaveBeenCalledWith('acme', 'live', 5013)
        expect(await screen.findByText('live now uses port 5013.')).toBeInTheDocument()
        expect(refresh).toHaveBeenCalled()
    })

    // Nothing to ask hostd about a value that is not a port in range: the field says so itself
    it('does not ask hostd about a port out of range', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '3000')
        expect(screen.getByText('Use a port from 5000 to 65535.')).toBeInTheDocument()
        await new Promise(resolve => setTimeout(resolve, 600))
        expect(checkPortAction).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
    })

    it('names the port variable without assuming it is WEB_PORT', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        expect(screen.getByText(/the site's port variable \(WEB_PORT unless the registry names another\)/)).toBeInTheDocument()
    })

    it('shows hostd\'s refusal', async () => {
        setPortAction.mockResolvedValue({ ok: false, error: 'no service publishes port 5013' })
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        const button = screen.getByRole('button', { name: 'Change port' })
        await vi.waitFor(() => expect(button).toBeEnabled())
        await userEvent.click(button)
        expect(await screen.findByText('no service publishes port 5013')).toBeInTheDocument()
    })

    // router.refresh() is async, so the page's own `port` prop does not update the instant a save
    // succeeds. Until it does, the value just saved must not read as "changed" again: that would
    // re-enable the button and bring the restart note back beside the success callout it is sitting
    // next to, inviting a second needless container recreation of a port the site is already on.
    it('treats the value it just saved as current, before the page re-reads and after', async () => {
        const { rerender } = render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        const button = screen.getByRole('button', { name: 'Change port' })
        await vi.waitFor(() => expect(button).toBeEnabled())
        await userEvent.click(button)
        expect(await screen.findByText('live now uses port 5013.')).toBeInTheDocument()

        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
        expect(screen.queryByText(/recreates this environment's containers/)).toBeNull()

        rerender(<PortControl id="acme" environment="live" port={5013} />)
        expect(screen.getByLabelText('live port')).toHaveValue('5013')
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
    })
})
