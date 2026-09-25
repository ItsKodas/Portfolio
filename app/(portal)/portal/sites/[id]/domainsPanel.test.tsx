// Two screens over one list, which is the whole reason this panel takes its domains as a prop instead of
// asking hostd itself: the operator's table and the client's sentences are both worth rendering without a
// network in the way.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const { adoptPreview, changePrimary, addDomain } = vi.hoisted(() => ({ adoptPreview: vi.fn(), changePrimary: vi.fn(), addDomain: vi.fn() }))

// The panel is a server component, but its controls are the client half, and importing those for real
// drags Prisma and next/cache into a jsdom test for nothing. useRouter needs a mounted app router, which
// this renderer has no way to give it.
vi.mock('./actions', () => ({
    addDomainAction: (...args: unknown[]) => addDomain(...args),
    removeDomainAction: async () => ({ ok: true, message: 'ok' }),
    verifyDomainAction: async () => ({ ok: true, message: 'ok' }),
    adoptAction: async () => ({ ok: true, message: 'ok' }),
    adoptPreviewAction: (...args: unknown[]) => adoptPreview(...args),
    setPrimaryDomainAction: async () => ({ ok: true, message: 'ok' }),
    changePrimaryDomainAction: (...args: unknown[]) => changePrimary(...args),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

import type { AdoptPreview, Domain } from '@/server/hostd/domains'
import { PrimaryDomain } from './domainControls'
import { DomainsPanel } from './domainsPanel'

const domain = (over: Partial<Domain> = {}): Domain => ({
    hostname: 'acme.com', primary: true, state: 'active', certificate: 'cloudflare-origin',
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null, ...over,
})

const props = {
    id: 'acme', environment: 'live', projectName: 'Acme Bakery',
    domains: [domain()], isAdmin: true, trouble: null,
}

// A hand-written vhost that does more than the two directives hostd's parser reads: the rewrite and the
// basic auth block are exactly what is lost if the preview shows a path instead of a file.
const HAND_WRITTEN = `<VirtualHost *:443>
    ServerName acme.com
    RewriteEngine On
    RewriteRule ^/old/(.*)$ /shop/$1 [R=301,L]
    <Location /admin>
        AuthType Basic
        AuthUserFile /etc/apache2/acme.htpasswd
        Require valid-user
    </Location>
</VirtualHost>
`

const preview = (over: Partial<AdoptPreview> = {}): AdoptPreview => ({
    proposed: '<VirtualHost *:443>\n    ServerName acme.com\n</VirtualHost>\n',
    claims: [{
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: HAND_WRITTEN,
        names: ['acme.com'],
        unsupported: [],
    }],
    extraNames: [],
    unreadable: [],
    adoptable: true,
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    adoptPreview.mockResolvedValue({ ok: true, preview: preview() })
    changePrimary.mockResolvedValue({ ok: true, message: 'ok' })
    addDomain.mockResolvedValue({ ok: true, message: 'ok' })
})

describe('DomainsPanel, for the operator', () => {
    it('lists every hostname with its state', () => {
        render(<DomainsPanel {...props} domains={[domain(), domain({ hostname: 'www.acme.com', primary: false, state: 'pending' })]} />)
        const table = within(screen.getByRole('table', { name: 'live addresses' }))
        expect(table.getByText('acme.com')).toBeInTheDocument()
        expect(table.getByText('www.acme.com')).toBeInTheDocument()
        expect(table.getByText('not verified yet')).toBeInTheDocument()
    })

    it('marks which one is the primary, since every other name redirects to it', () => {
        render(<DomainsPanel {...props} domains={[domain(), domain({ hostname: 'www.acme.com', primary: false })]} />)
        expect(screen.getByText(/primary/i)).toBeInTheDocument()
    })

    it('offers to adopt a site that is still served by hand', () => {
        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        expect(screen.getByRole('button', { name: /adopt/i })).toBeInTheDocument()
    })

    it('does not offer to adopt one hostd already serves', () => {
        render(<DomainsPanel {...props} />)
        expect(screen.queryByRole('button', { name: /adopt/i })).toBeNull()
    })

    it('says so plainly when the list could not be read at all', () => {
        render(<DomainsPanel {...props} domains={[]} trouble="hostd did not answer" />)
        expect(screen.getByText(/did not answer/)).toBeInTheDocument()
    })

    // Adoption is a single-shot overwrite of the Apache configuration a live site is being served from,
    // and the confirmation asks the operator to name the project back. Naming the file is not showing it:
    // what hostd's parser reads out of a hand-written vhost is two directives, and everything else it
    // does survives only as the text. If this ever goes back to a path and a hostname list, this fails.
    it('shows the whole file it would replace, verbatim, before the operator confirms', async () => {
        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        const shown = await screen.findByText(/RewriteRule/)
        expect(shown).toHaveTextContent('AuthUserFile /etc/apache2/acme.htpasswd')
        expect(shown.textContent).toBe(HAND_WRITTEN)
        expect(screen.getByText('/etc/apache2/sites-enabled/acme.conf')).toBeInTheDocument()
    })

    it('shows the file even when it is one hostd refuses to adopt, which is when it matters most', async () => {
        adoptPreview.mockResolvedValue({
            ok: true,
            preview: preview({
                adoptable: false,
                claims: [{
                    path: '/etc/apache2/sites-enabled/acme.conf',
                    text: HAND_WRITTEN,
                    names: ['acme.com'],
                    unsupported: ['Use is used, so the hostnames this file serves cannot be read here'],
                }],
            }),
        })

        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        expect((await screen.findByText(/RewriteRule/)).textContent).toBe(HAND_WRITTEN)
        expect(screen.getByText(/cannot be read here/)).toBeInTheDocument()
    })

    // A dangling symlink in sites-enabled fails Apache's own configuration test, and hostd runs that test
    // before every reload, so the adopt this dialog is about will be refused while it is there. Naming it
    // here is the difference between an operator fixing a link and an operator retrying a button.
    it('names a file Apache lists but cannot open, and says it stops the change', async () => {
        adoptPreview.mockResolvedValue({
            ok: true,
            preview: preview({ unreadable: ['/etc/apache2/sites-enabled/010-arbys.horizons.gg.conf'] }),
        })

        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        expect(await screen.findByText(/010-arbys\.horizons\.gg\.conf/)).toBeInTheDocument()
        expect(screen.getByText(/no domain change on this server/i)).toBeInTheDocument()
    })

    // thebackroom.dev's shape: a file with no port 443 block, behind Cloudflare on Flexible. Adopting it
    // switches Flexible SSL on, and the operator is told so before confirming rather than finding a new
    // tick in Settings afterwards.
    it('says adopting will keep port 80 serving the site when the file has no port 443 block', async () => {
        adoptPreview.mockResolvedValue({ ok: true, preview: preview({ flexibleSsl: true }) })

        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        expect(await screen.findByText(/Port 80 will keep serving the site/)).toBeInTheDocument()
    })

    it('says nothing about Flexible SSL for a file that has a port 443 block', async () => {
        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        await screen.findByText(/RewriteRule/)
        expect(screen.queryByText(/Flexible SSL/)).toBeNull()
    })

    it('says nothing about unreadable files when every one of them read', async () => {
        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        await screen.findByText(/RewriteRule/)
        expect(screen.queryByText(/cannot open/i)).toBeNull()
    })

    // hostd makes the first hostname an environment gets its primary, so the add form is open whether or
    // not the environment has one. A new environment gets its address from here.
    it('offers an open add form with no primary, and says the first name becomes the address', () => {
        render(<DomainsPanel {...props} environment="uat1" domains={[]} />)
        expect(screen.getByLabelText(/hostname/i)).toBeEnabled()
        expect(screen.getByText(/first name an environment gets becomes its address/i)).toBeInTheDocument()
    })

    // The Environments tab shows one environment at a time, so the add form adds to that one and offers
    // no other
    it('adds to the environment being viewed, with no choice of another', () => {
        render(<DomainsPanel {...props} environment="uat1" />)
        expect(screen.queryByRole('combobox', { name: 'Add to environment' })).toBeNull()

        fireEvent.change(screen.getByLabelText(/hostname/i), { target: { value: 'uat1.acme.com' } })
        fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
        expect(addDomain).toHaveBeenCalledWith('acme', 'uat1', 'uat1.acme.com')
    })

    // Choosing another environment in the list navigates to this same route, which rerenders rather than
    // remounts. What was typed for one environment must not be sent to the next.
    it('starts the add form over when the environment being viewed changes', () => {
        const { rerender } = render(<DomainsPanel {...props} environment="uat1" />)
        fireEvent.change(screen.getByLabelText(/hostname/i), { target: { value: 'uat1.acme.com' } })
        rerender(<DomainsPanel {...props} environment="uat2" />)
        expect(screen.getByLabelText(/hostname/i)).toHaveValue('')

        fireEvent.change(screen.getByLabelText(/hostname/i), { target: { value: 'uat2.acme.com' } })
        fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
        expect(addDomain).toHaveBeenCalledWith('acme', 'uat2', 'uat2.acme.com')
    })

    // live's main address is changed from Settings now, so the tab shows it and says where
    it('shows live\'s main address with no way to change it here, and points to Settings', () => {
        render(<DomainsPanel {...props} environment="live" />)
        expect(screen.getByRole('region', { name: 'Main address' })).toHaveTextContent('acme.com')
        expect(screen.queryByRole('button', { name: /change the address/i })).toBeNull()
        expect(screen.queryByRole('button', { name: /set the address/i })).toBeNull()
        expect(screen.queryByLabelText(/new address/i)).toBeNull()
        expect(screen.getByText(/Settings tab/)).toBeInTheDocument()
    })

    // Any other environment's main address is set when it is created
    it('shows another environment\'s main address read-only', () => {
        render(<DomainsPanel {...props} environment="uat1" domains={[domain({ hostname: 'uat1.acme.com' })]} />)
        expect(screen.getByRole('region', { name: 'Main address' })).toHaveTextContent('uat1.acme.com')
        expect(screen.queryByRole('button', { name: /change the address/i })).toBeNull()
        expect(screen.queryByRole('button', { name: /set the address/i })).toBeNull()
        expect(screen.queryByText(/Settings tab/)).toBeNull()
    })

    it('says an environment has no main address yet when it has none', () => {
        render(<DomainsPanel {...props} environment="uat1" domains={[]} />)
        expect(screen.getByRole('region', { name: 'Main address' })).toHaveTextContent(/no main address yet/i)
    })

    // The list beside the detail chooses the environment, so there is no dropdown here
    it('draws no environment dropdown of its own', () => {
        render(<DomainsPanel {...props} />)
        expect(screen.queryByRole('combobox', { name: 'Environment' })).toBeNull()
    })
})

// The main address control, which the Domains tab used to draw for every environment. It is kept for
// Settings to draw for live.
describe('PrimaryDomain', () => {
    it('offers to set the address when there is none, and says what that does', () => {
        render(<PrimaryDomain id="acme" environment="live" current={null} />)
        expect(screen.getByRole('button', { name: /set the address/i })).toBeInTheDocument()
        expect(screen.getByText(/adopted/i)).toBeInTheDocument()
    })

    it('offers to change the address once there is one', () => {
        render(<PrimaryDomain id="acme" environment="live" current="acme.com" />)
        expect(screen.getByRole('button', { name: /change the address/i })).toBeInTheDocument()
        expect(screen.getByLabelText(/new address/i)).toBeInTheDocument()
    })

    // Moving a live site off the address it answers on. The dialog has to name what follows and take the
    // new hostname back, the same ceremony adoption uses for the other change a live site notices.
    it('will not change the address until the new hostname is typed back', async () => {
        render(<PrimaryDomain id="acme" environment="live" current="acme.com" />)

        fireEvent.change(screen.getByLabelText(/new address/i), { target: { value: 'shop.acme.com' } })
        fireEvent.click(screen.getByRole('button', { name: /change the address/i }))

        const confirm = await screen.findByLabelText(/type shop\.acme\.com to confirm/i)
        const go = screen.getByRole('button', { name: /^change it$/i })
        expect(go).toBeDisabled()

        fireEvent.change(confirm, { target: { value: 'shop.acme.co' } })
        expect(go).toBeDisabled()

        fireEvent.change(confirm, { target: { value: 'shop.acme.com' } })
        expect(go).toBeEnabled()
        fireEvent.click(go)
        expect(changePrimary).toHaveBeenCalledWith('acme', 'live', 'shop.acme.com', 'shop.acme.com')
    })

    // The four things that follow, in the operator's own words. Without them the dialog is a speed bump
    // rather than a decision.
    it('names what a change does before it happens', async () => {
        render(<PrimaryDomain id="acme" environment="live" current="acme.com" />)
        fireEvent.change(screen.getByLabelText(/new address/i), { target: { value: 'shop.acme.com' } })
        fireEvent.click(screen.getByRole('button', { name: /change the address/i }))

        await screen.findByLabelText(/to confirm/i)
        expect(screen.getByText(/stops being served here/i)).toBeInTheDocument()
        expect(screen.getByText(/starts unverified/i)).toBeInTheDocument()
        expect(screen.getByText(/redirecting to the new address/i)).toBeInTheDocument()
        expect(screen.getByText(/rewritten and reloaded/i)).toBeInTheDocument()
    })
})

describe('DomainsPanel, for a client', () => {
    const asClient = { ...props, isAdmin: false }

    it('says whether the domain is working, in a sentence', () => {
        render(<DomainsPanel {...asClient} />)
        expect(screen.getByText(/working/)).toBeInTheDocument()
    })

    it('shows no table, no ports and no file paths', () => {
        render(<DomainsPanel {...asClient} domains={[domain({ state: 'broken', error: 'x' })]} />)
        expect(screen.queryByRole('table')).toBeNull()
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
    })

    it('offers a client no action at all, because every one of them is the operator\'s', () => {
        render(<DomainsPanel {...asClient} domains={[domain({ state: 'unmanaged' })]} />)
        expect(screen.queryByRole('button')).toBeNull()
    })
})
