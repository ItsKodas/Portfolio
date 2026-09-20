import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusDot } from './StatusDot'

describe('StatusDot', () => {
    it('says the state in words, because a colour is not readable to everyone', () => {
        render(<StatusDot state="down" />)
        expect(screen.getByText('down')).toBeInTheDocument()
    })

    it('hides the dot itself from assistive technology, since the word carries the meaning', () => {
        const { container } = render(<StatusDot state="up" />)
        expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })
})
