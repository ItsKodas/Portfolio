import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('the ui test project', () => {
    it('renders a component and can assert on the document', () => {
        render(<button type="button">Press me</button>)
        expect(screen.getByRole('button', { name: 'Press me' })).toBeInTheDocument()
    })
})
