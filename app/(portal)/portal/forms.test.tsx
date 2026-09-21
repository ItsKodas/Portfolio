// What a person actually does with the client auth flows. These shipped working and nothing covered them,
// so this is written against the behaviour as it was before the MUI conversion, not after: submit empty,
// submit wrong, submit right, and the text that appears in each case. The conversion is mechanical, and a
// TOTP or recovery-code flow quietly changing behaviour is the thing it could break without anyone noticing.
//
// The server actions are mocked. Nothing here tests them: they have their own tests, and what is being
// pinned down is which of them a form calls, with what, and what the form does with the answer.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInAction = vi.fn()
const codeAction = vi.fn()
const completeInviteAction = vi.fn()
const completeResetAction = vi.fn()
const requestResetAction = vi.fn()
const confirmEnrolmentAction = vi.fn()
const acknowledgeCodesAction = vi.fn()
const changePasswordAction = vi.fn()
const regenerateCodesAction = vi.fn()
const signOutElsewhereAction = vi.fn()

vi.mock('./actions', () => ({
    signInAction: (...args: unknown[]) => signInAction(...args),
    codeAction: (...args: unknown[]) => codeAction(...args),
    completeInviteAction: (...args: unknown[]) => completeInviteAction(...args),
    completeResetAction: (...args: unknown[]) => completeResetAction(...args),
    requestResetAction: (...args: unknown[]) => requestResetAction(...args),
    confirmEnrolmentAction: (...args: unknown[]) => confirmEnrolmentAction(...args),
    acknowledgeCodesAction: (...args: unknown[]) => acknowledgeCodesAction(...args),
    changePasswordAction: (...args: unknown[]) => changePasswordAction(...args),
    regenerateCodesAction: (...args: unknown[]) => regenerateCodesAction(...args),
    signOutElsewhereAction: (...args: unknown[]) => signOutElsewhereAction(...args),
}))

const {
    ChangePasswordForm, CodeForm, EnrolmentForm, ForgotForm, InviteForm, Panel, RegenerateCodesForm,
    ResetForm, SignInForm, SignOutElsewhereButton,
} = await import('./forms')

// Long enough to pass passwordSchema's only rule, which is length
const GOOD = 'a-long-enough-password'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('Panel', () => {
    it('gives the page its one heading', () => {
        render(<Panel title="Client sign-in"><p>body</p></Panel>)
        expect(screen.getByRole('heading', { level: 1, name: 'Client sign-in' })).toBeInTheDocument()
    })
})

