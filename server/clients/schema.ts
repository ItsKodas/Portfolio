// The rules, shared by the browser forms (for instant feedback) and the server (whose answer is the only one
// that counts). No server-only import: this module is deliberately safe to bundle for the browser, so it must
// not import password.ts, secrets.ts or repo.ts.

import { z } from 'zod'

export const MIN_PASSWORD_LENGTH = 12
// Not a security rule. Very long input only burns scrypt time, which is the expensive path.
export const MAX_PASSWORD_LENGTH = 200

export const passwordSchema = z.string()
    // Length only. Composition rules push people towards Password1!, and current NIST guidance drops them.
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(MAX_PASSWORD_LENGTH, 'That password is too long.')

export const emailSchema = z.string()
    .trim()
    .min(1, 'Enter your email address.')
    .max(254, 'That email address is too long.')
    .email('Enter a valid email address.')
    .transform(value => value.toLowerCase())

// One box takes both a six digit code and a recovery code, so the person doesn't have to tell us which they
// are using. The pipeline tries the TOTP reading first and falls back to the recovery reading.
export const codeSchema = z.string().trim().min(1, 'Enter the code from your authenticator app.').max(32)

// A line break here would travel into an email header, so single-line fields refuse them, as the quote schema does
const singleLine = (max: number) => z.string().trim().max(max).refine(value => !/[\r\n]/.test(value), 'Remove the line break.')

export const clientDetailsSchema = z.object({
    name: singleLine(100).pipe(z.string().min(1, 'Enter a name.')),
    company: singleLine(100).transform(value => value || null).nullable(),
    email: emailSchema,
})

export type ClientDetails = z.infer<typeof clientDetailsSchema>

// Copied verbatim from hostd/src/shared/formats.ts, so the portal can never store an id hostd would refuse
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
export const RESERVED_PROJECT_IDS = ['hostd', 'mail', 'horizons'] as const

export const siteSchema = z.object({
    projectId: z.string().trim()
        .regex(PROJECT_ID, 'Use the project id from projects.yaml: lower case letters, digits and hyphens.')
        .refine(value => !RESERVED_PROJECT_IDS.includes(value as (typeof RESERVED_PROJECT_IDS)[number]),
            'That id is reserved for one of your own stacks.'),
    name: singleLine(100).pipe(z.string().min(1, 'Enter a name.')),
})

export type SiteInput = z.infer<typeof siteSchema>
