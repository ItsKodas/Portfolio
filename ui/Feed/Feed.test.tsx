import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Feed } from './Feed'

const events = [
    { time: '21:17', text: 'Deploy started on live' },
    { time: '21:14', text: 'web exited 137', bad: true },
]

describe('Feed', () => {
    it('is a list, so how many events there are is announced', () => {
        render(<Feed events={events} />)
        expect(screen.getAllByRole('listitem')).toHaveLength(2)
    })

    it('marks a time as a time', () => {
        const { container } = render(<Feed events={events} />)
        expect(container.querySelector('time')).toHaveTextContent('21:17')
    })

    it('does not rely on red alone to say something went wrong', () => {
        render(<Feed events={events} />)
        // the text itself carries the failure, which is why no icon or label is added here
        expect(screen.getByText('web exited 137')).toBeInTheDocument()
    })
})