describe('the sign-in form', () => {
    it('will not submit while either box is empty', () => {
        render(<SignInForm />)
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    })

    it('refuses an address that is obviously not one, before any round trip', async () => {
        render(<SignInForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'not-an-address')
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
        expect(signInAction).not.toHaveBeenCalled()
    })

    it('refuses a password below the length the server asks for', async () => {
        render(<SignInForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.type(screen.getByLabelText('Password'), 'short')
        expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    })

    it('sends what was typed, in the order the action takes it', async () => {
        signInAction.mockResolvedValue({ ok: true })
        render(<SignInForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
        expect(signInAction).toHaveBeenCalledWith('a@b.com', GOOD)
    })

    it('shows the refusal the server gives back', async () => {
        signInAction.mockResolvedValue({ ok: false, error: 'That email address or password is wrong.' })
        render(<SignInForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
        expect(await screen.findByText('That email address or password is wrong.')).toBeInTheDocument()
    })

    it('says something rather than nothing when the action throws', async () => {
        signInAction.mockRejectedValue(new Error('network'))
        render(<SignInForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
        expect(await screen.findByText('That did not work. Try reloading the page.')).toBeInTheDocument()
    })

    it('offers the way out for someone who has forgotten their password', () => {
        render(<SignInForm />)
        expect(screen.getByRole('link', { name: 'Forgotten your password?' })).toHaveAttribute('href', '/portal/forgot')
    })
})

describe('the code step', () => {
    const label = 'Code from your authenticator app'

    it('says a recovery code works here too, which is the only place that is said', () => {
        render(<CodeForm />)
        expect(screen.getByText('A recovery code works here too.')).toBeInTheDocument()
    })

    it('will not submit an empty code', () => {
        render(<CodeForm />)
        expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    })

    // The one box takes both, so it must not refuse anything that is not six digits
    it('accepts a recovery code, not only a six digit one', async () => {
        codeAction.mockResolvedValue({ ok: true })
        render(<CodeForm />)
        await userEvent.type(screen.getByLabelText(label), 'abcd-efgh-jkmn')
        await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
        expect(codeAction).toHaveBeenCalledWith('abcd-efgh-jkmn')
    })

    it('sends a six digit code just as it was typed', async () => {
        codeAction.mockResolvedValue({ ok: true })
        render(<CodeForm />)
        await userEvent.type(screen.getByLabelText(label), '123456')
        await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
        expect(codeAction).toHaveBeenCalledWith('123456')
    })

    it('shows the refusal a wrong code gets', async () => {
        codeAction.mockResolvedValue({ ok: false, error: 'That code is not right.' })
        render(<CodeForm />)
        await userEvent.type(screen.getByLabelText(label), '000000')
        await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
        expect(await screen.findByText('That code is not right.')).toBeInTheDocument()
    })
})

describe('the invite form', () => {
    it('will not submit until both boxes are filled', async () => {
        render(<InviteForm token="t" />)
        expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled()
        await userEvent.type(screen.getByLabelText('Choose a password'), GOOD)
        expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled()
    })

    // Set once, from an emailed link, by someone who cannot easily try again: the typo is caught here
    it('catches two passwords that are not the same, before submitting', async () => {
        render(<InviteForm token="t" />)
        await userEvent.type(screen.getByLabelText('Choose a password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), `${GOOD}x`)
        expect(screen.getByText('Those two passwords are not the same.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled()
        expect(completeInviteAction).not.toHaveBeenCalled()
    })

    it('counts down to the length the server asks for', async () => {
        render(<InviteForm token="t" />)
        expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument()
        await userEvent.type(screen.getByLabelText('Choose a password'), 'ten-chars.')
        expect(screen.getByText('2 more to go.')).toBeInTheDocument()
    })

    it('sends the token and the password, and not the confirmation', async () => {
        completeInviteAction.mockResolvedValue({ ok: true })
        render(<InviteForm token="the-token" />)
        await userEvent.type(screen.getByLabelText('Choose a password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Set password' }))
        expect(completeInviteAction).toHaveBeenCalledWith('the-token', GOOD)
    })
})

describe('the reset form', () => {
    const codeLabel = 'Code from your authenticator app'

    it('asks for a code from a client who has an authenticator', () => {
        render(<ResetForm token="t" needsCode />)
        expect(screen.getByLabelText(codeLabel)).toBeInTheDocument()
    })

    // A client who never enrolled has nothing to be asked for, so the box is absent rather than disabled
    it('leaves the code out entirely for a client who never enrolled', () => {
        render(<ResetForm token="t" needsCode={false} />)
        expect(screen.queryByLabelText(codeLabel)).not.toBeInTheDocument()
    })

    it('sends an empty code when there is no authenticator to ask about', async () => {
        completeResetAction.mockResolvedValue({ ok: true })
        render(<ResetForm token="the-token" needsCode={false} />)
        await userEvent.type(screen.getByLabelText('Choose a new password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Reset password' }))
        expect(completeResetAction).toHaveBeenCalledWith('the-token', GOOD, '')
    })

    it('sends the code when there is one', async () => {
        completeResetAction.mockResolvedValue({ ok: true })
        render(<ResetForm token="the-token" needsCode />)
        await userEvent.type(screen.getByLabelText('Choose a new password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), GOOD)
        await userEvent.type(screen.getByLabelText(codeLabel), '123456')
        await userEvent.click(screen.getByRole('button', { name: 'Reset password' }))
        expect(completeResetAction).toHaveBeenCalledWith('the-token', GOOD, '123456')
    })

    it('will not submit without the code when one is needed', async () => {
        render(<ResetForm token="t" needsCode />)
        await userEvent.type(screen.getByLabelText('Choose a new password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), GOOD)
        expect(screen.getByRole('button', { name: 'Reset password' })).toBeDisabled()
    })

    it('catches a mistyped confirmation here too', async () => {
        render(<ResetForm token="t" needsCode={false} />)
        await userEvent.type(screen.getByLabelText('Choose a new password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), `${GOOD}x`)
        expect(screen.getByText('Those two passwords are not the same.')).toBeInTheDocument()
    })

    it('shows the refusal an expired token gets', async () => {
        completeResetAction.mockResolvedValue({ ok: false, error: 'That link has expired.' })
        render(<ResetForm token="t" needsCode={false} />)
        await userEvent.type(screen.getByLabelText('Choose a new password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Reset password' }))
        expect(await screen.findByText('That link has expired.')).toBeInTheDocument()
    })
})

describe('the forgot form', () => {
    it('will not submit an address that is obviously not one', async () => {
        render(<ForgotForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'nope')
        expect(screen.getByRole('button', { name: 'Send reset link' })).toBeDisabled()
    })

    // The one message covers every case, matching or not: anything else turns this into a way to find out
    // which addresses have accounts
    it('replaces the form with the one message, whoever was asked about', async () => {
        requestResetAction.mockResolvedValue({ message: 'If that address has an account, a link is on its way.' })
        render(<ForgotForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
        expect(await screen.findByText('If that address has an account, a link is on its way.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Send reset link' })).not.toBeInTheDocument()
    })

    // requestResetAction resolves to { message }, not a PortalResult, so this form has its own catch
    it('says something rather than nothing when the action throws', async () => {
        requestResetAction.mockRejectedValue(new Error('network'))
        render(<ForgotForm />)
        await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
        await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
        expect(await screen.findByText('That did not work. Try reloading the page.')).toBeInTheDocument()
    })
})

describe('enrolment', () => {
    const codeLabel = 'Code from your authenticator app'
    const props = { qr: 'data:image/png;base64,abc', typed: 'ABCD EFGH IJKL MNOP' }

    it('shows both ways of getting the secret into an app', () => {
        render(<EnrolmentForm {...props} />)
        expect(screen.getByAltText('QR code for your authenticator app')).toHaveAttribute('src', props.qr)
        expect(screen.getByText(props.typed)).toBeInTheDocument()
    })

    it('will not confirm an empty code', () => {
        render(<EnrolmentForm {...props} />)
        expect(screen.getByRole('button', { name: 'Confirm and continue' })).toBeDisabled()
    })

    it('shows the refusal a wrong code gets, and stays on the form', async () => {
        confirmEnrolmentAction.mockResolvedValue({ ok: false, error: 'That code is not right.' })
        render(<EnrolmentForm {...props} />)
        await userEvent.type(screen.getByLabelText(codeLabel), '000000')
        await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }))
        expect(await screen.findByText('That code is not right.')).toBeInTheDocument()
        expect(screen.getByLabelText(codeLabel)).toBeInTheDocument()
    })

    // The plaintext exists in that one response and nowhere else, so the form must show every one of them
    it('shows every recovery code the action returned, once the code is right', async () => {
        const codes = ['aaaa-1111', 'bbbb-2222', 'cccc-3333']
        confirmEnrolmentAction.mockResolvedValue({ ok: true, recoveryCodes: codes })
        render(<EnrolmentForm {...props} />)
        await userEvent.type(screen.getByLabelText(codeLabel), '123456')
        await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }))
        for (const code of codes) expect(await screen.findByText(code)).toBeInTheDocument()
        expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument()
    })

    it('only moves on once the client says they have saved them', async () => {
        confirmEnrolmentAction.mockResolvedValue({ ok: true, recoveryCodes: ['aaaa-1111'] })
        acknowledgeCodesAction.mockResolvedValue({ ok: true })
        render(<EnrolmentForm {...props} />)
        await userEvent.type(screen.getByLabelText(codeLabel), '123456')
        await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }))
        expect(acknowledgeCodesAction).not.toHaveBeenCalled()
        await userEvent.click(await screen.findByRole('button', { name: 'I have saved these' }))
        expect(acknowledgeCodesAction).toHaveBeenCalledOnce()
    })

    it('offers a way to copy them and a way to download them', async () => {
        confirmEnrolmentAction.mockResolvedValue({ ok: true, recoveryCodes: ['aaaa-1111', 'bbbb-2222'] })
        render(<EnrolmentForm {...props} />)
        await userEvent.type(screen.getByLabelText(codeLabel), '123456')
        await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }))
        expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    })
})

