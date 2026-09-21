// What the page knows while a site is between states. The whole point of it is the waiting: a restart
// reads as a site that is down for a few seconds, and everything on the page that reports a reading was
// reporting that as news. These are the parts a clock can hold.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SiteState } from '../../siteState'

const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))

const { SettlingProvider, useSettling } = await import('./settling')

function Inside() {
    const { settling, gaveUp, begin } = useSettling()
    return (
        <>
            <button type="button" onClick={() => begin('restart')}>ask restart</button>
            <button type="button" onClick={() => begin('stop')}>ask stop</button>
            <p>{settling ? `settling ${settling.action}` : 'idle'}</p>
            {gaveUp && <p>gave up</p>}
        </>
    )
}

function Probe({ state }: { state: SiteState }) {
    return (
        <SettlingProvider state={state}>
            <Inside />
        </SettlingProvider>
    )
}

function wait(ms: number) {
    act(() => { vi.advanceTimersByTime(ms) })
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('waiting for a site to settle', () => {
    it('knows nothing outside a provider, rather than throwing', () => {
        render(<Inside />)

        expect(screen.getByText('idle')).toBeInTheDocument()
        // begin does nothing here, and the thing that matters is that it can be called at all: the Logs
        // tab renders the log on its own, with no lifecycle controls above it and no provider around it.
        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        expect(screen.getByText('idle')).toBeInTheDocument()
    })

    // The reason there is a floor at all. hostd still reports the containers as running for the moment
    // between the call returning and Docker tearing them down, so the first reading after a restart looks
    // exactly like a finished one.
    it('does not end a restart on the reading taken before it began', () => {
        render(<Probe state="up" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        wait(3000)

        expect(screen.getByText('settling restart')).toBeInTheDocument()
    })

    it('ends once the floor has passed and the site is back up', () => {
        const { rerender } = render(<Probe state="up" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        // Down, as a restart reads halfway through, then up again
        rerender(<Probe state="down" />)
        wait(9000)
        expect(screen.getByText('settling restart')).toBeInTheDocument()

        rerender(<Probe state="up" />)
        wait(3000)

        expect(screen.getByText('idle')).toBeInTheDocument()
    })

    it('waits for stopped rather than for up when that is where it was going', () => {
        const { rerender } = render(<Probe state="up" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask stop' }))
        wait(9000)
        expect(screen.getByText('settling stop')).toBeInTheDocument()

        rerender(<Probe state="stopped" />)
        wait(3000)

        expect(screen.getByText('idle')).toBeInTheDocument()
    })

    // A state nobody could read is the middle of the operation, not the end of it: hostd refusing a
    // status read while the containers are swapping is exactly when this is waiting.
    it('keeps waiting while the containers cannot be read', () => {
        const { rerender } = render(<Probe state="up" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        rerender(<Probe state="unknown" />)
        wait(20000)

        expect(screen.getByText('settling restart')).toBeInTheDocument()
    })

    it('re-reads the page while it waits, because nothing else will tell it', () => {
        render(<Probe state="down" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        wait(9000)

        expect(refresh.mock.calls.length).toBeGreaterThan(1)
    })

    it('stops waiting after a minute and a half, and says it gave up', () => {
        render(<Probe state="down" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        wait(90000)

        expect(screen.getByText('idle')).toBeInTheDocument()
        expect(screen.getByText('gave up')).toBeInTheDocument()
    })

    it('stops re-reading the page once it has given up', () => {
        render(<Probe state="down" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        wait(90000)
        const asked = refresh.mock.calls.length

        wait(30000)

        expect(refresh.mock.calls.length).toBe(asked)
    })

    it('clears an earlier giving up when something new is asked for', () => {
        render(<Probe state="down" />)

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))
        wait(90000)
        expect(screen.getByText('gave up')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'ask restart' }))

        expect(screen.queryByText('gave up')).toBeNull()
        expect(screen.getByText('settling restart')).toBeInTheDocument()
    })
})
