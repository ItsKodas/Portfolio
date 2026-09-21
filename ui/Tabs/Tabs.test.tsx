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

    // A tab for something that is designed and not built yet is shown and marked, because a missing tab
    // reads as a product that cannot do the thing and a marked one reads as a product that will.
    describe('a tab that cannot work yet', () => {
        const waiting = [
            { id: 'overview', label: 'Overview' },
            { id: 'deploys', label: 'Deploys', disabled: true },
            { id: 'logs', label: 'Logs' },
        ]

        it('is marked with aria-disabled and never with the disabled attribute', () => {
            render(<Tabs tabs={waiting} selected="overview" onSelect={() => {}} label="Site tools" />)
            const deploys = screen.getByRole('tab', { name: 'Deploys' })
            expect(deploys).toHaveAttribute('aria-disabled', 'true')
            // The whole point. A disabled button cannot be focused, so a keyboard user could never reach
            // the panel explaining why it is off, which defeats showing it at all.
            expect(deploys).not.toHaveAttribute('disabled')
        })

        it('is still reachable by the arrow keys', async () => {
            const onSelect = vi.fn()
            render(<Tabs tabs={waiting} selected="overview" onSelect={onSelect} label="Site tools" />)
            screen.getByRole('tab', { name: 'Overview' }).focus()
            await userEvent.keyboard('{ArrowRight}')
            expect(onSelect).toHaveBeenCalledWith('deploys')
        })

        it('is still selectable, because its panel is the explanation', async () => {
            const onSelect = vi.fn()
            render(<Tabs tabs={waiting} selected="overview" onSelect={onSelect} label="Site tools" />)
            await userEvent.click(screen.getByRole('tab', { name: 'Deploys' }))
            expect(onSelect).toHaveBeenCalledWith('deploys')
        })

        it('takes its turn in the roving tabindex once it is the selected one', () => {
            render(<Tabs tabs={waiting} selected="deploys" onSelect={() => {}} label="Site tools" />)
            expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('tabindex', '0')
        })
    })

    it('has an accessible name for the set', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tablist')).toHaveAccessibleName('Site tools')
    })
})
