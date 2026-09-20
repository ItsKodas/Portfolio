import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Row } from './Row'

describe('Row', () => {
    it('is a plain element when it does nothing', () => {
        render(<Row title="asot-db" aside="up, mongodb 7.0" />)
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        expect(screen.getByText('asot-db')).toBeInTheDocument()
    })

    it('is a real button when it does something, so the keyboard reaches it', async () => {
        const onClick = vi.fn()
        render(<Row title="ASOT is down" onClick={onClick} />)
        const row = screen.getByRole('button', { name: /ASOT is down/ })
        row.focus()
        await userEvent.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('puts every part into the accessible name of a clickable row', () => {
        render(<Row title="ASOT" sub="asot.com.au" aside="down" meta="8m" onClick={() => {}} />)
        // A row read out as "ASOT" alone tells a screen reader user nothing about why it matters
        expect(screen.getByRole('button')).toHaveAccessibleName('ASOT asot.com.au down 8m')
    })

    it('carries its tone as a class rather than as the only signal', () => {
        const { container } = render(<Row title="ASOT is down" tone="crit" aside="down" />)
        expect(container.firstElementChild?.className).toMatch(/crit/)
        // the word is present too, so colour is never doing the work alone
        expect(screen.getByText('down')).toBeInTheDocument()
    })
})
