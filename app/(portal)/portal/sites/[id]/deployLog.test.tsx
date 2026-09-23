import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// One object for the life of the module, not a new one per call: real next/navigation hands back a
// stable router, and the effect below closes over it in its dependency array. A fresh object on every
// render would make the effect tear down and reopen the stream on every line, which is not what the
// component it stands in for does. vi.hoisted, because vi.mock's factory runs before this file's own
// top-level code and cannot otherwise close over a variable declared here.
const { mockRouter } = vi.hoisted(() => ({ mockRouter: { refresh: () => {} } }))
vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }))

const { DeployLog, MAX_LINES } = await import('./deployLog')

class FakeSource {
    static made: FakeSource[] = []
    onopen: (() => void) | null = null
    closed = false
    private listeners: Record<string, Array<(event: Event) => void>> = {}

    constructor(readonly url: string) {
        FakeSource.made.push(this)
    }

    addEventListener(type: string, fn: (event: Event) => void): void {
        (this.listeners[type] ??= []).push(fn)
    }

    removeEventListener(): void {}
    close(): void { this.closed = true }
    open(): void { act(() => { this.onopen?.() }) }

    // Not wrapped in act, so a caller that needs to flush a promise as well can wrap the whole thing in an
    // async act of its own. A named event from the relay carries data; the browser's own transport error
    // does not, and telling those apart is the component's business.
    fire(type: string, data?: unknown): void {
        const event = data === undefined ? new Event(type) : Object.assign(new Event(type), { data: JSON.stringify(data) })
        for (const fn of this.listeners[type] ?? []) fn(event)
    }

    event(payload: { at: string, startedAt: string, kind: string, text: string }): void {
        act(() => { this.fire('line', payload) })
    }
}

const realEventSource = globalThis.EventSource

beforeEach(() => {
    FakeSource.made = []
    globalThis.EventSource = FakeSource as unknown as typeof EventSource
})

afterEach(() => {
    globalThis.EventSource = realEventSource
    vi.unstubAllGlobals()
})

const AT = '2026-09-23T05:00:00.000Z'
const LATER = '2026-09-23T06:00:00.000Z'
const open = () => FakeSource.made.filter(source => !source.closed)[0]!

