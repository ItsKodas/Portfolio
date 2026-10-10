// The emails invoicing sends a client: the invoice itself, a reminder before it is due, notices once it is late,
// and a receipt when it is paid. Each one links to the invoice in the portal, where it can be paid, and the
// invoice email carries the PDF so the client has it without signing in.

import 'server-only'

import { button, callout, facts, fields, paragraph, render, type Attachment, type Block, type Email } from '../emails/layout'
import type { Business } from './business'
import { formatDay, type Day } from './days'
import { formatMoney } from './money'
import { invoiceNumber } from './standing'

type Options = { from: string, replyTo: string, siteUrl: string }

export type EmailInvoice = {
    id: string
    number: number | null
    billToName: string
    billToEmail: string
    totalCents: number
    currency: string
    issuedOn: Day | null
    dueOn: Day
    periodStart: Day | null
    periodEnd: Day | null
    // The plan's line, when a plan raised it
    planDescription?: string | null
}

const FOOTER = 'Sent to the billing address on your Horizons client account. Questions about an invoice? Just reply.'

const link = (invoice: EmailInvoice, options: Options) => `${options.siteUrl}/portal/billing/${invoice.id}`

const amount = (invoice: EmailInvoice) => `${formatMoney(invoice.totalCents, invoice.currency)} ${invoice.currency}`

function details(invoice: EmailInvoice, extra: [string, string][] = []): Block {
    const rows: [string, string][] = [
        ['Invoice', invoiceNumber(invoice.number)],
        ['Amount', amount(invoice)],
        ['Due', formatDay(invoice.dueOn)],
    ]
    if (invoice.planDescription && invoice.periodStart && invoice.periodEnd) {
        rows.push(['For', `${invoice.planDescription}, ${formatDay(invoice.periodStart)} to ${formatDay(invoice.periodEnd)}`])
    }
    return fields([...rows, ...extra])
}

const build = (invoice: EmailInvoice, options: Options, letter: {
    subject: string, preheader: string, eyebrow: string, heading: string, subheading?: string, blocks: Block[], attachments?: Attachment[],
}): Email => ({
    from: options.from,
    to: invoice.billToEmail,
    replyTo: options.replyTo,
    subject: letter.subject,
    ...render({
        preheader: letter.preheader, eyebrow: letter.eyebrow, heading: letter.heading, subheading: letter.subheading,
        footer: FOOTER, siteUrl: options.siteUrl,
        blocks: [paragraph(`Hi ${invoice.billToName},`), ...letter.blocks, paragraph('Koda')],
    }),
    ...(letter.attachments && { attachments: letter.attachments }),
})

export const pdfAttachment = (invoice: { number: number | null }, content: Buffer): Attachment =>
    ({ filename: `${invoiceNumber(invoice.number)}.pdf`, content, contentType: 'application/pdf' })

export function invoiceEmail(invoice: EmailInvoice, business: Business, options: Options & { pdf: Buffer }): Email {
    const number = invoiceNumber(invoice.number)
    return build(invoice, options, {
        subject: `Invoice ${number} from ${business.name}`,
        preheader: `${amount(invoice)}, due ${formatDay(invoice.dueOn)}. The PDF is attached.`,
        eyebrow: 'Invoice',
        heading: `${formatMoney(invoice.totalCents, invoice.currency)} due ${formatDay(invoice.dueOn)}`,
        subheading: `Invoice ${number} from ${business.name}`,
        blocks: [
            paragraph(`Here is invoice ${number}. A PDF copy is attached, and you can view and pay it in the portal.`),
            details(invoice),
            button('View and pay', link(invoice, options)),
            facts([
                { lead: 'Pay with PayPal or a card.', rest: 'Both go through PayPal, and you do not need a PayPal account for a card.' },
                ...(invoice.planDescription
                    ? [{ lead: 'Rather not do this every time?', rest: 'The same page can set this plan to pay itself automatically.' }]
                    : []),
            ]),
        ],
        attachments: [pdfAttachment(invoice, options.pdf)],
    })
}

export function reminderEmail(invoice: EmailInvoice, business: Business, options: Options): Email {
    const number = invoiceNumber(invoice.number)
    return build(invoice, options, {
        subject: `Reminder: invoice ${number} is due ${formatDay(invoice.dueOn)}`,
        preheader: `${amount(invoice)} to ${business.name}, due ${formatDay(invoice.dueOn)}.`,
        eyebrow: 'Payment reminder',
        heading: `Invoice ${number} is due soon`,
        blocks: [
            paragraph(`Just a reminder that invoice ${number} is due on ${formatDay(invoice.dueOn)}.`),
            details(invoice),
            button('View and pay', link(invoice, options)),
            paragraph('If you have already paid it, thank you, and you can ignore this email.'),
        ],
    })
}

export function overdueEmail(invoice: EmailInvoice, business: Business, options: Options & { notice: number }): Email {
    const number = invoiceNumber(invoice.number)
    const opening = options.notice <= 1
        ? `Invoice ${number} was due on ${formatDay(invoice.dueOn)} and has not been paid yet.`
        : `Invoice ${number} is still unpaid. It was due on ${formatDay(invoice.dueOn)}.`
    return build(invoice, options, {
        subject: `Overdue: invoice ${number} from ${business.name}`,
        preheader: `${amount(invoice)} was due ${formatDay(invoice.dueOn)}.`,
        eyebrow: 'Payment overdue',
        heading: `Invoice ${number} is overdue`,
        blocks: [
            paragraph(opening),
            details(invoice),
            button('View and pay', link(invoice, options)),
            callout('Already paid, or something not right?', 'Reply to this email and I will sort it out.'),
        ],
    })
}

export function receiptEmail(invoice: EmailInvoice, business: Business, options: Options & { amountCents: number, paidOn: Day, automatic: boolean }): Email {
    const number = invoiceNumber(invoice.number)
    return build(invoice, options, {
        subject: `Payment received for invoice ${number}`,
        preheader: `${formatMoney(options.amountCents, invoice.currency)} received. Thank you.`,
        eyebrow: 'Receipt',
        heading: 'Payment received, thank you',
        blocks: [
            paragraph(options.automatic
                ? `Your automatic payment for invoice ${number} has gone through.`
                : `Your payment for invoice ${number} has gone through.`),
            fields([
                ['Invoice', number],
                ['Paid', `${formatMoney(options.amountCents, invoice.currency)} ${invoice.currency}`],
                ['On', formatDay(options.paidOn)],
                ['Method', options.automatic ? 'PayPal, automatic payment' : 'PayPal'],
                ['To', `${business.name}, ABN ${business.abn}`],
            ]),
            button('View the invoice', link(invoice, options)),
        ],
    })
}
