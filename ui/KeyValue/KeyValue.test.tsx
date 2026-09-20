import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { KeyValue } from './KeyValue'

describe('KeyValue', () => {
    it('is a description list, so each value stays tied to its key', () => {
        const { container } = render(<KeyValue pairs={[{ key: 'client', value: 'Marcus Ellery' }]} />)
        expect(container.querySelector('dl')).toBeInTheDocument()
        expect(screen.getByText('client').tagName).toBe('DT')
        expect(screen.getByText('Marcus Ellery').tagName).toBe('DD')
    })

    it('renders nothing when there is nothing to say', () => {
        const { container } = render(<KeyValue pairs={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})