describe('the deploy column', () => {
    it('asks for the environment it was given', () => {
        render(<DeployLog id="acme" environment="live" />)
        const url = new URL(open().url, 'http://portal.test')
        expect(url.pathname).toBe('/api/sites/acme/deploy')
        expect(url.searchParams.get('environment')).toBe('live')
    })

    // The id goes into the path, so it is encoded there, exactly as the log view encodes what it puts in
    // a query string. Nothing else about the request is the caller's to shape.
    it('encodes the project id it was given', () => {
        render(<DeployLog id="acme/bakery" environment="live" />)
        const url = new URL(open().url, 'http://portal.test')
        expect(url.pathname).toBe('/api/sites/acme%2Fbakery/deploy')
    })

    // The narrative and the raw output are the two things on screen, and reading one as the other is the
    // whole of why the column is easier to follow than a wall of build text.
    it('shows a step and a line of output, and tells them apart', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })
        open().event({ at: AT, startedAt: AT, kind: 'output', text: '#7 [4/9] RUN npm ci' })

        const step = screen.getByText('building')
        const output = screen.getByText('#7 [4/9] RUN npm ci')
        expect(step).toBeInTheDocument()
        expect(output).toBeInTheDocument()
        expect(step.className).not.toEqual(output.className)
    })

    // One stream carries a sequence of deploys, so the boundary is startedAt changing, not the stream
    // closing. Without this the next deploy's lines would append to the last one's.
    it('clears the column when a different deploy starts', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'the old deploy' })
        open().event({ at: LATER, startedAt: LATER, kind: 'step', text: 'the new deploy' })

        expect(screen.queryByText('the old deploy')).toBeNull()
        expect(screen.getByText('the new deploy')).toBeInTheDocument()
    })

    it('shows the outcome when the end event arrives', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'end', text: 'deployed in 9s' })
        expect(screen.getByText('deployed in 9s')).toBeInTheDocument()
    })

    // A refusal arrives as an HTTP error before the stream ever opens, and EventSource does not hand over
    // the body, so the same endpoint is asked again plainly to get the relay's own message.
    it('says why when hostd refuses, instead of failing silently', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ message: 'Deploying is not available for this site.' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
        )))
        render(<DeployLog id="acme" environment="live" />)
        await act(async () => { open().fire('error') })
        expect(await screen.findByText(/not available for this site/)).toBeInTheDocument()
    })

    // EventSource retries a closed connection by itself, every few seconds, for as long as the tab is
    // open. Behind a refusal each of those retries runs the whole path to hostd and writes an audit line,
    // so a forgotten tab is thousands of appends an hour arriving exactly when hostd is already unwell.
    it('stops retrying once the request has been refused', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ message: 'Deploying is not available for this site.' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
        )))
        render(<DeployLog id="acme" environment="live" />)
        const refused = FakeSource.made[0]!
        await act(async () => { refused.fire('error') })
        await screen.findByText(/not available for this site/)
        expect(refused.closed).toBe(true)
    })

    // An agent restart mid-deploy ends the stream at the server: api writes its end event and closes. The
    // column must say so, because the alternative is a stale half-log that reads as a deploy still running.
    it('says the stream dropped when the server ends it', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })

        const ended = FakeSource.made[0]!
        act(() => { ended.fire('end') })

        expect(screen.getByText(/stream dropped/i)).toBeInTheDocument()
        expect(ended.closed).toBe(true)
        // What the deploy printed stays on screen: the point is to say it stopped, not to hide it.
        expect(screen.getByText('building')).toBeInTheDocument()
    })

    // hostd's own named error event, which is a message and carries data, rather than the browser's plain
    // transport error. It arrives on an open stream, where doing nothing leaves the same stale half-log.
    it('says the stream dropped when hostd reports it failed', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        const failed = FakeSource.made[0]!

        act(() => { failed.fire('error', { message: 'the deploy watch stream failed' }) })

        expect(screen.getByText(/stream dropped/i)).toBeInTheDocument()
        expect(failed.closed).toBe(true)
    })

    // An unclosed stream per navigation is how a portal ends up holding connections nobody is reading,
    // each one still costing the agent a watcher and a queue.
    it('closes the stream when the column goes away', () => {
        const view = render(<DeployLog id="acme" environment="live" />)
        open().open()
        view.unmount()
        expect(FakeSource.made.every(source => source.closed)).toBe(true)
    })

    // EventSource reconnects on its own after any dropped connection, and hostd replays its whole buffer
    // to every new subscriber, which is the buffer's whole purpose. Without clearing startedAt on open,
    // the replayed line would carry the same startedAt as the one already on screen and be appended
    // instead of read as a repeat of it.
    it('does not duplicate a line when the stream reconnects mid-deploy', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })

        expect(screen.getAllByText('building')).toHaveLength(1)
    })

    // The plain fetch is only for a refusal, which is an error before the stream ever opens. An error
    // after a healthy open is a dropped connection EventSource is about to retry by itself, and neither
    // asking again nor painting a refusal banner over a column that is still streaming is warranted.
    it('does not treat a drop after a healthy open as a refusal', () => {
        const fetched = vi.fn()
        vi.stubGlobal('fetch', fetched)
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })

        act(() => { open().fire('error') })

        expect(fetched).not.toHaveBeenCalled()
        expect(screen.queryByText(/cannot be watched/)).toBeNull()
        expect(screen.getByText('building')).toBeInTheDocument()
    })

    // MAX_LINES + 10 renders of a growing, then 2000-deep, list is slow under jsdom on its own merits, not
    // because anything here is hanging, so this one test gets more than the suite's default budget.
    it('keeps at most MAX_LINES lines, dropping the oldest', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        for (let i = 0; i < MAX_LINES + 10; i += 1) {
            open().event({ at: AT, startedAt: AT, kind: 'output', text: `line ${i}` })
        }
        expect(screen.queryByText('line 0')).toBeNull()
        expect(screen.getByText(`line ${MAX_LINES + 9}`)).toBeInTheDocument()
    }, 20000)
})
