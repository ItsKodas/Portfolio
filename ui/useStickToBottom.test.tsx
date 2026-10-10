import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useStickToBottom } from './useStickToBottom'

function Box({ lines }: { lines: string[] }) {
    const ref = useStickToBottom<HTMLDivElement>()
    return (
        <div ref={ref} data-testid="box">
            {lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
    )
}

// jsdom lays nothing out, so the box's geometry is given by hand: `height` px of content in a 200px box.
function sized(box: HTMLElement, height: { current: number }): HTMLElement {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => height.current })
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 200 })
    return box
}

function scroll(box: HTMLElement, to: number) {
    act(() => {
        box.scrollTop = to
        box.dispatchEvent(new Event('scroll'))
    })
}

// The content watch runs once a render's mutations are delivered, which is a microtask after the render
async function settle() {
    await act(async () => {})
}

describe('useStickToBottom', () => {
    it('follows new content to the bottom', async () => {
        const height = { current: 1000 }
        const { rerender } = render(<Box lines={['one']} />)
        const box = sized(screen.getByTestId('box'), height)

        rerender(<Box lines={['one', 'two']} />)
        await settle()
        expect(box.scrollTop).toBe(1000)
    })

    // The one that left logs stuck: a scroll event lands a frame after the scroll that caused it, and in
    // a burst more lines have arrived by then, so the box looks scrolled up when nobody touched it.
    it('keeps following when content outgrows a scroll that has not been reported yet', async () => {
        const height = { current: 1000 }
        const { rerender } = render(<Box lines={['one']} />)
        const box = sized(screen.getByTestId('box'), height)
        rerender(<Box lines={['one', 'two']} />)
        await settle()

        // More arrives, and only then does the event for the scroll to 1000 come in
        height.current = 1400
        act(() => { box.dispatchEvent(new Event('scroll')) })

        rerender(<Box lines={['one', 'two', 'three']} />)
        await settle()
        expect(box.scrollTop).toBe(1400)
    })

    it('leaves the reader where they are once they scroll up', async () => {
        const height = { current: 1000 }
        const { rerender } = render(<Box lines={['one']} />)
        const box = sized(screen.getByTestId('box'), height)
        rerender(<Box lines={['one', 'two']} />)
        await settle()

        scroll(box, 100)
        height.current = 1400
        rerender(<Box lines={['one', 'two', 'three']} />)
        await settle()
        expect(box.scrollTop).toBe(100)
    })

    it('follows again once the reader scrolls back down to the bottom', async () => {
        const height = { current: 1000 }
        const { rerender } = render(<Box lines={['one']} />)
        const box = sized(screen.getByTestId('box'), height)
        rerender(<Box lines={['one', 'two']} />)
        await settle()

        scroll(box, 100)
        scroll(box, 790)
        height.current = 1400
        rerender(<Box lines={['one', 'two', 'three']} />)
        await settle()
        expect(box.scrollTop).toBe(1400)
    })

    // A line rewritten in place (the container log slotting an earlier line in by its timestamp) changes
    // no node, only the text in one
    it('follows text that changes in place', async () => {
        const height = { current: 1000 }
        const { rerender } = render(<Box lines={['one', 'two']} />)
        const box = sized(screen.getByTestId('box'), height)
        await settle()
        box.scrollTop = 0

        rerender(<Box lines={['one', 'three']} />)
        await settle()
        expect(box.scrollTop).toBe(1000)
    })
})
