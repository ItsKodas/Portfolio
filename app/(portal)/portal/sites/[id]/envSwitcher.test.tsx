import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (...args: unknown[]) => push(...args), refresh: () => {} }) }))

const { EnvSwitcher } = await import('./envSwitcher')

const three = [{ name: 'live' }, { name: 'test' }, { name: 'uat1' }]

beforeEach(() => vi.clearAllMocks())

describe('EnvSwitcher', () => {
    it('is not drawn for a site with one environment', () => {
        const { container } = render(<EnvSwitcher id="acme" tab="deploys" environments={[{ name: 'live' }]} chosen="live" />)
        expect(container).toBeEmptyDOMElement()
    })

    it('is a dropdown of every environment, showing the one being viewed', () => {
        render(<EnvSwitcher id="acme" tab="deploys" environments={three} chosen="test" />)
        const select = screen.getByRole('combobox', { name: 'Environment' })
        expect(select).toHaveValue('test')
        expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['live', 'test', 'uat1'])
    })

    it('goes to the same tab for the environment chosen', () => {
        render(<EnvSwitcher id="acme" tab="domains" environments={three} chosen="live" />)
        fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'uat1' } })
        expect(push).toHaveBeenCalledWith('/portal/sites/acme?tab=domains&env=uat1', { scroll: false })
    })
})
