import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emailCheckAction, revealEmailAction } from './contactActions'
import EmailLink from './EmailLink'

vi.mock('./contactActions', () => ({ emailCheckAction: vi.fn(), revealEmailAction: vi.fn() }))

// Stands in for Cloudflare's widget: answers at once with a token, or with null as the real one does when it errors
const widget = vi.hoisted(() => ({ token: 'tok' as string | null }))
vi.mock('@/app/(quote)/quote/turnstile', () => ({
    default: function FakeTurnstile({ onToken }: { onToken(token: string | null): void }) {
        useEffect(() => { onToken(widget.token) }, [onToken])
        return <div data-testid="turnstile" />
    },
}))

afterEach(() => { vi.mocked(emailCheckAction).mockReset(); vi.mocked(revealEmailAction).mockReset(); widget.token = 'tok' })

describe('EmailLink', () => {
    it('keeps the address out of the markup', () => {
        const html = renderToStaticMarkup(<EmailLink />)
        expect(html).not.toMatch(/koda|horizons\.gg|mailto/i)
    })

    it('shows the address, with a mail link and a copy button, once the check is passed', async () => {
        vi.mocked(emailCheckAction).mockResolvedValue({ siteKey: 'site-key' })
        vi.mocked(revealEmailAction).mockResolvedValue({ ok: true, email: 'koda@horizons.gg' })
        render(<EmailLink />)
        await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
        expect(await screen.findByText('koda@horizons.gg')).toBeInTheDocument()
        expect(revealEmailAction).toHaveBeenCalledWith('tok')
        expect(screen.getByRole('link', { name: /Open in your mail app/ })).toHaveAttribute('href', 'mailto:koda@horizons.gg')
        expect(screen.getByRole('button', { name: /Copy/ })).toBeInTheDocument()
    })

    it('offers another go when the check fails', async () => {
        vi.mocked(emailCheckAction).mockResolvedValue({ siteKey: 'site-key' })
        vi.mocked(revealEmailAction).mockResolvedValue({ ok: false })
        render(<EmailLink />)
        await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
        expect(await screen.findByText(/didn't go through/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
        expect(screen.queryByText('koda@horizons.gg')).not.toBeInTheDocument()
    })

    it('points to the other ways to get in touch when the check is unavailable', async () => {
        vi.mocked(emailCheckAction).mockResolvedValue({ siteKey: null })
        render(<EmailLink />)
        await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
        expect(await screen.findByText(/LinkedIn/)).toBeInTheDocument()
        expect(revealEmailAction).not.toHaveBeenCalled()
    })

    it('says so, and offers another go, when the widget itself fails', async () => {
        widget.token = null
        vi.mocked(emailCheckAction).mockResolvedValue({ siteKey: 'site-key' })
        render(<EmailLink />)
        await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
        expect(await screen.findByText(/didn't go through/)).toBeInTheDocument()
        expect(revealEmailAction).not.toHaveBeenCalled()
    })
})
