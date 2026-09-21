// The strip and the sidebar dot. Both print a reading the server component took, and the thing being
// checked here is what they do with a reading taken while the site is being changed: a restart is a few
// seconds of "down" and a red dot, three seconds after the operator was told the site would be
// unavailable for a few seconds.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const { SiteDot, SiteStats } = await import('./reading')
const { SettlingProvider, useSettling } = await import('./settling')

function Begin() {
    const { begin } = useSettling()
    return <button type="button" onClick={() => begin('restart')}>begin</button>
}

function Panel() {
    return (
        <SettlingProvider state="down">
            <Begin />
            <SiteDot state="down" />
            <SiteStats state="down" services="2" restarts="4" />
        </SettlingProvider>
    )
}

describe('what the page says the site is', () => {
    it('reads it off the server until something is asked of it', () => {
        render(<Panel />)

        expect(screen.getAllByText('down')).toHaveLength(2)
    })

    it('says what is being done to it instead, while it is being done', () => {
        render(<Panel />)

        fireEvent.click(screen.getByRole('button', { name: 'begin' }))

        expect(screen.queryByText('down')).toBeNull()
        expect(screen.getAllByText('restarting')).toHaveLength(2)
    })

    // The counts were taken before the operation and are still what was counted. Only the state is a
    // statement about a site that is halfway through changing.
    it('leaves the figures beside it alone', () => {
        render(<Panel />)

        fireEvent.click(screen.getByRole('button', { name: 'begin' }))

        expect(screen.getByText('2')).toBeInTheDocument()
        expect(screen.getByText('4')).toBeInTheDocument()
    })
})
