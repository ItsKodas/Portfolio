// What the tax page's forms may send. Amounts arrive as typed ("1,250.50", "$99") and leave as whole cents.

import { z } from 'zod'

import { isDay } from '../invoices/days'
import { parseDollars } from '../invoices/money'

// The ATO's own groupings, near enough, so the totals carry straight across to a return's deduction labels
export const EXPENSE_CATEGORIES = [
    'Software and subscriptions',
    'Hosting and domains',
    'Equipment and computers',
    'Phone and internet',
    'Home office',
    'Bank and PayPal fees',
    'Advertising',
    'Accountant and tax agent',
    'Education and books',
    'Travel',
    'Insurance',
    'Other',
] as const

export const INCOME_CATEGORIES = [
    'Work paid outside the portal',
    'Interest',
    'Other',
] as const

const amount = z.union([z.string(), z.number()]).transform((value, context) => {
    const cents = typeof value === 'number' ? Math.round(value * 100) : parseDollars(value)
    if (cents === null || cents <= 0 || cents > 100_000_000) {
        context.addIssue({ code: 'custom', message: 'Enter an amount, such as 49.95.' })
        return z.NEVER
    }
    return cents
})

const day = z.string().refine(isDay, 'Choose a date.')

export const entrySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('EXPENSE'),
        occurredOn: day,
        description: z.string().trim().min(1, 'Say what it was for.').max(200),
        category: z.enum(EXPENSE_CATEGORIES, 'Choose a category.'),
        amountCents: amount,
        businessPercent: z.coerce.number().int('Use a whole percentage.').min(1, 'At least 1%.').max(100, 'At most 100%.'),
    }),
    z.object({
        kind: z.literal('INCOME'),
        occurredOn: day,
        description: z.string().trim().min(1, 'Say what it was for.').max(200),
        category: z.enum(INCOME_CATEGORIES, 'Choose a category.'),
        amountCents: amount,
    }).transform(entry => ({ ...entry, businessPercent: 100 })),
])

export type EntryInput = z.infer<typeof entrySchema>

const optionalAmount = z.union([z.string(), z.number()]).transform((value, context) => {
    if (typeof value === 'string' && value.trim() === '') return 0
    const cents = typeof value === 'number' ? Math.round(value * 100) : parseDollars(value)
    if (cents === null || cents < 0 || cents > 100_000_000) {
        context.addIssue({ code: 'custom', message: 'Enter an amount, or leave it empty.' })
        return z.NEVER
    }
    return cents
})

export const yearSchema = z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    otherIncomeCents: optionalAmount,
    withheldCents: optionalAmount,
    lodgedOn: z.union([z.literal(''), z.null(), day]).transform(value => value || null),
})

export type YearInput = z.infer<typeof yearSchema>

export const balanceSchema = z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    side: z.enum(['ASSET', 'LIABILITY'], 'Choose what it is.'),
    name: z.string().trim().min(1, 'Name it, such as "Business bank account".').max(120),
    amountCents: amount,
})

export type BalanceInput = z.infer<typeof balanceSchema>
