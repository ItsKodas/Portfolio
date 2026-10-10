// The rules for what the operator types into an invoice or a plan. No server-only import: the forms check the
// same rules in the browser, and the server's answer is the one that counts.

import { z } from 'zod'

import { isDay } from './days'
import { parseDollars } from './money'

// Big enough for any invoice this business will write, small enough that no sum of them leaves an Int
const MAX_CENTS = 10_000_000_00
const MAX_LINES = 50

const day = (message: string) => z.string().trim().refine(isDay, message)

// A price as typed ("1,250.50"), or as cents already. Read by hand rather than as a union, so the message
// a person sees is this one rather than zod's "Invalid input".
const amount = (message: string) => z.unknown().transform((value, context) => {
    const cents = typeof value === 'number' ? (Number.isInteger(value) && value >= 0 ? value : null)
        : typeof value === 'string' ? parseDollars(value) : null
    if (cents === null || cents > MAX_CENTS) {
        context.addIssue({ code: 'custom', message })
        return z.NEVER
    }
    return cents
})

// A number as typed or as given, with the message for anything that is not one
const number = (message: string, valid: (value: number) => boolean) => z.unknown().transform((value, context) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
    if (!Number.isFinite(parsed) || !valid(parsed)) {
        context.addIssue({ code: 'custom', message })
        return z.NEVER
    }
    return parsed
})

// Compared with a tolerance, because 1.1 * 100 is 110.00000000000001
const twoPlaces = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6

const quantity = number('Enter a quantity above zero.', value => value > 0 && value <= 100_000)
    .pipe(z.number().refine(twoPlaces, 'Use at most two decimal places in a quantity.'))
    .transform(value => Math.round(value * 100) / 100)

export const lineSchema = z.object({
    description: z.string().trim().min(1, 'Describe every line.').max(500, 'Keep each line under 500 characters.'),
    quantity,
    unitCents: amount('Enter each price as an amount, such as 120 or 99.50.'),
})

export const invoiceSchema = z.object({
    clientId: z.string().trim().min(1, 'Choose a client.').max(64),
    dueOn: day('Choose a due date.'),
    notes: z.string().trim().max(2000, 'Keep the notes under 2,000 characters.').transform(value => value || null).nullable(),
    lines: z.array(lineSchema).min(1, 'Add at least one line.').max(MAX_LINES, `An invoice can have up to ${MAX_LINES} lines.`),
})

export type InvoiceInput = z.infer<typeof invoiceSchema>

export const planSchema = z.object({
    description: z.string().trim().min(1, 'Describe the plan, such as "Website hosting".').max(200)
        .refine(value => !/[\r\n]/.test(value), 'Keep the description to one line.'),
    // Zero is allowed: a plan that is listed but never charged
    amountCents: amount('Enter the price as an amount, such as 49 or 49.95. Use 0 for a plan you do not charge for.'),
    interval: z.enum(['MONTHLY', 'YEARLY']),
    startsOn: day('Choose the day the plan starts.'),
    dueDays: number('Give the days to pay as a whole number up to 90.', value => Number.isInteger(value) && value >= 0 && value <= 90),
    siteId: z.string().trim().max(64).transform(value => value || null).nullable(),
})

export type PlanInput = z.infer<typeof planSchema>

export const paymentNoteSchema = z.string().trim().max(500, 'Keep the note under 500 characters.').transform(value => value || null).nullable()
