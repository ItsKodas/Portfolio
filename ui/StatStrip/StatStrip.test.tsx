import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatStrip } from './StatStrip'

const stats = [
    { key: 'sites', value: '5', note: 'one down, two flagged' },
    { key: 'backup disk', value: '91%', note: 'over the line at 90', tone: 'crit' as const },
]

describe('StatStrip', () => {
    it('pairs every figure with what it counts', () => {
        render(<StatStrip stats={stats} />)
        // A list of bare numbers is not information; each one is a term and its description
        expect(screen.getByText('sites')).toBeInTheDocument()
        expect(screen.getByText('5')).toBeInTheDocument()
        expect(screen.getByText('91%')).toBeInTheDocument()
    })

    it('is a description list, so the pairing survives without the layout', () => {
        const { container } = render(<StatStrip stats={stats} />)
        expect(container.querySelector('dl')).toBeInTheDocument()
        expect(container.querySelectorAll('dt')).toHaveLength(2)
    })

    it('renders nothing at all rather than an empty rule when given no figures', () => {
        const { container } = render(<StatStrip stats={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})
