import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusDot } from './StatusDot'
import styles from './StatusDot.module.css'

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

describe('StatusDot, bare', () => {
    it('carries the word as the dot\'s title, so hovering says what the colour means', () => {
        const { container } = render(<StatusDot state="stopped" bare />)
        expect(container.querySelector('[aria-hidden="true"]')).toHaveAttribute('title', 'stopped')
    })

    it('keeps the word in the document, hidden from sight rather than removed', () => {
        render(<StatusDot state="down" bare />)
        expect(screen.getByText('down')).toHaveClass(styles.hidden)
    })
})
