import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

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

describe('Gallery lightbox clicks', () => {
    // The image is drawn object-contain inside a full-screen stage, so its sides (or top and bottom) are empty space.
    // Here the stage is 1000x500 and the image 800x500, so it is drawn from x 100 to 900.
    async function openOnStage() {
        const shots = getProject('voxweave')!.screenshots
        render(<Gallery shots={shots} name="Voxweave" />)
        await userEvent.click(screen.getByRole('button', { name: shots[0].alt }))
        const stage = screen.getByTestId('lightbox-stage')
        const img = stage.querySelector('img')!
        vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 } as DOMRect)
        Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1600 })
        Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1000 })
        return img
    }

    it('closes when the space beside the image is clicked', async () => {
        const img = await openOnStage()
        fireEvent.click(img, { clientX: 50, clientY: 250 })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('stays open when the image itself is clicked', async () => {
        const img = await openOnStage()
        fireEvent.click(img, { clientX: 500, clientY: 250 })
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('closes when the empty bar above the image is clicked, but not from its buttons', async () => {
        await openOnStage()
        await userEvent.click(screen.getByRole('button', { name: 'Next screenshot' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('lightbox-bar'))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
