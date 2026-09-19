// What a quote request must look like. The form runs it in the browser for instant feedback, and the server runs it
// again, which is the check that counts. No server-only import: the browser form uses this file too.

import { z } from 'zod'

import { BUDGETS, PROJECT_TYPES, TIMELINES } from './labels'

export const MAX_REFERENCE_SITES = 5

// The form sends '' for fields left empty, which means "not given" rather than "given as blank"
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)

// Line breaks are refused so nothing typed here can reach an email header as a new line
const singleLine = (max: number) => z.string().trim()
    .max(max, `Keep this under ${max} characters`)
    .refine(text => !/[\r\n]/.test(text), 'Keep this on one line')

// Only http and https, so a stored link can never be a javascript: or data: URL when the admin area shows it
const webAddress = z.string().trim()
    .max(200, 'Keep links under 200 characters')
    .refine(text => {
        try {
            return ['http:', 'https:'].includes(new URL(text).protocol)
        } catch {
            return false
        }
    }, 'Enter a full web address, starting with https://')

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional()).transform(value => value ?? null)

const choice = <T extends readonly [string, ...string[]]>(options: T) => z.enum(options, 'Choose one of the options')

export const quoteSchema = z.object({
    name: singleLine(100).min(1, 'Please enter your name'),
    email: z.string().trim().max(254, 'Keep this under 254 characters').pipe(z.email('Please enter a valid email address')),
    message: z.string().trim()
        .min(10, 'Tell me a little more (at least 10 characters)')
        .max(5000, 'Keep this under 5,000 characters'),
    company: optional(singleLine(100)),
    website: optional(webAddress),
    projectType: optional(choice(PROJECT_TYPES)),
    budget: optional(choice(BUDGETS)),
    timeline: optional(choice(TIMELINES)),
    referenceSites: z.preprocess(
        value => (Array.isArray(value) ? value.filter(site => blankToUndefined(site) !== undefined) : value),
        z.array(webAddress).max(MAX_REFERENCE_SITES, `Up to ${MAX_REFERENCE_SITES} links`),
    ).default([]),
})

export type QuoteInput = z.output<typeof quoteSchema>
export type QuoteField = keyof QuoteInput
export type FieldErrors = Partial<Record<QuoteField, string>>

// The first problem with each field, which is all the form shows
export function firstErrors(error: z.ZodError): FieldErrors {
    const errors: FieldErrors = {}
    for (const issue of error.issues) {
        const field = issue.path[0] as QuoteField | undefined
        if (field && !errors[field]) errors[field] = issue.message
    }
    return errors
}
