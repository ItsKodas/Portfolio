// The emails tax tracking sends the operator: the end of the financial year coming, the year closed, the tax
// return due, and GST turnover nearing or past the registration threshold. Each carries the year's figures as
// they stand and links to the Tax page. The figures are estimates, and every email says so.

import 'server-only'

import { button, callout, facts, fields, paragraph, render, type Block, type Email } from '../emails/layout'
import { daysBetween, formatDay, type Day } from '../invoices/days'
import { formatMoney } from '../invoices/money'
import { paymentDueOf, returnDueOf, type ReminderKind } from './dates'
import type { YearSummary } from './summary'
import { endOf, yearLabel } from './year'

export type TaxMailOptions = { from: string, to: string, siteUrl: string }

const FOOTER = 'Sent to you by your Horizons portal. The figures are estimates from the portal\'s own records, not tax advice.'

function figures(summary: YearSummary): Block {
    const rows: [string, string][] = [
        ['Income', formatMoney(summary.incomeCents)],
        ['Expenses', formatMoney(summary.expenseCents)],
        ['Profit', formatMoney(summary.profitCents)],
        ['Estimated tax', formatMoney(summary.estimate.totalCents)],
    ]
    if (summary.estimate.withheldCents) rows.push(['Still to pay, estimated', formatMoney(summary.estimate.owingCents)])
    return fields(rows)
}

