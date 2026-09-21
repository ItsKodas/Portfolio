// A site can be several containers, and reading its log means reading theirs together. hostd's logs call
// takes one service, so this component opens one stream per container and merges what comes back. These
// are the parts of that a stand-in stream can hold: which streams are open, what the filter does to them,
// and whether the merged result reads in the order things actually happened.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const { SiteLogs } = await import('./logs')
const { SettlingProvider, useSettling } = await import('./settling')

// jsdom has no EventSource, and ui/testing/setup.ts puts an inert one in place so that pages which stream
// can be rendered at all. This is the opposite: one a test can drive.
class FakeSource {
    static made: FakeSource[] = []
    onopen: (() => void) | null = null
    closed = false
    private listeners: Record<string, Array<(event: Event) => void>> = {}

    constructor(readonly url: string) {
        FakeSource.made.push(this)
    }

    get service(): string {
        return new URL(this.url, 'http://portal.test').searchParams.get('service') ?? ''
    }

    addEventListener(type: string, fn: (event: Event) => void): void {
        (this.listeners[type] ??= []).push(fn)
    }

    removeEventListener(): void {}

    close(): void {
        this.closed = true
    }

    open(): void {
        act(() => { this.onopen?.() })
    }

    // data is what hostd puts in the event; an event without it is the browser's own, which is how the
    // component tells a refused request from a failed stream.
    send(type: string, data?: unknown): void {
        const event = data === undefined ? new Event(type) : Object.assign(new Event(type), { data: JSON.stringify(data) })
        act(() => {
            for (const fn of this.listeners[type] ?? []) fn(event)
        })
    }

    line(text: string, ts: string): void {
        this.send('line', { stream: 'stdout', ts, text, truncated: false })
    }
}

function sourceFor(service: string): FakeSource {
    const found = FakeSource.made.filter(source => source.service === service && !source.closed)
    expect(found, `no open stream for ${service}`).toHaveLength(1)
    return found[0]
}

const realEventSource = globalThis.EventSource

beforeEach(() => {
    FakeSource.made = []
    globalThis.EventSource = FakeSource as unknown as typeof EventSource
})

afterEach(() => {
    globalThis.EventSource = realEventSource
})

