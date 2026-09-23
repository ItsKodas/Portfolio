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
})
