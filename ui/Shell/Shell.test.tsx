import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Shell } from './Shell'
// The generated name, so the assertion below holds through a rename of the class itself
import styles from './Shell.module.css'

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

    // The three zones fill the window, so a page that is one panel rather than a column of blocks can
    // hand that panel the height left over. jsdom lays nothing out, so what a test can hold is that the
    // prop reaches the element that has to carry it; whether it then fills is a browser question.
    it('gives the content column the leftover height only when the page asks for it', () => {
        const { container } = render(<Shell brand="Horizons" nav={<span />} fill><p>body</p></Shell>)
        expect(container.querySelector('main')).toHaveClass(styles.fill)
    })

    it('leaves a page that is a column of blocks alone', () => {
        const { container } = render(<Shell brand="Horizons" nav={<span />}><p>body</p></Shell>)
        expect(container.querySelector('main')).not.toHaveClass(styles.fill)
    })
})
