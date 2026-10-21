import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { getProject } from '@/app/showcase/projects'

import { Gallery } from './Gallery'

describe('Gallery', () => {
    it('opens a shot in the lightbox and moves with the arrow keys, wrapping', async () => {
        const shots = getProject('voxweave')!.screenshots
        render(<Gallery shots={shots} name="Voxweave" />)
        await userEvent.click(screen.getByRole('button', { name: shots[1].alt }))
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Voxweave screenshot 2 of 6')
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Voxweave screenshot 6 of 6')
    })

    it('closes from its close button', async () => {
        const shots = getProject('voxweave')!.screenshots
        render(<Gallery shots={shots} name="Voxweave" />)
        await userEvent.click(screen.getByRole('button', { name: shots[0].alt }))
        await userEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})

describe('Gallery posters', () => {
    it('shows a store poster whole, without a phone frame around it', () => {
        const shots = getProject('tax-assistant')!.screenshots
        const poster = shots.find(s => s.device === 'poster')!
        render(<Gallery shots={shots} name="Tax Assistant" />)
        const img = screen.getByRole('img', { name: poster.alt })
        expect(img).toHaveClass('object-contain')
        expect(img.closest('[data-phone-frame]')).toBeNull()
    })
})
