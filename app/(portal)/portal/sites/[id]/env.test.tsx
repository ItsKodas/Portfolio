// The Env files section of the Environments tab reads and writes whichever environment is chosen, not always live. The panel is an
// async server component, so the test awaits it and renders what it returns, as deployPanel.test does.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerFromSession = vi.fn()
const listEnvFiles = vi.fn()
const readEnvFile = vi.fn()
const saveEnvAction = vi.fn()

vi.mock('@/server/hostd/session', () => ({ callerFromSession: () => callerFromSession() }))
vi.mock('@/server/hostd/env', async importOriginal => ({
    ...(await importOriginal<typeof import('@/server/hostd/env')>()),
    listEnvFiles: (...args: unknown[]) => listEnvFiles(...args),
    readEnvFile: (...args: unknown[]) => readEnvFile(...args),
}))
vi.mock('./actions', () => ({ saveEnvAction: (...args: unknown[]) => saveEnvAction(...args) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))

const { EnvPanel } = await import('./env')

const admin = { caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }

beforeEach(() => {
    vi.clearAllMocks()
    process.env.HOSTD_URL = 'http://hostd-api:8080'
    process.env.HOSTD_API_TOKEN = 'a'.repeat(32)
    callerFromSession.mockResolvedValue(admin)
    listEnvFiles.mockResolvedValue({ ok: true, value: [{ path: '.env', example: null, bytes: 12 }] })
    readEnvFile.mockResolvedValue({ ok: true, value: 'A=1\n' })
    saveEnvAction.mockResolvedValue({ ok: true, message: 'Saved.' })
})

describe('the Env files section', () => {
    it('lists, reads and saves the environment chosen, round trip', async () => {
        render(await EnvPanel({ id: 'acme', file: '.env', environment: 'uat1' }))

        expect(listEnvFiles.mock.calls[0][3]).toBe('uat1')
        expect(readEnvFile.mock.calls[0][3]).toBe('uat1')
        expect(readEnvFile.mock.calls[0][4]).toBe('.env')

        // A file link keeps the environment, so opening one does not fall back to live
        expect(screen.getByRole('link', { name: /\.env/ })).toHaveAttribute('href', '/portal/sites/acme?tab=environments&env=uat1&file=.env')

        fireEvent.change(screen.getByLabelText('.env'), { target: { value: 'A=2\n' } })
        fireEvent.click(screen.getByRole('button', { name: /save and restart/i }))
        expect(saveEnvAction).toHaveBeenCalledWith('acme', 'uat1', '.env', 'A=2\n')
    })

    // The list beside it chooses the environment, so it draws no dropdown of its own
    it('draws no environment dropdown', async () => {
        render(await EnvPanel({ id: 'acme', file: null, environment: 'uat1' }))
        expect(screen.queryByRole('combobox', { name: 'Environment' })).toBeNull()
    })

    it('draws nothing for a client', async () => {
        callerFromSession.mockResolvedValue({ caller: { actor: 'client:c1', user: 'c1' }, clientId: 'c1' })
        expect(await EnvPanel({ id: 'acme', file: null, environment: 'uat1' })).toBeNull()
        expect(listEnvFiles).not.toHaveBeenCalled()
    })

    it('names the environment it is showing', async () => {
        render(await EnvPanel({ id: 'acme', file: null, environment: 'uat1' }))
        expect(screen.getByRole('heading', { name: 'uat1' })).toBeInTheDocument()
    })
})
