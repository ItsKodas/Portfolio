import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveSettingsAction = vi.fn()
const deleteSiteAction = vi.fn()
const refresh = vi.fn()
const push = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh(), push: (to: string) => push(to) }) }))
vi.mock('./actions', () => ({
    saveSettingsAction: (...args: unknown[]) => saveSettingsAction(...args),
    deleteSiteAction: (...args: unknown[]) => deleteSiteAction(...args),
    setPortAction: vi.fn(),
}))
vi.mock('../portActions', () => ({ checkPortAction: async () => ({ ok: true, suggested: 5012, problem: null }) }))

const { SiteSettingsForm } = await import('./settings')

const props = {
    id: 'arbysauto',
    name: 'Arbys Auto Glass',
    capabilities: ['lifecycle', 'logs'],
    repo: null,
    credential: null,
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
        const capabilities = screen.getByRole('group', { name: /capabilities/i })
        expect(within(capabilities).getAllByRole('checkbox')).toHaveLength(8)
    })

    it('shows each environment\'s WebSockets switch as the registry has it', () => {
        const environments = [
            { name: 'live', branch: null, websockets: true },
            { name: 'test', branch: null },
        ]
        render(<SiteSettingsForm {...props} environments={environments} />)
        expect(screen.getByRole('checkbox', { name: /live WebSockets/ })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /test WebSockets/ })).not.toBeChecked()
    })

    // Switching it rewrites that environment's vhost, so the environment left alone is not sent at all.
    it('sends only the environment whose WebSockets switch changed', async () => {
        const environments = [
            { name: 'live', branch: null },
            { name: 'test', branch: null, websockets: true },
        ]
        render(<SiteSettingsForm {...props} environments={environments} />)

        await userEvent.click(screen.getByRole('checkbox', { name: /live WebSockets/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { websockets: { live: true } })
    })

    // Unticking is the way off once the CDN reaches port 443, so it has to be sent as false, not dropped.
    it('sends a Flexible SSL switch turned off, and nothing else', async () => {
        render(<SiteSettingsForm {...props} environments={[{ name: 'live', branch: null, flexibleSsl: true }]} />)

        expect(screen.getByRole('checkbox', { name: /live Cloudflare Flexible SSL/ })).toBeChecked()
        await userEvent.click(screen.getByRole('checkbox', { name: /live Cloudflare Flexible SSL/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { flexibleSsl: { live: false } })
    })

    it('marks the ones hostd cannot act on yet, so ticking one is not mistaken for switching it on', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText(/not built yet/i)).toBeInTheDocument()
    })

    // A stale page (api served a registry copy from before an earlier save) must not let an untouched
    // field overwrite what is actually saved. Sending only what changed means a stale page costs the
    // operator the one field they edited, not everything on the form: see feedback-dont-touch-apex-mail
    // in spirit, but the actual incident was hostd's repo getting cleared by a capability-only save.
    it('sends only the field that actually changed', async () => {
        render(<SiteSettingsForm {...props} />)

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', {
            capabilities: ['lifecycle', 'logs', 'deploy'],
        })
    })

    it('leaves an untouched repo out of the payload entirely', async () => {
        render(<SiteSettingsForm {...props} repo="git@github.com:ItsKodas/a.git" />)

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        const [, payload] = saveSettingsAction.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload).not.toHaveProperty('repo')
    })

    // The whole point: only the environment actually edited rides along, so a save never clears a branch
    // on the environment left alone.
    it('sends only the environment whose branch changed, not the other one', async () => {
        const twoEnvironments = [
            { name: 'live', branch: 'main', dir: '/var/www/arbysauto', port: 5011 },
            { name: 'test', branch: 'develop', dir: '/var/www/arbysauto-test', port: 5012 },
        ]
        render(<SiteSettingsForm {...props} environments={twoEnvironments} />)

        const liveBranch = screen.getByLabelText(/live branch/i)
        await userEvent.clear(liveBranch)
        await userEvent.type(liveBranch, 'release')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        const [, payload] = saveSettingsAction.mock.calls[0] as [string, Record<string, unknown>]
        expect(payload).not.toHaveProperty('capabilities')
        expect(payload).not.toHaveProperty('repo')
        expect(payload).toEqual({ branches: { live: 'release' } })
    })

    // Adding or restoring an environment refreshes the page, which hands this form a new environment
    // while keeping its state. One this form has never seen is untouched, not blank: saving anything else
    // must not send its branch or its switches back as cleared.
    it('leaves an environment that arrived after it was drawn out of the payload', async () => {
        const { rerender } = render(<SiteSettingsForm {...props} />)
        rerender(<SiteSettingsForm
            {...props}
            environments={[...props.environments, { name: 'uat1', branch: 'uat', websockets: true, flexibleSsl: true }]}
        />)

        expect(screen.getByLabelText(/uat1 branch/i)).toHaveValue('uat')
        expect(screen.getByRole('checkbox', { name: /uat1 WebSockets/ })).toBeChecked()

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { capabilities: ['lifecycle', 'logs', 'deploy'] })
    })

    // A valid environment name that is also a property every plain object inherits: read from a plain
    // object it would come back as a function, not as missing
    it('reads an environment named constructor that arrived after it was drawn as untouched', async () => {
        const { rerender } = render(<SiteSettingsForm {...props} />)
        rerender(<SiteSettingsForm
            {...props}
            environments={[...props.environments, { name: 'constructor', branch: 'uat' }]}
        />)

        expect(screen.getByLabelText(/constructor branch/i)).toHaveValue('uat')
        expect(screen.getByRole('checkbox', { name: /constructor WebSockets/ })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: /constructor Cloudflare Flexible SSL/ })).not.toBeChecked()

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { capabilities: ['lifecycle', 'logs', 'deploy'] })
    })

    // Saving what nobody touched would report success over a request that changed nothing on hostd's end.
    it('calls nothing, and says so plainly, when nothing on the form changed', async () => {
        render(<SiteSettingsForm {...props} />)

        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).not.toHaveBeenCalled()
        expect(await screen.findByText(/nothing changed/i)).toBeInTheDocument()
        expect(refresh).not.toHaveBeenCalled()
    })

    // The destructive direction, and the one the two below would show up in: everything the form sends is
    // what the entry becomes, so a capability dropped from this list is a capability taken away.
    it('takes a capability away when one already on is unticked', async () => {
        render(<SiteSettingsForm {...props} />)

        await userEvent.click(screen.getByRole('checkbox', { name: /logs/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', expect.objectContaining({ capabilities: ['lifecycle'] }))
    })

    it('keeps the order the registry holds them in rather than this page\'s, once something actually changed', async () => {
        render(<SiteSettingsForm {...props} capabilities={['logs', 'lifecycle']} />)
        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { capabilities: ['logs', 'lifecycle', 'deploy'] })
    })

    // hostd owns the capability list, not this page. One it gains that this page has not been taught has
    // no checkbox here, so a save must carry it back rather than strip it from the entry.
    it('keeps a capability it does not know about instead of dropping it', async () => {
        render(<SiteSettingsForm {...props} capabilities={['lifecycle', 'teleport']} />)
        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', expect.objectContaining({
            capabilities: ['lifecycle', 'teleport', 'deploy'],
        }))
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

    it('shows each environment\'s port in its own control', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByLabelText('live port')).toHaveValue('5011')
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

describe('the branch field, with no list to offer', () => {
    // A repo hostd could not read branches for, or a project with no repo at all, must still let the
    // operator set a branch by hand: this is the path that was already built and tested before the
    // select existed, and it must not regress now that the happy path is a dropdown.
    it('stays a plain text field, and still takes any text, when there is no list', async () => {
        render(<SiteSettingsForm {...props} branches={null} />)
        expect(document.querySelector('datalist')).toBeNull()
        const branch = screen.getByLabelText(/branch/i)
        expect(branch.tagName).toBe('INPUT')
        await userEvent.type(branch, 'whatever-was-just-pushed')
        expect(branch).toHaveValue('whatever-was-just-pushed')
    })

    // Never blocks the field, and never a validation-style error: hostd could not read the list, not the
    // operator did something wrong.
    it('says the list could not be read, in hostd\'s own words, without disabling anything', () => {
        render(<SiteSettingsForm {...props} branches={null} branchesError="the fetcher is not configured" />)
        expect(screen.getByText(/the fetcher is not configured/)).toBeInTheDocument()
        expect(screen.getByLabelText(/branch/i)).not.toBeDisabled()
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('still saves what was typed by hand', async () => {
        render(<SiteSettingsForm {...props} branches={null} />)
        await userEvent.type(screen.getByLabelText(/branch/i), 'main')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { branches: { live: 'main' } })
    })
})

describe('the branch select', () => {
    // A datalist only offers its options once the operator starts typing, so it reads as a plain text
    // box rather than a dropdown: that is how a live site ended up with `main` in its registry when the
    // repository has no branch by that name. A select cannot be typed past like that.
    it('is a select, offering the repository\'s branches, once there is a list to offer', () => {
        render(<SiteSettingsForm {...props} branches={['master', 'develop']} />)
        const branch = screen.getByLabelText(/branch/i)
        expect(branch.tagName).toBe('SELECT')
        const optionValues = Array.from(branch.querySelectorAll('option')).map(option => option.getAttribute('value'))
        expect(optionValues).toEqual(expect.arrayContaining(['master', 'develop']))
    })

    it('offers the same options to every environment\'s branch field, since they share one repo', () => {
        const twoEnvironments = [
            { name: 'live', branch: 'master', dir: '/var/www/arbysauto', port: 5011 },
            { name: 'test', branch: 'develop', dir: '/var/www/arbysauto-test', port: 5012 },
        ]
        render(<SiteSettingsForm {...props} environments={twoEnvironments} branches={['master', 'develop']} />)
        const optionsOf = (label: RegExp) =>
            Array.from(screen.getByLabelText(label).querySelectorAll('option')).map(option => option.getAttribute('value'))
        expect(optionsOf(/live branch/i)).toEqual(optionsOf(/test branch/i))
    })

    // The incident this whole change is for: `main` was saved by hand and is not one of the repository's
    // actual branches. A select must neither drop it nor silently swap in something else, because either
    // one would be this page rewriting the operator's configuration on a render. It stays chosen, and it
    // is visible why the deploy is failing without the operator having to go dig through logs.
    it('keeps a saved branch selected, and says plainly that it is not on the repository, when it is not in the list', () => {
        const environments = [{ name: 'live', branch: 'main', dir: '/var/www/arbysauto', port: 5011 }]
        render(<SiteSettingsForm {...props} environments={environments} branches={['master', 'develop']} />)
        const branch = screen.getByLabelText(/branch/i) as HTMLSelectElement
        expect(branch.value).toBe('main')
        expect(screen.getByText(/"main".*not.*branch/i)).toBeInTheDocument()
    })

    it('says nothing extra when the saved branch is one of the repository\'s branches', () => {
        const environments = [{ name: 'live', branch: 'master', dir: '/var/www/arbysauto', port: 5011 }]
        render(<SiteSettingsForm {...props} environments={environments} branches={['master', 'develop']} />)
        expect(screen.queryByText(/not.*branch/i)).toBeNull()
    })

    // How an environment stops deploying: there must always be a way back to no branch at all, the same
    // as typing an empty value into the old text field did.
    it('can be set back to no branch at all', async () => {
        const environments = [{ name: 'live', branch: 'master', dir: '/var/www/arbysauto', port: 5011 }]
        render(<SiteSettingsForm {...props} environments={environments} branches={['master', 'develop']} />)

        await userEvent.selectOptions(screen.getByLabelText(/branch/i), '')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { branches: { live: null } })
    })

    it('saves a branch chosen from the list', async () => {
        const environments = [{ name: 'live', branch: null, dir: '/var/www/arbysauto', port: 5011 }]
        render(<SiteSettingsForm {...props} environments={environments} branches={['master', 'develop']} />)

        await userEvent.selectOptions(screen.getByLabelText(/branch/i), 'develop')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { branches: { live: 'develop' } })
    })
})

