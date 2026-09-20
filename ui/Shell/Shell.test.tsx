import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Shell } from './Shell'

function setup() {
    return render(
        <Shell
            brand="Horizons"
            nav={<button type="button">ASOT</button>}
            rail={<p>the machine</p>}
        >
            <h1>Dashboard</h1>
        </Shell>,
    )
}

describe('Shell', () => {
    it('gives each zone its own landmark', () => {
        setup()
        expect(screen.getByRole('navigation')).toBeInTheDocument()
        expect(screen.getByRole('main')).toBeInTheDocument()
        expect(screen.getByRole('complementary')).toBeInTheDocument()
    })

    it('keeps the rail in the document, since hiding it would lose what it holds', () => {
        // The width at which it moves is a CSS decision no test can see. What a test can hold is that
        // the content is always rendered, so it can never be lost by a breakpoint.
        setup()
        expect(screen.getByText('the machine')).toBeInTheDocument()
    })

    it('opens the drawer from the menu button and says so', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        expect(menu).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(menu)
        expect(menu).toHaveAttribute('aria-expanded', 'true')
    })

    it('closes on Escape and puts focus back on the button that opened it', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        await userEvent.click(menu)
        await userEvent.keyboard('{Escape}')
        expect(menu).toHaveAttribute('aria-expanded', 'false')
        expect(menu).toHaveFocus()
    })

    it('closes when something inside the drawer is chosen', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        await userEvent.click(menu)
        await userEvent.click(screen.getByRole('button', { name: 'ASOT' }))
        expect(menu).toHaveAttribute('aria-expanded', 'false')
    })

    it('omits the rail cleanly when a page has no context to show', () => {
        render(<Shell brand="Horizons" nav={<span />}><p>body</p></Shell>)
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    })
})
