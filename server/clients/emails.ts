// The emails a client account produces. Every one about a security change exists so that a change made from
// the admin side cannot be silent.

import 'server-only'

import { button, callout, facts, paragraph, render, type Block, type Email } from '../emails/layout'

type Who = { name: string, email: string }
type Options = { from: string, replyTo: string, siteUrl: string }

// Unlike the quote emails, the name here is text Koda typed in the admin area rather than text a stranger
// typed into a public form, so the greeting can use it without the quote form's precautions.
type Letter = {
    subject: string
    preheader: string
    eyebrow: string
    heading: string
    tone?: 'notice'
    blocks: Block[]
    footer: string
}

const ACTION_FOOTER = 'Sent to the address on your Horizons client account. If you were not expecting this, just reply and let me know.'

// A notice has no button, so it has no link either, and saying so is the point: a client who has learned that
// these emails never link is a client a forged one cannot move.
const NOTICE_FOOTER = 'Sent to you because something changed on your Horizons client account. This email contains no links, on purpose.'

const build = (to: string, letter: Letter, options: Options): Email => ({
    from: options.from,
    to,
    replyTo: options.replyTo,
    subject: letter.subject,
    ...render({ ...letter, siteUrl: options.siteUrl }),
})

// The greeting and the sign-off are the same shape in all five, so they are added here rather than repeated
const letter = (client: Who, blocks: Block[]): Block[] => [paragraph(`Hi ${client.name},`), ...blocks, paragraph('Koda')]

export function inviteEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, {
        subject: 'Your Horizons account is ready',
        preheader: 'Choose a password to finish setting up your account.',
        eyebrow: 'Client account',
        heading: 'Your account is ready',
        blocks: letter(client, [
            paragraph('Your client account has been set up. Choose a password to finish, and the portal is yours.'),
            button('Set your password', `${options.siteUrl}/portal/invite/${token}`),
            facts([
                { lead: 'The link is valid for 7 days.', rest: 'After that, ask me for a new one.' },
                {
                    lead: 'Have an authenticator app ready.',
                    rest: 'Google Authenticator, Authy or 1Password all work, because every client account is protected by a second factor.',
                },
            ]),
        ]),
        footer: 'Sent because a client account was created for you at horizons.gg. If you were not expecting this, just reply and let me know.',
    }, options)
}

export function resetEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, {
        subject: 'Reset your Horizons password',
        preheader: 'Open the link inside to choose a new one.',
        eyebrow: 'Client account',
        heading: 'Reset your password',
        blocks: letter(client, [
            paragraph('Open the link below to set a new password.'),
            button('Set a new password', `${options.siteUrl}/portal/reset/${token}`),
            // Softened rather than threaded through the three places that send this: a client who never finished
            // enrolment is not asked for a code, and telling them they will be is worse than saying less
            facts([{
                lead: 'The link is valid for one hour.',
                rest: 'If you have an authenticator app set up, you will be asked for a code as well.',
            }]),
            paragraph("If you didn't ask for this, you can ignore this email and nothing will change."),
        ]),
        footer: ACTION_FOOTER,
    }, options)
}

export function passwordChangedEmail(client: Who, options: Options): Email {
    return build(client.email, {
        subject: 'Your Horizons password was changed',
        preheader: 'Anything signed in elsewhere has been signed out.',
        eyebrow: 'Security notice',
        heading: 'Your password was changed',
        tone: 'notice',
        blocks: letter(client, [
            paragraph('Your password has just been changed, and anything signed in elsewhere has been signed out.'),
            callout("Wasn't that you?", 'Reply to this email straight away.'),
        ]),
        footer: NOTICE_FOOTER,
    }, options)
}

export function twoFactorResetEmail(client: Who, options: Options): Email {
    return build(client.email, {
        subject: 'Your Horizons two-factor setup was reset',
        preheader: 'You will set up a new authenticator app next time you sign in.',
        eyebrow: 'Security notice',
        heading: 'Your two-factor setup was reset',
        tone: 'notice',
        blocks: letter(client, [
            paragraph('The authenticator on your account has been reset, along with your recovery codes. Next time you sign in you will be asked to set up a new authenticator app.'),
            callout("Didn't ask for this?", 'Reply to this email straight away.'),
        ]),
        footer: NOTICE_FOOTER,
    }, options)
}

// Sent to both addresses, so a change of sign-in identity is visible from the old one too
export function emailChangedEmail(client: Who, options: Options & { to: string }): Email {
    return build(options.to, {
        subject: 'Your Horizons sign-in address has changed',
        preheader: 'The address you sign in with is not the one it was.',
        eyebrow: 'Security notice',
        heading: 'Your sign-in address has changed',
        tone: 'notice',
        blocks: letter(client, [
            paragraph(`The address you sign in with is now ${client.email}.`),
            callout("Didn't ask for this?", 'Reply to this email straight away.'),
        ]),
        footer: NOTICE_FOOTER,
    }, options)
}
