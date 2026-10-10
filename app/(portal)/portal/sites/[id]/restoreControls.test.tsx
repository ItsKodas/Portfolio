import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const restoreBackupAction = vi.fn()
const restoresAction = vi.fn()
const refresh = vi.fn()

vi.mock('./actions', () => ({
    restoreBackupAction: (...args: unknown[]) => restoreBackupAction(...args),
    restoresAction: (...args: unknown[]) => restoresAction(...args),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh }) }))

const { RestoreButton, stepWords } = await import('./restoreControls')

beforeEach(() => {
    vi.clearAllMocks()
    restoreBackupAction.mockResolvedValue({ ok: true, message: 'ok', run: 'r1' })
})

function open() {
    render(<RestoreButton id="asot" name="A State of Trance" snapshot="4f1c2a9b" label="5 Oct, 06:00" block={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
}

describe('the Restore button', () => {
    it('names the site and the copy, and waits for the site\'s name to be typed', () => {
        open()

        expect(screen.getByText(/A State of Trance's live site goes back to the copy from 5 Oct, 06:00/)).toBeInTheDocument()
        expect(screen.getAllByText('4f1c2a9b').length).toBeGreaterThan(0)
        expect(screen.getByText(/A fresh copy of live is made first/)).toBeInTheDocument()
        const go = screen.getAllByRole('button', { name: 'Restore' }).at(-1)!
        expect(go).toBeDisabled()

        fireEvent.change(screen.getByLabelText('Type A State of Trance to confirm'), { target: { value: 'a state of trance' } })
        expect(go).toBeDisabled()
    })

    it('sends what was typed to hostd and refreshes once it has started', async () => {
        open()
        fireEvent.change(screen.getByLabelText('Type A State of Trance to confirm'), { target: { value: 'A State of Trance' } })
        fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1)!)

        await waitFor(() => expect(refresh).toHaveBeenCalled())
        expect(restoreBackupAction).toHaveBeenCalledWith('asot', '4f1c2a9b', 'A State of Trance')
    })

    it('shows hostd\'s refusal in the dialog', async () => {
        restoreBackupAction.mockResolvedValue({ ok: false, error: 'asot is being deployed' })
        open()
        fireEvent.change(screen.getByLabelText('Type A State of Trance to confirm'), { target: { value: 'A State of Trance' } })
        fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1)!)

        expect(await screen.findByText('asot is being deployed')).toBeInTheDocument()
        expect(refresh).not.toHaveBeenCalled()
    })

    it('is off with the reason while something else runs', () => {
        render(<RestoreButton id="asot" name="asot" snapshot="4f1c2a9b" label="5 Oct" block="A copy is being made right now." />)

        expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    })
})

describe('stepWords', () => {
    it('puts hostd\'s steps in plain words', () => {
        expect(stepWords('safety')).toBe('Making a fresh copy of the live site first')
        expect(stepWords('load:db')).toBe('Putting the db database back')
        expect(stepWords('sqlite:app')).toBe('Putting the app database file back')
        expect(stepWords('storage:uploads')).toBe('Putting the stored files back (uploads)')
        expect(stepWords('something-new')).toBe('something-new')
    })
})
