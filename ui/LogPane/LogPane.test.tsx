import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LogPane } from './LogPane'
// The generated name, so the assertion below holds through a rename of the class itself
import styles from './LogPane.module.css'

const lines = [
    { time: '21:13:58', text: 'Ready on http://0.0.0.0:3000' },
    { time: '21:14:11', text: 'exited with code 137', stream: 'err' as const },
]

describe('LogPane', () => {
    it('is reachable and scrollable by keyboard, with a name saying what it holds', () => {
        // A scrollable region that cannot be focused is unreachable without a mouse. This is the
        // obligation most easily missed, and the reason this component exists at all.
        render(<LogPane lines={lines} label="asot-web log" />)
        const pane = screen.getByRole('region', { name: 'asot-web log' })
        expect(pane).toHaveAttribute('tabindex', '0')
    })

    it('shows every line with its time', () => {
        render(<LogPane lines={lines} label="asot-web log" />)
        expect(screen.getByText('Ready on http://0.0.0.0:3000')).toBeInTheDocument()
        expect(screen.getByText('21:14:11')).toBeInTheDocument()
    })

    it('does not announce every arriving line', () => {
        // A following log is a firehose. Making it a live region would read the whole thing aloud.
        const { container } = render(<LogPane lines={lines} label="asot-web log" following />)
        expect(container.querySelector('[aria-live]')).not.toBeInTheDocument()
    })

    it('says so when there is nothing yet, rather than showing an empty box', () => {
        render(<LogPane lines={[]} label="asot-web log" />)
        expect(screen.getByText(/nothing yet/i)).toBeInTheDocument()
    })

    // Its own height is the whole point of the component: 290px in a page that scrolls as a document,
    // and whatever is left over in a page whose frame has fixed the height. Only the wiring is testable
    // here, since jsdom has no layout to measure.
    it('takes the height it is given when the page has room to give', () => {
        render(<LogPane lines={lines} label="asot-web log" fill />)
        expect(screen.getByRole('region', { name: 'asot-web log' })).toHaveClass(styles.fill)
    })

    it('keeps its own box otherwise', () => {
        render(<LogPane lines={lines} label="asot-web log" />)
        expect(screen.getByRole('region', { name: 'asot-web log' })).not.toHaveClass(styles.fill)
    })
})
