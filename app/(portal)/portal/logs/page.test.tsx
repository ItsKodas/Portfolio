// The Logs pages over the real ui/ components, with the database stood in for. What matters here is that a
// row reads as who, what, when and where, and that an email opens whole.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const events = vi.fn()
const emails = vi.fn()
const email = vi.fn()
const requireAdmin = vi.fn()

vi.mock('@/server/auth', () => ({ requireAdmin: () => requireAdmin(), signOut: vi.fn() }))
vi.mock('@/server/db', () => ({ getDb: () => ({}) }))
vi.mock('@/server/audit/read', async importOriginal => ({
    ...(await importOriginal<typeof import('@/server/audit/read')>()),
    auditRepo: () => ({
        events: (...args: unknown[]) => events(...args),
        actors: async () => [{ value: 'cl_ABCD1234', label: 'Ann (Acme) · cl_ABCD1234' }],
        sites: async () => ['asot'],
        emails: (...args: unknown[]) => emails(...args),
        email: (...args: unknown[]) => email(...args),
    }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/portal/logs', notFound: () => { throw new Error('not found') } }))

const { default: ActivityLog } = await import('./page')
const { default: SentEmails } = await import('./emails/page')
const { default: SentEmail } = await import('./emails/[id]/page')

const at = new Date('2026-10-10T04:00:00Z')

beforeEach(() => {
    vi.clearAllMocks()
    requireAdmin.mockResolvedValue({ user: { email: 'koda@horizons.gg' } })
})

describe('the activity log', () => {
    it('shows who did what, when and to which site, with its detail behind a disclosure', async () => {
        events.mockResolvedValue({
            more: true,
            rows: [{
                id: 'e1', createdAt: at, kind: 'site.restart', actorType: 'CLIENT', actorId: 'cl_ABCD1234', actorName: 'Ann (Acme)',
                site: 'asot', targetType: null, targetId: null, targetName: null, summary: 'Restarted asot', detail: { why: 'stuck' },
            }],
        })

        render(await ActivityLog({ searchParams: Promise.resolve({ type: 'site', page: '2' }) }))

        expect(events).toHaveBeenCalledWith({ category: 'site', actor: null, site: null, page: 2 })
        const row = within(screen.getByRole('table', { name: 'Activity' })).getAllByRole('row')[1]
        expect(row).toHaveTextContent('Ann (Acme)')
        expect(row).toHaveTextContent('Client')
        expect(row).toHaveTextContent('Site restarted')
        expect(row).toHaveTextContent('Restarted asot')
        expect(within(row).getByRole('link', { name: 'asot' })).toHaveAttribute('href', '/portal/sites/asot')
        expect(row).toHaveTextContent('"why": "stuck"')
        expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute('href', '/portal/logs?type=site&page=3')
        expect(screen.getByRole('link', { name: 'Newer' })).toHaveAttribute('href', '/portal/logs?type=site')
    })

    it('says when nothing matches the filters', async () => {
        events.mockResolvedValue({ rows: [], more: false })
        render(await ActivityLog({ searchParams: Promise.resolve({ site: 'asot' }) }))
        expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument()
    })
})

describe('the sent emails', () => {
    it('lists each one with whether it went', async () => {
        emails.mockResolvedValue({
            more: false,
            rows: [
                { id: 'm1', createdAt: at, to: 'ann@example.com', subject: 'Your invite', error: null },
                { id: 'm2', createdAt: at, to: 'bob@example.com', subject: 'Reset', error: '550 no such user' },
            ],
        })

        render(await SentEmails({ searchParams: Promise.resolve({}) }))

        expect(screen.getByRole('link', { name: 'Your invite' })).toHaveAttribute('href', '/portal/logs/emails/m1')
        const [, sent, refused] = within(screen.getByRole('table', { name: 'Emails' })).getAllByRole('row')
        expect(sent).toHaveTextContent('Sent')
        expect(refused).toHaveTextContent('Not sent')
    })

    it('opens one whole, in a frame that runs nothing', async () => {
        email.mockResolvedValue({
            id: 'm1', createdAt: at, from: 'Horizons <hello@horizons.gg>', to: 'ann@example.com', replyTo: 'koda@horizons.gg',
            subject: 'Your invite', text: 'Set it at /portal/invite/[token removed]', html: '<p>Hello</p>', error: null,
        })

        render(await SentEmail({ params: Promise.resolve({ id: 'm1' }) }))

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your invite')
        expect(screen.getByText('ann@example.com')).toBeInTheDocument()
        expect(screen.getByText(/Set it at/)).toBeInTheDocument()
        expect(screen.getByText(/one-time token/)).toBeInTheDocument()
        const frame = screen.getByTitle('Your invite')
        expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
        expect(frame).toHaveAttribute('srcdoc', '<p>Hello</p>')
    })
})
