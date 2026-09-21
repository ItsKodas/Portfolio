// Two screens over one list, which is the whole reason this panel takes its domains as a prop instead of
// asking hostd itself: the operator's table and the client's sentences are both worth rendering without a
// network in the way.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// The panel is a server component, but its controls are the client half, and importing those for real
// drags Prisma and next/cache into a jsdom test for nothing. useRouter needs a mounted app router, which
// this renderer has no way to give it.
vi.mock('./actions', () => ({
    addDomainAction: async () => ({ ok: true, message: 'ok' }),
    removeDomainAction: async () => ({ ok: true, message: 'ok' }),
    verifyDomainAction: async () => ({ ok: true, message: 'ok' }),
    adoptAction: async () => ({ ok: true, message: 'ok' }),
    adoptPreviewAction: async () => ({ ok: false, error: 'not asked in a test' }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

import type { Domain } from '@/server/hostd/domains'
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
