import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Callout } from './Callout'

describe('Callout', () => {
    it('announces itself when it carries a problem', () => {
        render(<Callout tone="crit" title="The deploy failed">Live is untouched.</Callout>)
        expect(screen.getByRole('alert')).toHaveTextContent('The deploy failed')
    })

    it('is a plain region when it is only information', () => {
        render(<Callout title="Backups run nightly">At 7pm.</Callout>)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByText('Backups run nightly')).toBeInTheDocument()
    })
})
