import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveScheduleAction = vi.fn()
vi.mock('./actions', () => ({ saveScheduleAction: (...args: unknown[]) => saveScheduleAction(...args) }))

const { ScheduleForm } = await import('./scheduleForm')

const schedule = { mode: 'off' as const, hour: 2, minute: 0, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } }

beforeEach(() => {
    vi.clearAllMocks()
})

describe('the backup schedule', () => {
    it('says when nothing is scheduled, and hides the time and counts', () => {
        render(<ScheduleForm id="asot" schedule={schedule} />)

        expect(screen.getByText(/No automatic copies are made/)).toBeInTheDocument()
        expect(screen.queryByLabelText('At')).not.toBeInTheDocument()
    })

    it('saves a weekly schedule and shows what hostd settled on', async () => {
        const saved = { mode: 'weekly' as const, hour: 3, minute: 30, weekday: 5, keep: { daily: 7, weekly: 4, monthly: 1 } }
        saveScheduleAction.mockResolvedValue({ ok: true, message: 'Saved, with fewer copies kept than asked for: that is the most this site can keep.', schedule: saved })
        const user = userEvent.setup()
        render(<ScheduleForm id="asot" schedule={schedule} />)

        await user.selectOptions(screen.getByLabelText('Make a copy'), 'weekly')
        await user.selectOptions(screen.getByLabelText('On'), 'Friday')
        await user.selectOptions(screen.getByLabelText('At'), '3:30 am')
        await user.clear(screen.getByLabelText('Monthly copies kept'))
        await user.type(screen.getByLabelText('Monthly copies kept'), '12')
        await user.click(screen.getByRole('button', { name: 'Save schedule' }))

        expect(saveScheduleAction).toHaveBeenCalledWith('asot', {
            mode: 'weekly', hour: 3, minute: 30, weekday: 5, keep: { daily: 7, weekly: 4, monthly: 12 },
        })
        expect(await screen.findByText(/fewer copies kept than asked for/)).toBeInTheDocument()
        expect(screen.getByText('A copy is made every Friday at 3:30 am, Brisbane time.', { exact: false })).toBeInTheDocument()
        expect(screen.getByLabelText('Monthly copies kept')).toHaveValue('1')
    })

    it('will not save a count that is not a whole number', async () => {
        const user = userEvent.setup()
        render(<ScheduleForm id="asot" schedule={{ ...schedule, mode: 'daily' }} />)

        await user.clear(screen.getByLabelText('Daily copies kept'))
        await user.type(screen.getByLabelText('Daily copies kept'), 'seven')

        expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
    })

    it('shows hostd\'s refusal', async () => {
        saveScheduleAction.mockResolvedValue({ ok: false, error: 'This is temporarily unavailable.' })
        const user = userEvent.setup()
        render(<ScheduleForm id="asot" schedule={{ ...schedule, mode: 'daily' }} />)

        await user.click(screen.getByRole('button', { name: 'Save schedule' }))

        expect(await screen.findByText('This is temporarily unavailable.')).toBeInTheDocument()
    })
})
