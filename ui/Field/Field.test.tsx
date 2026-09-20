import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Field } from './Field'

describe('Field', () => {
    it('ties the label to the input, so clicking the label focuses it', async () => {
        render(<Field label="Email" name="email" />)
        await userEvent.click(screen.getByText('Email'))
        expect(screen.getByLabelText('Email')).toHaveFocus()
    })

    it('reads the hint out as part of the field', () => {
        render(<Field label="Email" name="email" hint="We only use this to reply" />)
        expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('We only use this to reply')
    })

    it('marks an errored field invalid and describes it by the error', () => {
        render(<Field label="Email" name="email" error="Enter a valid email address" />)
        const input = screen.getByLabelText('Email')
        expect(input).toHaveAttribute('aria-invalid', 'true')
        expect(input).toHaveAccessibleDescription('Enter a valid email address')
    })

    it('keeps both the hint and the error when there are both', () => {
        render(<Field label="Email" name="email" hint="We only use this to reply" error="Enter a valid email address" />)
        expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('We only use this to reply Enter a valid email address')
    })

    it('is not invalid when there is no error', () => {
        render(<Field label="Email" name="email" />)
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
    })

    it('gives two fields with the same label different ids', () => {
        render(<><Field label="Email" name="a" /><Field label="Email" name="b" /></>)
        const [first, second] = screen.getAllByLabelText('Email')
        expect(first.id).not.toBe(second.id)
    })

    it('can be a textarea', () => {
        render(<Field as="textarea" label="Message" name="message" />)
        expect(screen.getByLabelText('Message').tagName).toBe('TEXTAREA')
    })

    // rows is a textarea attribute an input does not have, so the props have to admit it or a multi-line
    // field cannot be given a height. This failed as a type error before the props were widened.
    it('lets a textarea be given a height', () => {
        render(<Field as="textarea" label="Message" name="message" rows={4} />)
        expect(screen.getByLabelText('Message')).toHaveAttribute('rows', '4')
    })
})
