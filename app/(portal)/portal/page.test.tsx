// The whole point of gathering the page's data behind a result type is that the page still draws when
// hostd is unreachable. gatherHome is tested on its own; this renders the real page component over the
// real ui/ components, because a page that throws at request time passes every one of those tests.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listProjects = vi.fn()
const getHealth = vi.fn()
const callerFromSession = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/projects', () => ({ listProjects: (...args: unknown[]) => listProjects(...args) }))
vi.mock('@/server/hostd/health', () => ({ getHealth: (...args: unknown[]) => getHealth(...args) }))

const { default: PortalHome } = await import('./page')

const service = (state: string) => ({
    service: 'asot-web',
    role: 'site' as const,
    state,
    health: null,
    startedAt: null,
    restartCount: null,
    image: null,
})

const system = (over: Record<string, unknown> = {}) => ({
    memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 19 * 1024 ** 3, availableBytes: 13 * 1024 ** 3 },
    cpu: { cores: 8, load1: 2.11, load5: 1.84, load15: 1.62 },
    disk: { path: '/', totalBytes: 1024 ** 4, usedBytes: 512 * 1024 ** 3, freeBytes: 500 * 1024 ** 3 },
    problems: [],
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null })
    listProjects.mockResolvedValue({ ok: true, value: [] })
    getHealth.mockResolvedValue({ ok: true, value: { warnings: [], invalid: {}, system: system() } })
})

describe('the portal home', () => {
    it('draws itself when hostd is not answering, rather than throwing', async () => {
        listProjects.mockResolvedValue({ ok: false, code: 'unavailable', message: 'hostd is not answering' })

        render(await PortalHome())

        // A warn callout is an alert, so this is the announcement a screen reader gets too
        expect(screen.getByRole('alert')).toHaveTextContent(/not answering/i)
        expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
        expect(screen.getByText('Nothing to show while hostd is unreachable.')).toBeInTheDocument()
    })

    it('says a figure it could not take is not available, rather than zero', async () => {
        getHealth.mockResolvedValue({
            ok: true,
            value: {
                warnings: [],
                invalid: {},
                system: system({ memory: null, cpu: null, disk: null, problems: ['/proc/meminfo was not readable'] }),
            },
        })

        render(await PortalHome())

        expect(screen.getAllByText('not available')).toHaveLength(3)
        expect(screen.getByText(/proc\/meminfo/)).toBeInTheDocument()
        // The lie this is guarding against: an unread figure and a figure that is genuinely nothing look
        // the same once both are printed as 0.
        expect(screen.queryByText('0%')).toBeNull()
    })

    it('keeps the loads when hostd could not count the cores, and draws no bar for them', async () => {
        getHealth.mockResolvedValue({
            ok: true,
            value: { warnings: [], invalid: {}, system: system({ cpu: { cores: 0, load1: 2.11, load5: 1.84, load15: 1.62 } }) },
        })

        render(await PortalHome())

        expect(screen.getByText('load 2.11, 1.84, 1.62, cores not counted')).toBeInTheDocument()
        expect(screen.queryByText('CPU')).toBeNull()
    })

    it('reads a site state from the status hostd actually sends on a list', async () => {
        listProjects.mockResolvedValue({
            ok: true,
            value: [
                { id: 'asot', name: 'ASOT', valid: true, status: { ok: true, services: [service('exited')] } },
                { id: 'pmpc', name: 'PMPC', valid: true, status: { ok: true, services: [service('running')] } },
            ],
        })

        render(await PortalHome())

        expect(screen.getByText('1 site is down.')).toBeInTheDocument()
        // Both the nav entry and the row carry a dot, so each state appears twice. "down" appears a third
        // time as the key of the stat counting them.
        expect(screen.getAllByText('down')).toHaveLength(3)
        expect(screen.getAllByText('up')).toHaveLength(2)
    })

    it('keeps a project whose containers hostd could not read, with the reason beside it', async () => {
        listProjects.mockResolvedValue({
            ok: true,
            value: [{ id: 'asot', name: 'ASOT', valid: true, status: { ok: false, code: 'failed', message: 'docker did not answer' } }],
        })

        render(await PortalHome())

        expect(screen.getByText('docker did not answer')).toBeInTheDocument()
    })

    it('tells a client nothing about the machine, or about which setting is missing', async () => {
        callerFromSession.mockResolvedValue({
            caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' },
            clientId: 'cl_8F2K1ABC',
        })
        listProjects.mockResolvedValue({ ok: false, code: 'unavailable', message: 'hostd is not answering' })

        render(await PortalHome())

        expect(screen.getByRole('alert')).toHaveTextContent('This is temporarily unavailable.')
        expect(screen.queryByText(/hostd is not answering/)).toBeNull()
        expect(screen.queryByText('the machine')).toBeNull()
        // Asking for it at all would only earn a refusal to throw away, so the page does not
        expect(getHealth).not.toHaveBeenCalled()
    })
})