describe('the site log', () => {
    it('opens one stream per container, following all of them to begin with', () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)

        expect(FakeSource.made.map(source => source.service)).toEqual(['web', 'db'])
        expect(FakeSource.made.every(source => source.url.includes('follow=1'))).toBe(true)
    })

    it('says which container each line came from, when there is more than one', () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)
        sourceFor('web').open()
        sourceFor('web').line('listening on 3000', '2026-09-21T15:31:20.000Z')

        const pane = within(screen.getByRole('region'))
        expect(pane.getByText('listening on 3000')).toBeInTheDocument()
        expect(pane.getByText('web')).toBeInTheDocument()
    })

    it('leaves the column out when there is only one container to name', () => {
        // Two hundred repeats of the same name is a column that says nothing
        render(<SiteLogs id="asot" services={['web']} />)
        sourceFor('web').open()
        sourceFor('web').line('listening on 3000', '2026-09-21T15:31:20.000Z')

        const pane = within(screen.getByRole('region'))
        expect(pane.queryByText('web')).toBeNull()
    })

    // Each stream sends its tail in one burst when it opens, so without this the first screen reads as
    // one container's last two hundred lines followed by the other's, which is not what happened.
    it('puts the merged lines in the order they happened, not the order the streams answered', () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)
        sourceFor('web').open()
        sourceFor('web').line('web first', '2026-09-21T15:31:20.000Z')
        sourceFor('web').line('web third', '2026-09-21T15:31:22.000Z')
        sourceFor('db').open()
        sourceFor('db').line('db second', '2026-09-21T15:31:21.000Z')

        const text = screen.getByRole('region').textContent ?? ''
        expect(text.indexOf('web first')).toBeLessThan(text.indexOf('db second'))
        expect(text.indexOf('db second')).toBeLessThan(text.indexOf('web third'))
    })

    it('closes the stream of a container turned off, and keeps the others', async () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)
        const db = sourceFor('db')

        await userEvent.click(screen.getByRole('button', { name: 'db' }))

        expect(db.closed).toBe(true)
        expect(screen.getByRole('button', { name: 'db' })).toHaveAttribute('aria-pressed', 'false')
        expect(sourceFor('web')).toBeDefined()
    })

    it('follows a container turned back on again', async () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)

        await userEvent.click(screen.getByRole('button', { name: 'db' }))
        await userEvent.click(screen.getByRole('button', { name: 'db' }))

        expect(sourceFor('db').closed).toBe(false)
        expect(screen.getByRole('button', { name: 'db' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('says so rather than showing an empty pane when nothing is selected', async () => {
        render(<SiteLogs id="asot" services={['web']} />)

        await userEvent.click(screen.getByRole('button', { name: 'web' }))

        expect(screen.getByText(/choose a container/i)).toBeInTheDocument()
        expect(FakeSource.made.every(source => source.closed)).toBe(true)
    })

    it('counts how many of the streams are up when they disagree', () => {
        render(<SiteLogs id="asot" services={['web', 'db']} />)
        sourceFor('web').open()

        expect(screen.getByText('Streaming 1 of 2.')).toBeInTheDocument()

        sourceFor('db').open()
        expect(screen.getByText(/newest at the bottom/i)).toBeInTheDocument()
    })

    it('has nothing to follow when the site is running nothing', () => {
        render(<SiteLogs id="asot" services={[]} />)

        expect(screen.getByText(/nothing is running/i)).toBeInTheDocument()
        expect(FakeSource.made).toHaveLength(0)
    })
})

// A stop, a start or a restart takes the containers away and brings them back, and for those seconds the
// relay refuses a stream for a container that is not there. That refusal is the operation happening, not
// a fault, and it used to arrive as a red panel with a button asking to be clicked.
describe('the site log while the site is settling', () => {
    function Begin({ action }: { action: 'restart' | 'stop' }) {
        const { begin } = useSettling()
        return <button type="button" onClick={() => begin(action)}>begin</button>
    }

    function Settling({ services, action }: { services: string[], action: 'restart' | 'stop' }) {
        return (
            <SettlingProvider state="up">
                <Begin action={action} />
                <SiteLogs id="asot" services={services} />
            </SettlingProvider>
        )
    }

    // The browser's own error event, which carries no data: the request was refused before the stream
    // ever opened, which is what a container that is not there yet looks like from here.
    function refuse(service: string) {
        sourceFor(service).send('error')
    }

    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('says what is happening rather than showing a refusal to retry by hand', () => {
        render(<Settling services={['web']} action="restart" />)
        fireEvent.click(screen.getByRole('button', { name: 'begin' }))

        refuse('web')

        expect(screen.queryByText(/did not open/i)).toBeNull()
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
        expect(screen.getByText(/waiting for the containers/i)).toBeInTheDocument()
    })

    it('picks the stream up again by itself once the container is back', () => {
        render(<Settling services={['web']} action="restart" />)
        fireEvent.click(screen.getByRole('button', { name: 'begin' }))
        refuse('web')

        act(() => { vi.advanceTimersByTime(3000) })

        // A second stream for the same container, the first one having been closed
        expect(FakeSource.made.filter(source => source.service === 'web')).toHaveLength(2)
        sourceFor('web').open()
        // Still the restart until the restart is over: the provider is holding it for its own reasons,
        // and one stream being back up is not what says the site is.
        expect(screen.getByText(/waiting for the containers/i)).toBeInTheDocument()

        act(() => { vi.advanceTimersByTime(9000) })

        expect(screen.getByText(/newest at the bottom/i)).toBeInTheDocument()
    })

    it('does not call a stopping site an empty one', () => {
        // Stopping takes the containers away, so the next read has none to report
        const { rerender } = render(<Settling services={['web']} action="stop" />)
        fireEvent.click(screen.getByRole('button', { name: 'begin' }))

        rerender(<Settling services={[]} action="stop" />)

        expect(screen.queryByText(/nothing is running/i)).toBeNull()
        expect(screen.getByText(/stopping/i)).toBeInTheDocument()
    })
})

describe('the site log when nothing is happening to the site', () => {
    const fetched = vi.fn()

    beforeEach(() => {
        // What the relay answers when it will not open the stream at all. Only reached when the component
        // decides the refusal is worth explaining rather than waiting out.
        fetched.mockResolvedValue({ ok: false, json: async () => ({ message: 'That site is not running.' }) })
        globalThis.fetch = fetched as unknown as typeof fetch
    })

    // The other half of the pair above: outside an operation, a refused stream is still a refused stream
    // and still says so, because nothing is coming to fix it.
    it('still says a refused stream was refused, and offers to try again', async () => {
        render(<SiteLogs id="asot" services={['web']} />)

        sourceFor('web').send('error')

        expect(await screen.findByText(/not running/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })
})
