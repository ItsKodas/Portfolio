import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Chip } from './Chip'

describe('Chip', () => {
    it('shows its label as text rather than relying on its colour', () => {
        render(<Chip tone="good">on live now</Chip>)
        expect(screen.getByText('on live now')).toBeInTheDocument()
    })
})
