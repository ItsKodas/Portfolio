// The emails a client account produces. Every one about a security change exists so that a change made from
// the admin side cannot be silent.

import 'server-only'

import { escapeHtml, type Email } from '../quotes/emails'

type Who = { name: string, email: string }
type Options = { from: string, replyTo: string, siteUrl: string }

// Unlike the quote emails, the name here is text Koda typed in the admin area rather than text a stranger
// typed into a public form, so the greeting can use it without the quote form's precautions.
const build = (to: string, subject: string, lines: string[], options: Options): Email => ({
    from: options.from,
    to,
    replyTo: options.replyTo,
    subject,
    text: lines.join('\n\n'),
    html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join(''),
})

// The link goes in as text and is escaped like everything else; no anchor, so the plain and HTML versions show
// the same address and nothing is hidden behind link text
export function inviteEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, 'Your Horizons account is ready', [
        `Hi ${client.name},`,
        'Your client account is ready. Open this link to set your password:',
        `${options.siteUrl}/portal/invite/${token}`,
        'The link is valid for 7 days. You will also need an authenticator app on your phone, such as Google Authenticator, Authy or 1Password, because every client account is protected by a second factor.',
        'Koda',
    ], options)
}

export function resetEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, 'Reset your Horizons password', [
        `Hi ${client.name},`,
        'Open this link to set a new password:',
        `${options.siteUrl}/portal/reset/${token}`,
        // Softened rather than threaded through the three places that send this: a client who never finished
        // enrolment is not asked for a code, and telling them they will be is worse than saying less
        'The link is valid for one hour. If you have an authenticator app set up, you will be asked for a code as well.',
        "If you didn't ask for this, you can ignore this email and nothing will change.",
        'Koda',
    ], options)
}

export function passwordChangedEmail(client: Who, options: Options): Email {
    return build(client.email, 'Your Horizons password was changed', [
        `Hi ${client.name},`,
        'Your password has just been changed, and anything signed in elsewhere has been signed out.',
        "If that wasn't you, reply to this email straight away.",
        'Koda',
    ], options)
}

export function twoFactorResetEmail(client: Who, options: Options): Email {
    return build(client.email, 'Your Horizons two-factor setup was reset', [
        `Hi ${client.name},`,
        'The authenticator on your account has been reset, along with your recovery codes. Next time you sign in you will be asked to set up a new authenticator app.',
        "If you didn't ask for this, reply to this email straight away.",
        'Koda',
    ], options)
}

// Sent to both addresses, so a change of sign-in identity is visible from the old one too
export function emailChangedEmail(client: Who, options: Options & { to: string }): Email {
    return build(options.to, 'Your Horizons sign-in address has changed', [
        `Hi ${client.name},`,
        `The address you sign in with is now ${client.email}.`,
        "If you didn't ask for this, reply to this email straight away.",
        'Koda',
    ], options)
}
