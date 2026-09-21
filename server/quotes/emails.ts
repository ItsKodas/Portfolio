// The two emails a quote produces: the full details to Koda, and a short thank-you to the prospect

import 'server-only'

import { button, fields, message, paragraph, render, type Email } from '../emails/layout'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, TIMELINE_LABELS, type Budget, type ProjectType, type Timeline } from './labels'

export type QuoteForEmail = {
    id: string
    createdAt: Date
    name: string
    email: string
    company: string | null
    website: string | null
    projectType: ProjectType | null
    budget: Budget | null
    timeline: Timeline | null
    message: string
    referenceSites: string[]
}

export function notificationEmail(quote: QuoteForEmail, options: { from: string, to: string, siteUrl: string }): Email {
    const link = `${options.siteUrl}/portal/quotes/${quote.id}`
    const rows: [string, string | null][] = [
        ['Name', quote.name],
        ['Email', quote.email],
        ['Company', quote.company],
        ['Website', quote.website],
        ['Project type', quote.projectType && PROJECT_TYPE_LABELS[quote.projectType]],
        ['Budget', quote.budget && BUDGET_LABELS[quote.budget]],
        ['Timeline', quote.timeline && TIMELINE_LABELS[quote.timeline]],
        ['Reference sites', quote.referenceSites.length ? quote.referenceSites.join('\n') : null],
    ]
    const given = rows.filter((row): row is [string, string] => !!row[1])

    // The shape of the ask, in the one line the inbox shows before anything is opened
    const summary = [
        quote.projectType && PROJECT_TYPE_LABELS[quote.projectType],
        quote.budget && BUDGET_LABELS[quote.budget],
        quote.timeline && TIMELINE_LABELS[quote.timeline],
    ].filter(Boolean).join(', ')

    const subject = quote.projectType ? `New quote: ${quote.name} (${PROJECT_TYPE_LABELS[quote.projectType]})` : `New quote: ${quote.name}`

    // Reply-To is the prospect, so hitting reply in Gmail answers them directly
    return {
        from: options.from,
        to: options.to,
        replyTo: quote.email,
        subject,
        ...render({
            preheader: summary || 'No project type, budget or timeline given.',
            eyebrow: 'New quote',
            heading: quote.name,
            subheading: summary || undefined,
            siteUrl: options.siteUrl,
            blocks: [
                fields(given),
                message(quote.message),
                button('Open it in the admin area', link),
            ],
            footer: 'Reply to this email to answer them directly.',
        }),
    }
}

// A name that looks like a link or an address isn't a name someone typed for themselves, it's text aimed at whoever
// reads the greeting, so those get the same generic greeting as a name that's just implausibly long
const looksSafeAsAGreeting = (name: string) => name.length <= 40 && !name.includes('://') && !name.includes('@') && !name.includes('www.')

// Takes only the name and address on purpose. Anyone can type any address into the form, so if this repeated what
// they wrote, the form would let a stranger send arbitrary text from Koda's domain to anyone. That also rules out
// a button: there is nothing here for them to do, so there is nothing for a forgery of it to imitate.
export function confirmationEmail(quote: { name: string, email: string }, options: { from: string, replyTo: string, siteUrl: string }): Email {
    const greeting = looksSafeAsAGreeting(quote.name) ? `Hi ${quote.name},` : 'Hi there,'
    return {
        from: options.from,
        to: quote.email,
        replyTo: options.replyTo,
        subject: "Thanks, I've got your request",
        ...render({
            preheader: 'It has come through, and I will be in touch soon.',
            eyebrow: 'Quote request',
            heading: "Thanks, I've got your request",
            siteUrl: options.siteUrl,
            blocks: [
                paragraph(greeting),
                paragraph("Thanks for getting in touch. Your request has come through, and I'll be in touch soon."),
                paragraph('If you think of anything to add, just reply to this email.'),
                paragraph('Koda'),
            ],
            footer: 'Sent because this address was given on a quote request at horizons.gg.',
        }),
    }
}

// A just-submitted quote has no timestamps for a few seconds while its emails go out, so it only counts as missing
// its emails after this long
export const EMAIL_GRACE_MS = 2 * 60 * 1000

export function emailsMissing(quote: { createdAt: Date, notifiedAt: Date | null, confirmedAt: Date | null }, now: Date): boolean {
    return (!quote.notifiedAt || !quote.confirmedAt) && now.getTime() - quote.createdAt.getTime() > EMAIL_GRACE_MS
}
