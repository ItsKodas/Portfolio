import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import EmailLink from './EmailLink'

afterEach(() => { vi.unstubAllGlobals() })

describe('EmailLink', () => {
    it('keeps the address out of the markup', () => {
        const html = renderToStaticMarkup(<EmailLink />)
        expect(html).not.toMatch(/koda|horizons\.gg|mailto/i)
    })

    it('opens a mail to koda@horizons.gg when clicked', async () => {
        const assign = vi.fn()
        vi.stubGlobal('location', { ...window.location, assign })
        render(<EmailLink />)
        await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
        expect(assign).toHaveBeenCalledWith('mailto:koda@horizons.gg')
    })
})
