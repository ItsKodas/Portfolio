import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Tabs } from './Tabs'

const tabs = [
    { id: 'deploys', label: 'Deploys' },
    { id: 'logs', label: 'Logs' },
    { id: 'env', label: 'Environment' },
]

describe('Tabs', () => {
    it('marks the selected tab and only that one', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('aria-selected', 'false')
    })

    it('puts only the selected tab in the tab order, so Tab moves past the set', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('tabindex', '0')
        expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('tabindex', '-1')
    })

    it('moves with the arrow keys', async () => {
        const onSelect = vi.fn()
        render(<Tabs tabs={tabs} selected="logs" onSelect={onSelect} label="Site tools" />)
        screen.getByRole('tab', { name: 'Logs' }).focus()
        await userEvent.keyboard('{ArrowRight}')
        expect(onSelect).toHaveBeenCalledWith('env')
    })

    it('wraps around at both ends', async () => {
        const onSelect = vi.fn()
        render(<Tabs tabs={tabs} selected="deploys" onSelect={onSelect} label="Site tools" />)
        screen.getByRole('tab', { name: 'Deploys' }).focus()
        await userEvent.keyboard('{ArrowLeft}')
        expect(onSelect).toHaveBeenCalledWith('env')
    })

    it('has an accessible name for the set', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tablist')).toHaveAccessibleName('Site tools')
    })
})
