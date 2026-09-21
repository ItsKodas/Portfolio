// Two screens over one list, which is the whole reason this panel takes its domains as a prop instead of
// asking hostd itself: the operator's table and the client's sentences are both worth rendering without a
// network in the way.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { adoptPreview } = vi.hoisted(() => ({ adoptPreview: vi.fn() }))

// The panel is a server component, but its controls are the client half, and importing those for real
// drags Prisma and next/cache into a jsdom test for nothing. useRouter needs a mounted app router, which
// this renderer has no way to give it.
vi.mock('./actions', () => ({
    addDomainAction: async () => ({ ok: true, message: 'ok' }),
    removeDomainAction: async () => ({ ok: true, message: 'ok' }),
    verifyDomainAction: async () => ({ ok: true, message: 'ok' }),
    adoptAction: async () => ({ ok: true, message: 'ok' }),
    adoptPreviewAction: (...args: unknown[]) => adoptPreview(...args),
    setPrimaryDomainAction: async () => ({ ok: true, message: 'ok' }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

import type { AdoptPreview, Domain } from '@/server/hostd/domains'
import { DomainsPanel } from './domainsPanel'

const domain = (over: Partial<Domain> = {}): Domain => ({
    hostname: 'acme.com', primary: true, state: 'active', certificate: 'cloudflare-origin',
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null, ...over,
})

const props = {
    id: 'acme', environment: 'live' as const, projectName: 'Acme Bakery',
    environments: [{ name: 'live' as const }, { name: 'test' as const }],
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
        unsupported: null,
    }],
    extraNames: [],
    adoptable: true,
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    adoptPreview.mockResolvedValue({ ok: true, preview: preview() })
})

describe('DomainsPanel, for the operator', () => {
    it('lists every hostname with its state', () => {
        render(<DomainsPanel {...props} domains={[domain(), domain({ hostname: 'www.acme.com', primary: false, state: 'pending' })]} />)
        expect(screen.getByText('acme.com')).toBeInTheDocument()
        expect(screen.getByText('www.acme.com')).toBeInTheDocument()
        expect(screen.getByText('waiting for DNS')).toBeInTheDocument()
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
                    unsupported: 'Use is used, so the hostnames this file serves cannot be read here',
                }],
            }),
        })

        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        fireEvent.click(screen.getByRole('button', { name: /adopt/i }))

        expect((await screen.findByText(/RewriteRule/)).textContent).toBe(HAND_WRITTEN)
        expect(screen.getByText(/cannot be read here/)).toBeInTheDocument()
    })

    // Every site on the dedi was enrolled by hand and has no address at all, so this is the tab's first
    // interaction for all of them. The alias box could only ever answer "it has no domain, so it cannot
    // have aliases", which is the dead end this replaces.
    it('offers the address form, and not the alias form, when the environment has no primary', () => {
        render(<DomainsPanel {...props} domains={[]} />)
        expect(screen.getByRole('button', { name: /set the address/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^add$/i })).toBeNull()
        expect(screen.queryByLabelText(/hostname/i)).toBeNull()
    })

    it('says what setting the address does, since nothing is served from it until the site is adopted', () => {
        render(<DomainsPanel {...props} domains={[]} />)
        expect(screen.getByText(/adopted/i)).toBeInTheDocument()
    })

    // Changing an address is out of scope on purpose: it rewrites the vhost and invalidates verification
    // for every name on it, so hostd refuses it and the form is not offered a second time.
    it('offers the alias form, and no address form, once a primary exists', () => {
        render(<DomainsPanel {...props} />)
        expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /set the address/i })).toBeNull()
    })

    it('keeps the environment selector, because a domain belongs to an environment', () => {
        render(<DomainsPanel {...props} />)
        // Whatever DeployPanel renders its strip with, not a second strip invented here: match its
        // markup and assert the other environment is reachable, not which ARIA role it carries.
        expect(screen.getByText(/test/i)).toBeInTheDocument()
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