const withCredentials = { ...props, credential: null, credentials: ['acme', 'northwind'], credentialsError: null }

describe('the account select', () => {
    it('offers the default and every name the fetcher holds', () => {
        render(<SiteSettingsForm {...withCredentials} />)
        const select = screen.getByRole('combobox', { name: /account/i })
        expect(select).toHaveValue('')
        expect(screen.getByRole('option', { name: /default/i })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'acme' })).toBeInTheDocument()
    })

    it('sends the chosen name on its own, leaving every other field alone', async () => {
        render(<SiteSettingsForm {...withCredentials} />)

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /account/i }), 'acme')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { credential: 'acme' })
    })

    // Back to the default token, which has to be reachable: an operator who set the wrong account
    // would otherwise have to SSH into the dedi to undo it.
    it('sends null when the default is chosen again', async () => {
        render(<SiteSettingsForm {...withCredentials} credential="acme" />)

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /account/i }), '')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { credential: null })
    })

    // The same rule the branch select learned: a saved value the list no longer has is still shown.
    // Dropping it would be this page rewriting the operator's configuration by rendering.
    it('still shows a saved name the fetcher no longer holds, and says what that means', () => {
        render(<SiteSettingsForm {...withCredentials} credential="gone" />)

        expect(screen.getByRole('combobox', { name: /account/i })).toHaveValue('gone')
        expect(screen.getByText(/no credential named "gone"/i)).toBeInTheDocument()
    })

    // Never blocks the field: hostd could not answer, the operator did nothing wrong.
    it('falls back to showing the saved name when the list could not be read', () => {
        render(<SiteSettingsForm {...props} credential="acme" credentials={null} credentialsError="hostd could not be reached." />)

        expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    })
})

