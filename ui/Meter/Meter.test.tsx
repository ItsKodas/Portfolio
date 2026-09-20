import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Meter } from './Meter'

describe('Meter', () => {
    it('reads out as its label and its value, not as a bar', () => {
        render(<Meter label="Backup disk" value="1.31 / 1.44 TB" percent={91} tone="warn" />)
        expect(screen.getByText('Backup disk')).toBeInTheDocument()
        expect(screen.getByText('1.31 / 1.44 TB')).toBeInTheDocument()
    })

    it('hides the bar itself, because the value beside it already says everything', () => {
        const { container } = render(<Meter label="Memory" value="19.4 / 32 GB" percent={61} />)
        expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('clamps a percentage that arrives outside nought to a hundred', () => {
        // A disk that reports 104% should draw a full bar, not one that overflows its track
        const { container } = render(<Meter label="Disk" value="over" percent={104} />)
        const fill = container.querySelector('[data-fill]') as HTMLElement
        expect(fill.style.width).toBe('100%')
    })

    it('shows a note when there is one, so a threshold can explain itself', () => {
        render(<Meter label="Backup disk" value="91%" percent={91} threshold={90} note="over the 90% line" noteTone="warn" />)
        expect(screen.getByText('over the 90% line')).toBeInTheDocument()
    })
})
