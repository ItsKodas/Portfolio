// What is tested here is our own wiring: the dialog is labelled by its heading, it is absent when closed,
// our close button calls onClose, and our onCancel handler calls onClose. Focus trapping, the top layer and
// page inertness are the browser's, and are the reason the native element was chosen at all. jsdom provides
// none of the dialog modal API, so ui/testing/setup.ts supplies stand-ins for showModal, show and close.
// Those stand-ins are enough to run our wiring and deliberately reproduce nothing else, so the platform
// behaviour is checked by eye in the gallery at /admin/ui instead.

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog } from './Dialog'

// An opener and a dialog, the way a real screen wires them, so closing can be followed back to the button.
function Harness() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Open</button>
            <Dialog open={open} onClose={() => setOpen(false)} title="Roll back">Body</Dialog>
        </>
    )
}

describe('Dialog', () => {
    it('is named by its heading', () => {
        render(<Dialog open title="Roll back live to d40e7b8?" onClose={() => {}}>Body</Dialog>)
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Roll back live to d40e7b8?')
    })

    it('is not in the document when closed', () => {
        render(<Dialog open={false} title="Roll back" onClose={() => {}}>Body</Dialog>)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // Not a keyboard test, on purpose. jsdom does not turn an Escape keypress into a cancel event, so
    // userEvent.keyboard('{Escape}') would pass here while proving nothing. Dispatching cancel is the
    // event a real browser sends on Escape, which is the part we actually handle. Do not "fix" this back
    // into a keypress: that Escape reaches the dialog at all is the browser's job, checked in the gallery.
    it('closes when the platform cancels it, which is what Escape does in a real browser', () => {
        const onClose = vi.fn()
        render(<Dialog open title="Roll back" onClose={onClose}>Body</Dialog>)
        fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
        expect(onClose).toHaveBeenCalled()
    })

    it('closes from its own close button', async () => {
        const onClose = vi.fn()
        render(<Dialog open title="Roll back" onClose={onClose}>Body</Dialog>)
        await userEvent.click(screen.getByRole('button', { name: /close/i }))
        expect(onClose).toHaveBeenCalled()
    })

    // Focus return is ours here, not the platform's. A dialog that is close()d and left in the page gets
    // this for free, but this one unmounts when it closes, and a browser drops focus to the body when an
    // open dialog is removed from the DOM. Since we put the focus back by hand, it is wiring, and testable.
    // Focus trapping while the dialog is open is still the browser's, and still only checked in the gallery.
    it('puts focus back on whatever opened it', async () => {
        render(<Harness />)
        const opener = screen.getByRole('button', { name: 'Open' })
        await userEvent.click(opener)
        await userEvent.click(screen.getByRole('button', { name: /close/i }))
        expect(opener).toHaveFocus()
    })
})