describe('the account page forms', () => {
    it('will not change a password until all three boxes agree', async () => {
        render(<ChangePasswordForm />)
        expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
        await userEvent.type(screen.getByLabelText('Current password'), 'whatever-it-was')
        await userEvent.type(screen.getByLabelText('New password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm new password'), `${GOOD}x`)
        expect(screen.getByText('Those two passwords are not the same.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    })

    it('sends the current password and the new one, in that order', async () => {
        changePasswordAction.mockResolvedValue({ ok: true })
        render(<ChangePasswordForm />)
        await userEvent.type(screen.getByLabelText('Current password'), 'whatever-it-was')
        await userEvent.type(screen.getByLabelText('New password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm new password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
        expect(changePasswordAction).toHaveBeenCalledWith('whatever-it-was', GOOD)
    })

    it('says what happened to the other sessions once the password is changed', async () => {
        changePasswordAction.mockResolvedValue({ ok: true })
        render(<ChangePasswordForm />)
        await userEvent.type(screen.getByLabelText('Current password'), 'whatever-it-was')
        await userEvent.type(screen.getByLabelText('New password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm new password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
        expect(await screen.findByText(/every other session has been signed out/i)).toBeInTheDocument()
        expect(screen.getByLabelText('Current password')).toHaveValue('')
    })

    // Clearing after a refusal throws away what someone who has just mistyped their password wants to keep
    it('keeps what was typed when the current password was wrong', async () => {
        changePasswordAction.mockResolvedValue({ ok: false, error: 'That password is wrong.' })
        render(<ChangePasswordForm />)
        await userEvent.type(screen.getByLabelText('Current password'), 'wrong-one')
        await userEvent.type(screen.getByLabelText('New password'), GOOD)
        await userEvent.type(screen.getByLabelText('Confirm new password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
        expect(await screen.findByText('That password is wrong.')).toBeInTheDocument()
        expect(screen.getByLabelText('Current password')).toHaveValue('wrong-one')
    })

    it('will not regenerate recovery codes without a password', () => {
        render(<RegenerateCodesForm />)
        expect(screen.getByRole('button', { name: 'Generate new codes' })).toBeDisabled()
    })

    it('shows the new codes and says the old ones have stopped working', async () => {
        regenerateCodesAction.mockResolvedValue({ ok: true, recoveryCodes: ['dddd-4444', 'eeee-5555'] })
        render(<RegenerateCodesForm />)
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Generate new codes' }))
        expect(await screen.findByText('dddd-4444')).toBeInTheDocument()
        expect(screen.getByText(/previous recovery codes have stopped working/i)).toBeInTheDocument()
    })

    it('keeps the password when it was refused, so it can be corrected', async () => {
        regenerateCodesAction.mockResolvedValue({ ok: false, error: 'That password is wrong.' })
        render(<RegenerateCodesForm />)
        await userEvent.type(screen.getByLabelText('Password'), GOOD)
        await userEvent.click(screen.getByRole('button', { name: 'Generate new codes' }))
        expect(await screen.findByText('That password is wrong.')).toBeInTheDocument()
        expect(screen.getByLabelText('Password')).toHaveValue(GOOD)
    })

    it('signs out everywhere else on one press', async () => {
        signOutElsewhereAction.mockResolvedValue({ ok: true })
        render(<SignOutElsewhereButton />)
        await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }))
        expect(signOutElsewhereAction).toHaveBeenCalledOnce()
    })
})
