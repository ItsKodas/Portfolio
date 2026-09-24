// The panel is an async server component, which the page's own test cannot resolve inside a rendered
// tree: React's client renderer hands back a promise where the element should be. Awaiting the component
// itself is what a test can do, and it is enough, because everything this panel decides it decides
// before it returns.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const listDeploys = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/deploys', () => ({ listDeploys: (...args: unknown[]) => listDeploys(...args) }))
// The three server actions are round trips this panel never makes while rendering, and importing them
// for real would drag Prisma and next/cache into a jsdom test for nothing.
vi.mock('./actions', () => ({
    deployAction: async () => ({ ok: true, message: 'ok' }),
    rollbackAction: async () => ({ ok: true, message: 'ok' }),
    setBranchAction: async () => ({ ok: true, message: 'ok' }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

const { DeployPanel } = await import('./deployPanel')

const admin = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }
const client = { caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }

const live = { name: 'live' as const, branch: 'main', domain: null, certificate: null, deployed: null }
const test = { name: 'test' as const, branch: 'next', domain: null, certificate: null, deployed: null }

const record = (over: Record<string, unknown> = {}) => ({
    commit: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
    subject: 'Fix the booking form',
    actor: 'hostd',
    trigger: 'poll',
    startedAt: '2026-09-21T11:06:00.000Z',
    durationMs: 74_000,
    outcome: 'ok',
    reason: null,
    output: null,
    ...over,
})

const history = (over: Record<string, unknown> = {}) => ({
    ok: true,
    value: {
        environment: 'live',
        branch: 'main',
        deployed: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3',
        paused: false,
        consecutiveFailures: 0,
        deploys: [record()],
        ...over,
    },
})

const panel = (over: Record<string, unknown> = {}) =>
    DeployPanel({ id: 'asot', environments: [live], environment: 'live', enabled: true, ...over } as never)

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue(admin)
    listDeploys.mockResolvedValue(history())
})

describe('the deploy history, for the operator', () => {
    it('shows each deploy with its commit, what it was and how it went', async () => {
        render(await panel())

        expect(screen.getByText('Fix the booking form')).toBeInTheDocument()
        expect(screen.getByText('deployed')).toBeInTheDocument()
        expect(screen.getByText('1m 14s')).toBeInTheDocument()
        // Twice: what this environment is serving, and the row that put it there
        expect(screen.getAllByText('5f0ac31')).toHaveLength(2)
    })

    it('asks about the environment it was given, not always live', async () => {
        render(await panel({ environments: [live, test], environment: 'test' }))

        expect(listDeploys.mock.calls[0][3]).toBe('test')
    })

    it('offers a switcher only when there is more than one environment', async () => {
        const { unmount } = render(await panel())
        expect(screen.queryByRole('combobox', { name: 'Environment' })).toBeNull()
        unmount()

        render(await panel({ environments: [live, test], environment: 'test' }))
        expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('test')
    })

    it('will not offer a rollback with nowhere to go back to', async () => {
        // hostd refuses one outright when no earlier deploy was healthy, so the button says so here
        // rather than spending a request to be told.
        render(await panel())

        expect(screen.getByRole('button', { name: 'Roll back' })).toBeDisabled()
    })

    it('offers one when an earlier deploy is there to go back to', async () => {
        listDeploys.mockResolvedValue(history({
            deploys: [record(), record({ commit: 'aaaaaaabbbb', startedAt: '2026-09-20T11:06:00.000Z' })],
        }))

        render(await panel())

        expect(screen.getByRole('button', { name: 'Roll back' })).toBeEnabled()
    })

    it('says a paused branch is paused, and what starts it again', async () => {
        listDeploys.mockResolvedValue(history({ paused: true, consecutiveFailures: 3 }))

        render(await panel())

        expect(screen.getByRole('alert')).toHaveTextContent(/stopped polling this branch/)
        expect(screen.getByRole('alert')).toHaveTextContent(/starts it again/)
    })

    it('keeps the output of a failure behind a summary rather than in the list', async () => {
        listDeploys.mockResolvedValue(history({
            deploys: [record({ outcome: 'failed', reason: 'npm run build exited 1', output: 'Type error on line 4' })],
        }))

        render(await panel())

        expect(screen.getByText('failed')).toBeInTheDocument()
        expect(screen.getByText('npm run build exited 1')).toBeInTheDocument()
        expect(screen.getByText(/Show what it printed/)).toBeInTheDocument()
    })

    it('marks a rolled-back deploy as its own thing, not as a failure', async () => {
        // It landed, failed its health check and was put back before anyone saw it. The site never
        // stopped serving, so it is amber and not red.
        listDeploys.mockResolvedValue(history({ deploys: [record({ outcome: 'rolled-back' })] }))

        render(await panel())

        expect(screen.getByText('rolled back')).toBeInTheDocument()
    })

    it('says so when hostd would not answer, rather than drawing an empty history', async () => {
        // An empty list reads as a site that has never been deployed, which is a different thing.
        listDeploys.mockResolvedValue({ ok: false, code: 'agent-unavailable', message: 'the agent is not answering' })

        render(await panel())

        expect(screen.getByRole('alert')).toHaveTextContent(/not answering/)
        expect(screen.queryByRole('button', { name: 'Deploy now' })).toBeNull()
    })

    it('has something to say about a site that has never been deployed', async () => {
        listDeploys.mockResolvedValue(history({ deploys: [], deployed: null }))

        render(await panel())

        expect(screen.getByText(/Nothing has been deployed yet/)).toBeInTheDocument()
    })
})

describe('the same tab, for the client whose site it is', () => {
    beforeEach(() => callerFromSession.mockResolvedValue(client))

    it('shows the days their site was updated, and nothing else', async () => {
        listDeploys.mockResolvedValue(history({
            deploys: [record(), record({ commit: 'bbbbbbb', outcome: 'failed', subject: 'Broken build' })],
        }))

        render(await panel())

        expect(screen.getByText('21 September 2026')).toBeInTheDocument()
        expect(screen.queryByText('Broken build')).toBeNull()
        expect(screen.queryByText('5f0ac31')).toBeNull()
    })

    it('gives them nothing to press: deploying is not theirs to do', async () => {
        render(await panel())

        expect(screen.queryByRole('button', { name: 'Deploy now' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Change branch' })).toBeNull()
    })

    it('never puts the words hostd used in front of them', async () => {
        listDeploys.mockResolvedValue({ ok: false, code: 'failed', message: '/var/www/asot/live is not a git worktree' })

        render(await panel())

        expect(screen.queryByText(/var\/www/)).toBeNull()
        expect(screen.getByRole('alert')).toBeInTheDocument()
    })
})
