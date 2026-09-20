import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'

describe('Button', () => {
    it('is a real button, so the keyboard works without any help from us', async () => {
        const onClick = vi.fn()
        render(<Button onClick={onClick}>Restart</Button>)
        const button = screen.getByRole('button', { name: 'Restart' })
        button.focus()
        await userEvent.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('defaults to type button, so it never submits a form by accident', () => {
        render(<Button>Restart</Button>)
        expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
    })

    it('can still be a submit button when asked', () => {
        render(<Button type="submit">Save</Button>)
        expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
    })

    it('does not fire when disabled', async () => {
        const onClick = vi.fn()
        render(<Button disabled onClick={onClick}>Stop</Button>)
        await userEvent.click(screen.getByRole('button'))
        expect(onClick).not.toHaveBeenCalled()
    })
})
