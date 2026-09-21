import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveSettingsAction = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))
vi.mock('./actions', () => ({ saveSettingsAction: (...args: unknown[]) => saveSettingsAction(...args) }))

const { SiteSettingsForm } = await import('./settings')

const props = {
    id: 'arbysauto',
    capabilities: ['lifecycle', 'logs'],
    repo: null,
    environments: [{ name: 'live', branch: null, dir: '/var/www/arbysauto', port: 5011 }],
}

beforeEach(() => {
    vi.clearAllMocks()
    saveSettingsAction.mockResolvedValue({ ok: true, message: 'Saved.' })
})

describe('the settings form', () => {
    it('shows every capability, ticked as the registry has it', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByRole('checkbox', { name: /lifecycle/ })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /deploy/ })).not.toBeChecked()
        // All eight, including the four hostd cannot act on yet
        expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    })

    it('marks the ones hostd cannot act on yet, so ticking one is not mistaken for switching it on', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText(/not built yet/i)).toBeInTheDocument()
    })

    it('sends the whole form', async () => {
        render(<SiteSettingsForm {...props} />)

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.type(screen.getByLabelText(/repo/i), 'git@github.com:ItsKodas/arbysauto.git')
        await userEvent.type(screen.getByLabelText(/branch/i), 'main')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', {
            capabilities: ['lifecycle', 'logs', 'deploy'],
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
    })

    it('sends a cleared repo as null rather than an empty string', async () => {
        render(<SiteSettingsForm {...props} repo="git@github.com:ItsKodas/a.git" />)
        await userEvent.clear(screen.getByLabelText(/repo/i))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', expect.objectContaining({ repo: null }))
    })

    it('shows the dir and the port without offering to change them', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText('/var/www/arbysauto')).toBeInTheDocument()
        expect(screen.queryByLabelText(/dir/i)).toBeNull()
    })

    it('re-reads the page once the save lands, so the tabs it gates come back enabled', async () => {
        render(<SiteSettingsForm {...props} />)
        await userEvent.click(screen.getByRole('checkbox', { name: /env/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(refresh).toHaveBeenCalled()
    })

    it('keeps what was typed when hostd refuses it', async () => {
        saveSettingsAction.mockResolvedValue({ ok: false, error: 'branch needs repo' })
        render(<SiteSettingsForm {...props} />)

        await userEvent.type(screen.getByLabelText(/branch/i), 'main')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(await screen.findByText(/branch needs repo/)).toBeInTheDocument()
        expect(screen.getByLabelText(/branch/i)).toHaveValue('main')
        expect(refresh).not.toHaveBeenCalled()
    })

    it('says what it cannot check, rather than pretending', async () => {
        // A deploy needs a git repository already at <dir>/.git and hostd only finds out when it runs
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText(/git repository/i)).toBeInTheDocument()
    })
})
