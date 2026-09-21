// The two controls that change what a site is doing. What matters here is which one is offered: the pair
// used to be three buttons, one of which could never do anything, and a start offered to a running site
// is a button whose only outcome is a refusal from hostd.

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SiteState } from '../../siteState'

const lifecycleAction = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))
vi.mock('./actions', () => ({ lifecycleAction: (...args: unknown[]) => lifecycleAction(...args) }))

const { Lifecycle } = await import('./lifecycle')
const { SettlingProvider } = await import('./settling')

beforeEach(() => {
    vi.clearAllMocks()
    lifecycleAction.mockResolvedValue({ ok: true, message: 'Asked.' })
})

describe('the lifecycle controls', () => {
    it('offers to stop a site that is up', () => {
        render(<Lifecycle id="asot" enabled state="up" />)

        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
        expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    })

    it('offers to start one that is not', () => {
        render(<Lifecycle id="asot" enabled state="stopped" />)

        expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
        expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    })

    it('starts a site down at the far end without asking twice', async () => {
        // Down is exited rather than stopped, and the thing to do about it is still to start it
        render(<Lifecycle id="asot" enabled state="down" />)

        await userEvent.click(screen.getByRole('button', { name: 'Start' }))

        expect(lifecycleAction).toHaveBeenCalledWith('asot', 'start')
    })

    // Stopping is the one control here that leaves the site switched off behind it, and it is one click
    // away from a live client site.
    it('asks before stopping, and stops nothing while the question is unanswered', async () => {
        render(<Lifecycle id="asot" enabled state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Stop' }))

        expect(screen.getByRole('heading', { name: /stop this site/i })).toBeInTheDocument()
        expect(lifecycleAction).not.toHaveBeenCalled()
    })

    it('stops nothing at all when the question is cancelled', async () => {
        render(<Lifecycle id="asot" enabled state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(lifecycleAction).not.toHaveBeenCalled()
        expect(screen.queryByRole('heading', { name: /stop this site/i })).toBeNull()
    })

    it('stops it once the question is answered', async () => {
        render(<Lifecycle id="asot" enabled state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await userEvent.click(screen.getByRole('button', { name: 'Stop the site' }))

        expect(lifecycleAction).toHaveBeenCalledWith('asot', 'stop')
        // The states on the page were read before this, so they are now a guess until it is re-read
        expect(refresh).toHaveBeenCalled()
    })

    it('acts on nothing while the containers could not be read', () => {
        // Which of start and stop this site needs is exactly what an unreadable state does not say
        render(<Lifecycle id="asot" enabled state="unknown" />)

        expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled()
        expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    })

    it('says why when hostd has lifecycle turned off for the project', () => {
        render(<Lifecycle id="asot" enabled={false} state="up" />)

        expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
        expect(screen.getByText(/lifecycle turned off/i)).toBeInTheDocument()
    })

    it('says what hostd said when it refused', async () => {
        lifecycleAction.mockResolvedValue({ ok: false, error: 'the agent is not answering' })
        render(<Lifecycle id="asot" enabled state="stopped" />)

        await userEvent.click(screen.getByRole('button', { name: 'Start' }))

        expect(await screen.findByText(/not answering/)).toBeInTheDocument()
        expect(refresh).not.toHaveBeenCalled()
    })
})

// Everything below is about the seconds after the click. hostd answers when it has taken the job, not
// when it is done, so the pair used to come straight back to life over a site that was still coming up,
// and the state underneath them flipped to down halfway through a restart and took the labels with it.
describe('the lifecycle controls while the site is settling', () => {
    function Settling({ state }: { state: SiteState }) {
        return (
            <SettlingProvider state={state}>
                <Lifecycle id="asot" enabled state={state} />
            </SettlingProvider>
        )
    }

    it('holds both controls while a restart is still happening, and says which one it is', async () => {
        render(<Settling state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

        expect(await screen.findByRole('button', { name: 'Restarting...' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    })

    // The label used to be read off the state, so a stop flipped it to Start the moment the containers
    // went, describing the site's next move over the top of the one it was making.
    it('goes on saying stopping after the site reads stopped', async () => {
        const { rerender } = render(<Settling state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await userEvent.click(screen.getByRole('button', { name: 'Stop the site' }))
        expect(await screen.findByRole('button', { name: 'Stopping...' })).toBeDisabled()

        rerender(<Settling state="stopped" />)

        expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    })

    // Mid-restart hostd can refuse a status read, and that is the operation happening rather than a
    // problem with the site: saying so beside the buttons is the noise this whole thing is removing.
    it('does not call the site unreadable while it is the one doing the reading', async () => {
        const { rerender } = render(<Settling state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
        await screen.findByRole('button', { name: 'Restarting...' })
        rerender(<Settling state="unknown" />)

        expect(screen.queryByText(/could not be read/i)).toBeNull()
    })

    it('leaves the controls alone when hostd refused, because nothing is happening', async () => {
        lifecycleAction.mockResolvedValue({ ok: false, error: 'the agent is not answering' })
        render(<Settling state="up" />)

        await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

        expect(await screen.findByText(/not answering/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled()
    })
})

describe('the lifecycle controls when the waiting ends', () => {
    function Settling({ state }: { state: SiteState }) {
        return (
            <SettlingProvider state={state}>
                <Lifecycle id="asot" enabled state={state} />
            </SettlingProvider>
        )
    }

    // fireEvent rather than userEvent throughout: user-event waits on real timers of its own, which a
    // test that has to fast-forward ninety seconds has taken away from it.
    async function click(name: string) {
        fireEvent.click(screen.getByRole('button', { name }))
        // The action is a promise, and it settles in a microtask rather than on a clock
        await act(async () => {})
    }

    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('hands the controls back, and drops the sentence, once the site is up again', async () => {
        const { rerender } = render(<Settling state="up" />)

        await click('Restart')
        rerender(<Settling state="down" />)
        act(() => { vi.advanceTimersByTime(9000) })
        rerender(<Settling state="up" />)
        act(() => { vi.advanceTimersByTime(3000) })

        expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled()
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
        // It said the site would be unavailable for a few seconds. It is not, any more.
        expect(screen.queryByText(/unavailable for a few seconds/i)).toBeNull()
    })

    it('admits it does not know rather than spinning for ever', async () => {
        render(<Settling state="down" />)

        await click('Restart')
        act(() => { vi.advanceTimersByTime(90000) })

        expect(screen.getByText(/taking longer/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled()
    })
})