describe('deleting the site', () => {
    it('only lets Delete through once the name is typed back exactly', async () => {
        render(<SiteSettingsForm {...props} />)
        await userEvent.click(screen.getByRole('button', { name: 'Delete site' }))

        const dialog = screen.getByRole('dialog')
        const confirm = within(dialog).getByRole('button', { name: 'Delete site' })
        expect(confirm).toBeDisabled()

        await userEvent.type(within(dialog).getByLabelText(/type arbys auto glass to confirm/i), 'arbys auto glass')
        expect(confirm).toBeDisabled()

        await userEvent.clear(within(dialog).getByLabelText(/to confirm/i))
        await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'Arbys Auto Glass')
        expect(confirm).toBeEnabled()
        expect(deleteSiteAction).not.toHaveBeenCalled()
    })

    it('deletes, then leaves for the dashboard', async () => {
        deleteSiteAction.mockResolvedValue({ ok: true, message: 'Deleted.' })
        render(<SiteSettingsForm {...props} />)
        await userEvent.click(screen.getByRole('button', { name: 'Delete site' }))

        const dialog = screen.getByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'Arbys Auto Glass')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete site' }))

        expect(deleteSiteAction).toHaveBeenCalledWith('arbysauto', 'Arbys Auto Glass')
        expect(push).toHaveBeenCalledWith('/portal')
    })

    it('stays on the page and says why when hostd refuses', async () => {
        deleteSiteAction.mockResolvedValue({ ok: false, error: 'could not stop arbysauto before removing it' })
        render(<SiteSettingsForm {...props} />)
        await userEvent.click(screen.getByRole('button', { name: 'Delete site' }))

        const dialog = screen.getByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'Arbys Auto Glass')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete site' }))

        expect(await within(dialog).findByText(/could not stop arbysauto/)).toBeInTheDocument()
        expect(push).not.toHaveBeenCalled()
    })
})