function letter(options: TaxMailOptions, year: number, content: {
    subject: string, preheader: string, eyebrow: string, heading: string, subheading?: string, blocks: Block[], tone?: 'notice',
}): Email {
    return {
        from: options.from,
        to: options.to,
        replyTo: options.to,
        subject: content.subject,
        ...render({
            preheader: content.preheader, eyebrow: content.eyebrow, heading: content.heading, subheading: content.subheading,
            footer: FOOTER, siteUrl: options.siteUrl, tone: content.tone,
            blocks: [...content.blocks, button('Open the Tax page', `${options.siteUrl}/portal/tax?year=${year}`)],
        }),
    }
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export function reminderEmail(kind: ReminderKind, summary: YearSummary, today: Day, options: TaxMailOptions): Email {
    const label = yearLabel(summary.year)
    const end = endOf(summary.year)
    const due = returnDueOf(summary.year)
    const toEnd = Math.max(0, daysBetween(today, end))
    const toDue = daysBetween(today, due)

    switch (kind) {
        case 'eofy-30':
        case 'eofy-7':
            return letter(options, summary.year, {
                subject: `${days(toEnd)} until the end of the ${label} financial year`,
                preheader: `The year closes on ${formatDay(end)}. Profit so far ${formatMoney(summary.profitCents)}.`,
                eyebrow: 'End of financial year',
                heading: `${label} closes on ${formatDay(end)}`,
                blocks: [
                    paragraph(`There ${toEnd === 1 ? 'is' : 'are'} ${days(toEnd)} left in the ${label} financial year. Here is where it stands.`),
                    figures(summary),
                    facts([
                        { lead: 'Add any expenses you have not logged yet.', rest: 'Receipts for software, hosting, equipment, your phone and internet, and PayPal fees all lower the tax.' },
                        { lead: 'Thinking of buying something for the business?', rest: `Paying for it by ${formatDay(end)} counts it in this year rather than next.` },
                        { lead: 'Check for unpaid invoices.', rest: 'Income counts in the year it is paid, so anything still outstanding falls into next year.' },
                    ]),
                ],
            })
        case 'year-closed':
            return letter(options, summary.year, {
                subject: `The ${label} financial year has closed`,
                preheader: `Profit ${formatMoney(summary.profitCents)}, estimated tax ${formatMoney(summary.estimate.totalCents)}. The return is due ${formatDay(due)}.`,
                eyebrow: 'Year closed',
                heading: `Your ${label} figures`,
                subheading: `The tax return is due ${formatDay(due)} if you lodge it yourself.`,
                blocks: [
                    paragraph(`The ${label} financial year ended on ${formatDay(end)}. These are its final figures from the portal.`),
                    figures(summary),
                    facts([
                        { lead: 'Business income goes in the business schedule of your return.', rest: 'As a sole trader it is part of your own individual return, under your own tax file number.' },
                        { lead: 'Keep the records for five years.', rest: 'Invoices and expenses stay in the portal, and receipts should be kept alongside them.' },
                    ]),
                ],
            })
        case 'return-30':
        case 'return-7':
        case 'return-due':
            return letter(options, summary.year, {
                subject: kind === 'return-due' ? `Your ${label} tax return is due today` : `Your ${label} tax return is due in ${days(toDue)}`,
                preheader: `Due ${formatDay(due)} if you lodge it yourself. Estimated tax ${formatMoney(summary.estimate.totalCents)}.`,
                eyebrow: 'Tax return',
                heading: kind === 'return-due' ? 'Your tax return is due today' : `Your tax return is due ${formatDay(due)}`,
                blocks: [
                    paragraph(`The ${label} return is due on ${formatDay(due)} if you lodge it yourself through myGov. A registered tax agent can lodge later, as long as they have you on their books before then.`),
                    figures(summary),
                    paragraph(`Any tax owing is due by ${formatDay(paymentDueOf(summary.year))}. Once it is lodged, mark it lodged on the Tax page and these reminders stop.`),
                ],
            })
        case 'return-late':
            return letter(options, summary.year, {
                subject: `Your ${label} tax return is overdue`,
                preheader: `It was due ${formatDay(due)}.`,
                eyebrow: 'Tax return overdue',
                heading: `The ${label} return was due ${formatDay(due)}`,
                tone: 'notice',
                blocks: [
                    paragraph('It has not been marked lodged yet. Lodging late can bring a penalty, so it is worth doing soon, or getting a tax agent onto it.'),
                    figures(summary),
                    callout('Already lodged it?', 'Mark it lodged on the Tax page and these reminders stop.'),
                ],
            })
    }
}

export function gstEmail(level: 'near' | 'over', summary: YearSummary, options: TaxMailOptions): Email {
    const turnover = Math.max(summary.gst.rollingCents, summary.gst.projectedCents)
    const threshold = formatMoney(summary.gst.thresholdCents).replace(/\.00$/, '')
    return level === 'over'
        ? letter(options, summary.year, {
            subject: `Turnover has reached the ${threshold} GST threshold`,
            preheader: 'Registering for GST is required within 21 days.',
            eyebrow: 'GST',
            heading: 'Time to register for GST',
            tone: 'notice',
            blocks: [
                paragraph(`Your turnover is ${formatMoney(turnover)}, counting the last twelve months or this year at its current pace. At ${threshold} a business has to register for GST, within 21 days of reaching it.`),
                fields([['Last twelve months', formatMoney(summary.gst.rollingCents)], ['This year, projected', formatMoney(summary.gst.projectedCents)]]),
                facts([
                    { lead: 'Register through the ATO\'s Online services for business, or a tax agent.', rest: 'It takes a few minutes with your ABN.' },
                    { lead: 'Then set GST_REGISTERED=1 on the server.', rest: 'Invoices start adding 10% and calling themselves tax invoices. Invoices already sent are not changed.' },
                ]),
            ],
        })
        : letter(options, summary.year, {
            subject: `Turnover is nearing the ${threshold} GST threshold`,
            preheader: `${formatMoney(turnover)} so far.`,
            eyebrow: 'GST',
            heading: 'Getting close to the GST threshold',
            blocks: [
                paragraph(`Your turnover is ${formatMoney(turnover)}, counting the last twelve months or this year at its current pace. Registering for GST becomes compulsory at ${threshold}.`),
                fields([['Last twelve months', formatMoney(summary.gst.rollingCents)], ['This year, projected', formatMoney(summary.gst.projectedCents)]]),
                paragraph('Nothing to do yet. The portal emails again if it reaches the threshold.'),
            ],
        })
}
