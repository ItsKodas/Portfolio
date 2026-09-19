# Quote Form and Admin Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Postgres-backed "Get a quote" form to the site, with emails through a relay, and a Google-protected admin inbox for the quotes.

**Architecture:** Everything stays in the existing Next.js 15 app. Server-only code lives in `server/` (outside `app/`), written as small modules whose dependencies are passed in so they can be unit-tested without a database or network. The public form is `app/(quote)`, the admin area is `app/(admin)`, Auth.js runs from `app/api/auth` and a root `middleware.ts`. Postgres runs as a container beside the site; the wallpaper's static export skips the server-side route groups.

**Tech Stack:** Next.js 15.5 (App Router, React 18 types with Next's bundled React), TypeScript, Tailwind (public pages), MUI 6 (admin), Prisma 7.10 with `@prisma/adapter-pg`, Postgres 18, Auth.js (`next-auth@5.0.0-beta.32`), zod 4.6, nodemailer 8, Cloudflare Turnstile, Vitest 3.2, Docker Compose, Mailpit (local only).

**Spec:** `docs/superpowers/specs/2026-09-20-quote-form-and-admin-inbox-design.md`. Read it before starting any task.

## Global Constraints

- **No em dashes** (U+2014, or `&mdash;`) anywhere: page copy, UI text, README, docs, commit messages, PR descriptions. Code comments are the only exception. Use a comma, colon, full stop or parentheses.
- **Never change** anything affecting `koda@horizons.gg` or the `horizons.gg` apex mail records. Do not touch `mail/`.
- **Do not create accounts or enter passwords.** Google OAuth, Turnstile and the relay are set up by Koda.
- **Code style** (match `app/`): 4-space indentation, no semicolons, single quotes, comments that explain why. Files in `app/` use camelCase names (`quoteForm.tsx`); route files use Next's names (`page.tsx`, `layout.tsx`, `route.ts`).
- **Pinned versions:** `next-auth@5.0.0-beta.32`, `prisma@7.10.0`, `@prisma/client@7.10.0`, `@prisma/adapter-pg@7.10.0`, `zod@4.6.5`, `nodemailer@8.0.11`, `@types/nodemailer@8.0.2`, `server-only@0.0.1`, `@mui/material-nextjs@6.5.0`, `@emotion/cache@11.14.0`, `dotenv@18.0.1`, `vitest@3.2.7`. Install with exact versions (`npm install --save-exact`). `nodemailer` must stay on 8.x: `next-auth` declares an optional peer range of `^7.0.7 || ^8.0.5`.
- **Every module in `server/` imports `server-only`**, except `server/quotes/schema.ts`, `server/quotes/labels.ts` and `server/auth/allow.ts`/`server/auth/config.ts` (used by the browser form or by the middleware).
- **Every admin page and admin server action calls `requireAdmin()` first.**
- **The confirmation email to a prospect never contains their message or any free text they typed, apart from their name.**
- **Commits:** imperative sentence-case subject like the existing history ("Turn off amavis and stop Postfix trying IPv6 first"), and every commit message ends with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- The dev machine is Windows; run commands in Git Bash. Docker is available locally.

## File Structure

| Path | Responsibility |
| --- | --- |
| `server/testing/serverOnly.ts` | Empty stand-in for `server-only` under Vitest |
| `server/quotes/labels.ts` | The fixed choices (project type, budget, timeline, status) and their display words |
| `server/quotes/schema.ts` | The zod schema for a submission, and `firstErrors()` |
| `server/env.ts` | Reads and validates environment variables by group; `EnvError` |
| `server/ratelimit.ts` | `clientIp()`, `hashIp()`, the limit and window |
| `server/quotes/emails.ts` | Builds the two emails; `escapeHtml()`; `emailsMissing()` |
| `server/mailer.ts` | nodemailer transport for the relay |
| `server/quotes/deliver.ts` | Sends whichever of a quote's emails are still unsent and records them |
| `server/turnstile.ts` | Verifies a Turnstile token with Cloudflare |
| `server/quotes/submit.ts` | The submission pipeline (honeypot, Turnstile, rate limit, validation, save, emails after the response) |
| `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations/` | Database schema and migrations |
| `server/db.ts` | Creates and caches the Prisma client |
| `server/quotes/repo.ts` | Every database query the quotes feature makes |
| `server/quotes/wiring.ts` | Connects the pure modules to the real database, mailer, Turnstile and `after()` |
| `server/auth/allow.ts` | Who counts as the admin (pure) |
| `server/auth/config.ts` | Auth.js config shared by the middleware and the server |
| `server/auth/index.ts` | Auth.js instance, `requireAdmin()` |
| `middleware.ts` | Redirects `/admin/*` without a session |
| `app/(quote)/quote/*` | The public form page, its client form, Turnstile widget and server action |
| `app/(admin)/admin/*` | Admin layout, theme, header, inbox, quote page, controls, server actions, sign-in |
| `app/api/auth/[...nextauth]/route.ts` | Auth.js routes |
| `docker-compose.dev.yml`, `docker/dev-initdb/` | Local Postgres (with a test database) and Mailpit |
| `docker-compose.yml`, `dockerfile`, `scripts/db-backup.sh` | Production services, image, nightly dump |

---

### Task 1: Test tooling and the quote schema

**Files:**
- Modify: `package.json` (dependencies, `test` script)
- Modify: `tsconfig.json` (exclude `mail`)
- Modify: `vitest.config.ts`
- Create: `server/testing/serverOnly.ts`
- Create: `server/quotes/labels.ts`
- Create: `server/quotes/schema.ts`
- Test: `server/quotes/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `labels.ts`: `PROJECT_TYPES`, `BUDGETS`, `TIMELINES`, `STATUSES` (readonly string tuples); types `ProjectType`, `Budget`, `Timeline`, `Status`; `PROJECT_TYPE_LABELS: Record<ProjectType, string>`, `BUDGET_LABELS`, `TIMELINE_LABELS`, `STATUS_LABELS`
  - `schema.ts`: `quoteSchema` (zod object), `type QuoteInput = { name: string, email: string, message: string, company: string | null, website: string | null, projectType: ProjectType | null, budget: Budget | null, timeline: Timeline | null, referenceSites: string[] }`, `type QuoteField = keyof QuoteInput`, `type FieldErrors = Partial<Record<QuoteField, string>>`, `firstErrors(error: z.ZodError): FieldErrors`, `MAX_REFERENCE_SITES = 5`

- [ ] **Step 1: Install dependencies and wire up the test runner**

`vitest` is already in `package-lock.json` but missing from `package.json`; the install below records it properly.

```bash
npm install --save-exact zod@4.6.5 server-only@0.0.1
npm install --save-exact --save-dev vitest@3.2.7
```

In `package.json` `scripts`, add `"test": "vitest run"` (keep the existing scripts).

In `tsconfig.json`, change `"exclude"` to:

```json
  "exclude": ["node_modules", ".wallpaper-build", "mail"]
```

(`mail/mailops` has its own tsconfig and uses `.ts` import paths, which fail the root type-check today: `npx tsc --noEmit` currently reports only `mail/` errors.)

Replace `vitest.config.ts` with:

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        // server-only throws when imported outside a React server build, which is what keeps server code out of the
        // browser. Tests import that code directly, so here it resolves to an empty module instead.
        alias: { 'server-only': fileURLToPath(new URL('./server/testing/serverOnly.ts', import.meta.url)) },
    },
    test: {
        environment: 'node',
        include: ['app/**/*.test.ts', 'server/**/*.test.ts'],
    },
})
```

Create `server/testing/serverOnly.ts`:

```ts
// Stands in for the server-only package under Vitest (see vitest.config.ts)
export {}
```

- [ ] **Step 2: Write the labels**

Create `server/quotes/labels.ts`:

```ts
// The fixed choices on the quote form, and the words shown for each, in one place so the form, the emails and the
// admin area can't drift apart. The values match the enums in prisma/schema.prisma (labels.test.ts checks that).
// No server-only import: the browser form uses this file too.

export const PROJECT_TYPES = ['NEW_SITE', 'REDESIGN', 'WEB_APP', 'ONLINE_STORE', 'OTHER'] as const
export const BUDGETS = ['UNDER_2K', 'FROM_2K_TO_5K', 'FROM_5K_TO_10K', 'OVER_10K', 'NOT_SURE'] as const
export const TIMELINES = ['ASAP', 'ONE_TO_THREE_MONTHS', 'OVER_THREE_MONTHS', 'FLEXIBLE'] as const
export const STATUSES = ['NEW', 'REPLIED', 'WON', 'LOST'] as const

export type ProjectType = typeof PROJECT_TYPES[number]
export type Budget = typeof BUDGETS[number]
export type Timeline = typeof TIMELINES[number]
export type Status = typeof STATUSES[number]

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
    NEW_SITE: 'New website',
    REDESIGN: 'Redesign',
    WEB_APP: 'Web app',
    ONLINE_STORE: 'Online store',
    OTHER: 'Other',
}

// In Australian dollars
export const BUDGET_LABELS: Record<Budget, string> = {
    UNDER_2K: 'Under $2k',
    FROM_2K_TO_5K: '$2k to $5k',
    FROM_5K_TO_10K: '$5k to $10k',
    OVER_10K: '$10k+',
    NOT_SURE: 'Not sure yet',
}

export const TIMELINE_LABELS: Record<Timeline, string> = {
    ASAP: 'As soon as possible',
    ONE_TO_THREE_MONTHS: '1 to 3 months',
    OVER_THREE_MONTHS: '3+ months',
    FLEXIBLE: 'Flexible',
}

export const STATUS_LABELS: Record<Status, string> = {
    NEW: 'New',
    REPLIED: 'Replied',
    WON: 'Won',
    LOST: 'Lost',
}
```

- [ ] **Step 3: Write the failing schema tests**

Create `server/quotes/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { firstErrors, quoteSchema } from './schema'

const valid = { name: 'Ann Lee', email: 'ann@example.com', message: 'I would like a new website for my bakery.' }

const errorsFor = (input: unknown) => {
    const result = quoteSchema.safeParse(input)
    if (result.success) throw new Error('expected the input to be rejected')
    return firstErrors(result.error)
}

describe('quoteSchema', () => {
    it('accepts the required fields alone, with every optional field null', () => {
        expect(quoteSchema.parse(valid)).toEqual({
            ...valid,
            company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [],
        })
    })

    it('treats blank optional fields as not given, which is what the form sends for untouched fields', () => {
        const parsed = quoteSchema.parse({ ...valid, company: '  ', website: '', projectType: '', budget: '', timeline: '', referenceSites: ['', ' '] })
        expect(parsed).toMatchObject({ company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [] })
    })

    it('trims text', () => {
        expect(quoteSchema.parse({ ...valid, name: '  Ann  ', company: ' Bakery ' })).toMatchObject({ name: 'Ann', company: 'Bakery' })
    })

    it('keeps every option it offers', () => {
        const parsed = quoteSchema.parse({ ...valid, projectType: 'WEB_APP', budget: 'FROM_2K_TO_5K', timeline: 'FLEXIBLE' })
        expect(parsed).toMatchObject({ projectType: 'WEB_APP', budget: 'FROM_2K_TO_5K', timeline: 'FLEXIBLE' })
    })

    it('requires a name, an email and a message of at least 10 characters', () => {
        expect(errorsFor({ name: ' ', email: '', message: 'too short' })).toEqual({
            name: 'Please enter your name',
            email: 'Please enter a valid email address',
            message: 'Tell me a little more (at least 10 characters)',
        })
    })

    it('rejects line breaks in single-line fields, which keeps them out of email headers', () => {
        expect(errorsFor({ ...valid, name: 'Ann\nBcc: x@example.com', company: 'A\r\nB' })).toEqual({
            name: 'Keep this on one line',
            company: 'Keep this on one line',
        })
    })

    it('enforces the maximum lengths', () => {
        expect(errorsFor({ ...valid, name: 'a'.repeat(101), company: 'a'.repeat(101), message: 'a'.repeat(5001) })).toEqual({
            name: 'Keep this under 100 characters',
            company: 'Keep this under 100 characters',
            message: 'Keep this under 5,000 characters',
        })
        expect(errorsFor({ ...valid, email: `${'a'.repeat(250)}@example.com` })).toEqual({ email: 'Keep this under 254 characters' })
    })

    it('only accepts http and https web addresses', () => {
        for (const website of ['javascript:alert(1)', 'ftp://example.com', 'example.com', 'not a url']) {
            expect(errorsFor({ ...valid, website })).toEqual({ website: 'Enter a full web address, starting with https://' })
        }
        expect(quoteSchema.parse({ ...valid, website: 'http://example.com' }).website).toBe('http://example.com')
    })

    it('rejects web addresses over 200 characters', () => {
        expect(errorsFor({ ...valid, website: `https://example.com/${'a'.repeat(190)}` })).toEqual({ website: 'Keep links under 200 characters' })
    })

    it('accepts up to 5 reference sites, each a web address', () => {
        const five = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`)
        expect(quoteSchema.parse({ ...valid, referenceSites: five }).referenceSites).toEqual(five)
        expect(errorsFor({ ...valid, referenceSites: [...five, 'https://example.com/6'] })).toEqual({ referenceSites: 'Up to 5 links' })
        expect(errorsFor({ ...valid, referenceSites: ['javascript:alert(1)'] })).toEqual({ referenceSites: 'Enter a full web address, starting with https://' })
    })

    it('rejects options it does not offer', () => {
        expect(errorsFor({ ...valid, projectType: 'CASTLE', budget: 'MILLIONS', timeline: 'YESTERDAY' })).toEqual({
            projectType: 'Choose one of the options',
            budget: 'Choose one of the options',
            timeline: 'Choose one of the options',
        })
    })

    it('drops fields it does not know, such as the spam check fields', () => {
        expect(quoteSchema.parse({ ...valid, fax: 'x', turnstileToken: 'y' })).not.toHaveProperty('fax')
    })
})
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run server/quotes/schema.test.ts`
Expected: FAIL, cannot resolve `./schema`.

- [ ] **Step 5: Write the schema**

Create `server/quotes/schema.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run server/quotes/schema.test.ts`
Expected: PASS. Then run `npm test` (all existing `app/perf` tests still pass) and `npx tsc --noEmit` (no errors).

Note on the email length test: `a*250@example.com` is 262 characters, so it fails the max check. If zod reports both errors, `firstErrors` keeps the first, which is the length message because `.max` runs before `.pipe`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts server/testing/serverOnly.ts server/quotes/labels.ts server/quotes/schema.ts server/quotes/schema.test.ts
git commit -m "Define what a quote request looks like

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Environment settings and the IP helpers

**Files:**
- Create: `server/env.ts`
- Create: `server/ratelimit.ts`
- Test: `server/env.test.ts`, `server/ratelimit.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `env.ts`: `class EnvError extends Error { problems: string[] }`; `type Env = Record<string, string | undefined>`; `type MailConfig = { host: string, port: number, user?: string, pass?: string, from: string, notifyTo: string, replyTo: string, siteUrl: string }`; `mailConfig(env?: Env): MailConfig`; `turnstileSecret(env?: Env): string`; `ipHashKey(env?: Env): string`. All throw `EnvError` naming the missing variables (never their values).
  - `ratelimit.ts`: `RATE_LIMIT = 5`, `RATE_WINDOW_MS = 3_600_000`, `clientIp(headers: { get(name: string): string | null }): string`, `hashIp(ip: string, key: string): string`

- [ ] **Step 1: Write the failing tests**

Create `server/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { EnvError, ipHashKey, mailConfig, turnstileSecret } from './env'

const mail = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'resend',
    SMTP_PASS: 'secret-value',
    MAIL_FROM: 'Horizons <quotes@dev.horizons.gg>',
    QUOTE_NOTIFY_TO: 'koda@horizons.gg',
    QUOTE_REPLY_TO: 'info@dev.horizons.gg',
    AUTH_URL: 'https://www.horizons.gg/',
}

const problemsOf = (read: () => unknown) => {
    try {
        read()
    } catch (error) {
        if (error instanceof EnvError) return error.problems
        throw error
    }
    throw new Error('expected an EnvError')
}

describe('mailConfig', () => {
    it('reads the relay settings, without a trailing slash on the site address', () => {
        expect(mailConfig(mail)).toEqual({
            host: 'smtp.example.com', port: 587, user: 'resend', pass: 'secret-value',
            from: 'Horizons <quotes@dev.horizons.gg>', notifyTo: 'koda@horizons.gg', replyTo: 'info@dev.horizons.gg',
            siteUrl: 'https://www.horizons.gg',
        })
    })

    it('treats the login as optional, as Mailpit takes none', () => {
        const { SMTP_USER, SMTP_PASS, ...rest } = mail
        expect(mailConfig(rest)).toMatchObject({ user: undefined, pass: undefined })
    })

    it('names every missing setting at once', () => {
        expect(problemsOf(() => mailConfig({}))).toEqual([
            'SMTP_HOST is not set', 'SMTP_PORT is not set', 'MAIL_FROM is not set', 'QUOTE_NOTIFY_TO is not set',
            'QUOTE_REPLY_TO is not set', 'AUTH_URL is not set',
        ])
    })

    it('rejects a port that is not a port number', () => {
        expect(problemsOf(() => mailConfig({ ...mail, SMTP_PORT: 'smtp' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
        expect(problemsOf(() => mailConfig({ ...mail, SMTP_PORT: '70000' }))).toEqual(['SMTP_PORT must be a port number, such as 587'])
    })

    it('never puts a value in its message', () => {
        try {
            mailConfig({ ...mail, SMTP_HOST: '' })
        } catch (error) {
            expect(String(error)).not.toContain('secret-value')
        }
    })
})

describe('turnstileSecret and ipHashKey', () => {
    it('return the value when set', () => {
        expect(turnstileSecret({ TURNSTILE_SECRET_KEY: 'abc' })).toBe('abc')
        expect(ipHashKey({ AUTH_SECRET: 'def' })).toBe('def')
    })

    it('throw when missing or blank', () => {
        expect(problemsOf(() => turnstileSecret({ TURNSTILE_SECRET_KEY: ' ' }))).toEqual(['TURNSTILE_SECRET_KEY is not set'])
        expect(problemsOf(() => ipHashKey({}))).toEqual(['AUTH_SECRET is not set'])
    })
})
```

Create `server/ratelimit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { clientIp, hashIp } from './ratelimit'

const headers = (values: Record<string, string>) => new Headers(values)

describe('clientIp', () => {
    it("prefers Cloudflare's header", () => {
        expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.9')
    })

    it('falls back to the first X-Forwarded-For entry', () => {
        expect(clientIp(headers({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' }))).toBe('198.51.100.1')
    })

    it('uses "unknown" when neither is there, as in local development', () => {
        expect(clientIp(headers({}))).toBe('unknown')
    })
})

describe('hashIp', () => {
    it('is stable for the same IP and key, and never the IP itself', () => {
        const hash = hashIp('203.0.113.9', 'key')
        expect(hash).toBe(hashIp('203.0.113.9', 'key'))
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hash).not.toContain('203.0.113.9')
    })

    it('changes with the key, so the hashes cannot be reversed with a lookup table', () => {
        expect(hashIp('203.0.113.9', 'one')).not.toBe(hashIp('203.0.113.9', 'two'))
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run server/env.test.ts server/ratelimit.test.ts`
Expected: FAIL, cannot resolve `./env` and `./ratelimit`.

- [ ] **Step 3: Write the modules**

Create `server/env.ts`:

```ts
// Reads the settings each part of the quotes feature needs, one group at a time, so a missing relay setting only
// stops email (the quote is still saved) rather than the whole form. Errors name the variables, never their values.

import 'server-only'

export type Env = Record<string, string | undefined>

export class EnvError extends Error {
    constructor(readonly problems: string[]) {
        super(`Missing or invalid settings: ${problems.join('; ')}`)
        this.name = 'EnvError'
    }
}

function required(env: Env, name: string, problems: string[]): string {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is not set`)
    return value ?? ''
}

export type MailConfig = {
    host: string
    port: number
    user?: string
    pass?: string
    from: string
    notifyTo: string
    replyTo: string
    // The site's own address, for the link to a quote in the notification email
    siteUrl: string
}

export function mailConfig(env: Env = process.env): MailConfig {
    const problems: string[] = []
    const host = required(env, 'SMTP_HOST', problems)
    const portText = required(env, 'SMTP_PORT', problems)
    const port = Number(portText)
    if (portText && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push('SMTP_PORT must be a port number, such as 587')
    const from = required(env, 'MAIL_FROM', problems)
    const notifyTo = required(env, 'QUOTE_NOTIFY_TO', problems)
    const replyTo = required(env, 'QUOTE_REPLY_TO', problems)
    const siteUrl = required(env, 'AUTH_URL', problems)
    if (problems.length) throw new EnvError(problems)

    return {
        host, port, from, notifyTo, replyTo,
        user: env.SMTP_USER?.trim() || undefined,
        pass: env.SMTP_PASS || undefined,
        siteUrl: siteUrl.replace(/\/+$/, ''),
    }
}

function single(env: Env, name: string): string {
    const problems: string[] = []
    const value = required(env, name, problems)
    if (problems.length) throw new EnvError(problems)
    return value
}

// Without it every submission is refused (failing closed), rather than accepted unchecked
export const turnstileSecret = (env: Env = process.env) => single(env, 'TURNSTILE_SECRET_KEY')

// The IP hash is keyed with the sessions' secret, so there is one fewer secret to manage. Rotating it only resets
// the rate-limit window.
export const ipHashKey = (env: Env = process.env) => single(env, 'AUTH_SECRET')
```

Create `server/ratelimit.ts`:

```ts
// Who is submitting, as far as the rate limit is concerned: a keyed hash of their IP, so the IP itself is never stored

import 'server-only'

import { createHmac } from 'node:crypto'

// At most 5 saved quotes from one IP in an hour
export const RATE_LIMIT = 5
export const RATE_WINDOW_MS = 60 * 60 * 1000

// The site sits behind Cloudflare, which sets CF-Connecting-IP. Anyone reaching the origin port directly could forge
// it, which only lets them dodge the rate limit: Turnstile still has to pass (see the spec's accepted weaknesses).
export function clientIp(headers: { get(name: string): string | null }): string {
    const cloudflare = headers.get('cf-connecting-ip')?.trim()
    if (cloudflare) return cloudflare
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return forwarded || 'unknown'
}

export const hashIp = (ip: string, key: string) => createHmac('sha256', key).update(ip).digest('hex')
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run server/env.test.ts server/ratelimit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/env.ts server/env.test.ts server/ratelimit.ts server/ratelimit.test.ts
git commit -m "Read the quote settings and hash the sender's IP

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The two emails

**Files:**
- Create: `server/quotes/emails.ts`
- Test: `server/quotes/emails.test.ts`

**Interfaces:**
- Consumes: `labels.ts` (`PROJECT_TYPE_LABELS`, `BUDGET_LABELS`, `TIMELINE_LABELS`, the types)
- Produces: `type QuoteForEmail = { id: string, createdAt: Date, name: string, email: string, company: string | null, website: string | null, projectType: ProjectType | null, budget: Budget | null, timeline: Timeline | null, message: string, referenceSites: string[] }`; `type Email = { from: string, to: string, replyTo: string, subject: string, text: string, html: string }`; `escapeHtml(text: string): string`; `notificationEmail(quote: QuoteForEmail, options: { from: string, to: string, siteUrl: string }): Email`; `confirmationEmail(quote: { name: string, email: string }, options: { from: string, replyTo: string }): Email`; `EMAIL_GRACE_MS = 120_000`; `emailsMissing(quote: { createdAt: Date, notifiedAt: Date | null, confirmedAt: Date | null }, now: Date): boolean`

- [ ] **Step 1: Write the failing tests**

Create `server/quotes/emails.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { confirmationEmail, emailsMissing, escapeHtml, notificationEmail, type QuoteForEmail } from './emails'

const quote: QuoteForEmail = {
    id: 'q1',
    createdAt: new Date('2026-09-20T00:00:00Z'),
    name: 'Ann <b>Lee</b>',
    email: 'ann@example.com',
    company: 'Ann & Co',
    website: 'https://ann.example.com',
    projectType: 'WEB_APP',
    budget: 'FROM_2K_TO_5K',
    timeline: null,
    message: 'Build me a <script>alert(1)</script> booking system\nwith two lines',
    referenceSites: ['https://one.example.com', 'https://two.example.com'],
}

const notify = { from: 'Horizons <quotes@dev.horizons.gg>', to: 'koda@horizons.gg', siteUrl: 'https://www.horizons.gg' }
const confirm = { from: 'Horizons <quotes@dev.horizons.gg>', replyTo: 'info@dev.horizons.gg' }

describe('escapeHtml', () => {
    it('escapes everything that could open a tag or an attribute', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    })
})

describe('notificationEmail', () => {
    const email = notificationEmail(quote, notify)

    it('goes to Koda, with Reply-To set to the prospect so a reply reaches them', () => {
        expect(email).toMatchObject({ from: notify.from, to: 'koda@horizons.gg', replyTo: 'ann@example.com' })
    })

    it('names the sender and the project type in the subject', () => {
        expect(email.subject).toBe('New quote: Ann <b>Lee</b> (Web app)')
        expect(notificationEmail({ ...quote, projectType: null }, notify).subject).toBe('New quote: Ann <b>Lee</b>')
    })

    it('includes every given field, the message and a link to the quote', () => {
        for (const part of ['Ann & Co', 'https://ann.example.com', 'Web app', '$2k to $5k', 'https://one.example.com', 'https://two.example.com', 'with two lines', 'https://www.horizons.gg/admin/quotes/q1']) {
            expect(email.text).toContain(part)
        }
        expect(email.text).not.toContain('Timeline')
    })

    it('escapes every value in the HTML version', () => {
        expect(email.html).not.toContain('<script>')
        expect(email.html).not.toContain('<b>Lee</b>')
        expect(email.html).toContain('&lt;script&gt;')
        expect(email.html).toContain('Ann &amp; Co')
    })
})

describe('confirmationEmail', () => {
    const email = confirmationEmail(quote, confirm)

    it('goes to the prospect, with Reply-To set to the forwarded info address', () => {
        expect(email).toMatchObject({ from: confirm.from, to: 'ann@example.com', replyTo: 'info@dev.horizons.gg', subject: "Thanks, I've got your request" })
    })

    it('never repeats what the prospect typed, apart from their name', () => {
        for (const typed of ['booking system', 'Ann & Co', 'ann.example.com', 'one.example.com']) {
            expect(email.text).not.toContain(typed)
            expect(email.html).not.toContain(typed)
        }
        expect(email.text).toContain('Hi Ann <b>Lee</b>,')
        expect(email.html).toContain('Hi Ann &lt;b&gt;Lee&lt;/b&gt;,')
    })
})

describe('emailsMissing', () => {
    const at = (iso: string) => new Date(iso)
    const created = at('2026-09-20T00:00:00Z')

    it('gives a new quote two minutes before calling its emails missing', () => {
        const unsent = { createdAt: created, notifiedAt: null, confirmedAt: null }
        expect(emailsMissing(unsent, at('2026-09-20T00:01:59Z'))).toBe(false)
        expect(emailsMissing(unsent, at('2026-09-20T00:02:01Z'))).toBe(true)
    })

    it('is false once both are sent, and true when either is still unsent', () => {
        const later = at('2026-09-20T01:00:00Z')
        expect(emailsMissing({ createdAt: created, notifiedAt: created, confirmedAt: created }, later)).toBe(false)
        expect(emailsMissing({ createdAt: created, notifiedAt: created, confirmedAt: null }, later)).toBe(true)
        expect(emailsMissing({ createdAt: created, notifiedAt: null, confirmedAt: created }, later)).toBe(true)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run server/quotes/emails.test.ts`
Expected: FAIL, cannot resolve `./emails`.

- [ ] **Step 3: Write the module**

Create `server/quotes/emails.ts`:

```ts
// The two emails a quote produces: the full details to Koda, and a short thank-you to the prospect

import 'server-only'

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

export type Email = { from: string, to: string, replyTo: string, subject: string, text: string, html: string }

export const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const paragraphs = (lines: string[]) => lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')

export function notificationEmail(quote: QuoteForEmail, options: { from: string, to: string, siteUrl: string }): Email {
    const link = `${options.siteUrl}/admin/quotes/${quote.id}`
    const fields: [string, string | null][] = [
        ['Name', quote.name],
        ['Email', quote.email],
        ['Company', quote.company],
        ['Website', quote.website],
        ['Project type', quote.projectType && PROJECT_TYPE_LABELS[quote.projectType]],
        ['Budget', quote.budget && BUDGET_LABELS[quote.budget]],
        ['Timeline', quote.timeline && TIMELINE_LABELS[quote.timeline]],
        ['Reference sites', quote.referenceSites.length ? quote.referenceSites.join('\n') : null],
    ]
    const given = fields.filter((field): field is [string, string] => !!field[1])

    const subject = quote.projectType ? `New quote: ${quote.name} (${PROJECT_TYPE_LABELS[quote.projectType]})` : `New quote: ${quote.name}`
    const text = [
        ...given.map(([label, value]) => `${label}: ${value.replace(/\n/g, '\n    ')}`),
        '',
        quote.message,
        '',
        `Open it in the admin area: ${link}`,
    ].join('\n')
    const rows = given.map(([label, value]) =>
        `<tr><td valign="top"><b>${escapeHtml(label)}</b></td><td>${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`)
    const html = `<table cellpadding="4">${rows.join('')}</table>`
        + `<p style="white-space:pre-wrap">${escapeHtml(quote.message)}</p>`
        + `<p><a href="${escapeHtml(link)}">Open it in the admin area</a></p>`

    // Reply-To is the prospect, so hitting reply in Gmail answers them directly
    return { from: options.from, to: options.to, replyTo: quote.email, subject, text, html }
}

// Takes only the name and address on purpose. Anyone can type any address into the form, so if this repeated what
// they wrote, the form would let a stranger send arbitrary text from Koda's domain to anyone.
export function confirmationEmail(quote: { name: string, email: string }, options: { from: string, replyTo: string }): Email {
    const lines = [
        `Hi ${quote.name},`,
        "Thanks for getting in touch. Your request has come through, and I'll be in touch soon.",
        'If you think of anything to add, just reply to this email.',
        'Koda',
    ]
    return {
        from: options.from,
        to: quote.email,
        replyTo: options.replyTo,
        subject: "Thanks, I've got your request",
        text: lines.join('\n\n'),
        html: paragraphs(lines),
    }
}

// A just-submitted quote has no timestamps for a few seconds while its emails go out, so it only counts as missing
// its emails after this long
export const EMAIL_GRACE_MS = 2 * 60 * 1000

export function emailsMissing(quote: { createdAt: Date, notifiedAt: Date | null, confirmedAt: Date | null }, now: Date): boolean {
    return (!quote.notifiedAt || !quote.confirmedAt) && now.getTime() - quote.createdAt.getTime() > EMAIL_GRACE_MS
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run server/quotes/emails.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/quotes/emails.ts server/quotes/emails.test.ts
git commit -m "Write the notification and confirmation emails

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Sending and recording the emails

**Files:**
- Modify: `package.json` (nodemailer)
- Create: `server/mailer.ts`
- Create: `server/quotes/deliver.ts`
- Test: `server/quotes/deliver.test.ts`

**Interfaces:**
- Consumes: `MailConfig` (Task 2); `Email`, `QuoteForEmail`, `notificationEmail`, `confirmationEmail` (Task 3)
- Produces:
  - `mailer.ts`: `type SendEmail = (email: Email) => Promise<void>`; `createMailer(config: MailConfig): SendEmail`
  - `deliver.ts`: `type DeliverableQuote = QuoteForEmail & { notifiedAt: Date | null, confirmedAt: Date | null }`; `type DeliverDeps = { send: SendEmail, markNotified(id: string, at: Date): Promise<void>, markConfirmed(id: string, at: Date): Promise<void>, now(): Date, log(message: string, error?: unknown): void, mail: Pick<MailConfig, 'from' | 'notifyTo' | 'replyTo' | 'siteUrl'> }`; `type DeliverResult = { notified: boolean, confirmed: boolean }`; `deliverQuoteEmails(quote: DeliverableQuote, deps: DeliverDeps): Promise<DeliverResult>` (never throws)

- [ ] **Step 1: Install nodemailer**

```bash
npm install --save-exact nodemailer@8.0.11
npm install --save-exact --save-dev @types/nodemailer@8.0.2
```

- [ ] **Step 2: Write the failing tests**

Create `server/quotes/deliver.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { deliverQuoteEmails, type DeliverDeps, type DeliverableQuote } from './deliver'
import type { Email } from './emails'

const NOW = new Date('2026-09-20T01:00:00Z')

const quote: DeliverableQuote = {
    id: 'q1', createdAt: new Date('2026-09-20T00:00:00Z'), name: 'Ann', email: 'ann@example.com', company: null,
    website: null, projectType: null, budget: null, timeline: null, message: 'A new website please', referenceSites: [],
    notifiedAt: null, confirmedAt: null,
}

function fakes(options: { failTo?: string[], failMark?: boolean } = {}) {
    const sent: Email[] = []
    const marked: string[] = []
    const logged: string[] = []
    const deps: DeliverDeps = {
        send: async email => {
            if (options.failTo?.includes(email.to)) throw new Error('relay down')
            sent.push(email)
        },
        markNotified: async (id, at) => {
            if (options.failMark) throw new Error('db down')
            marked.push(`notified ${id} ${at.toISOString()}`)
        },
        markConfirmed: async (id, at) => {
            if (options.failMark) throw new Error('db down')
            marked.push(`confirmed ${id} ${at.toISOString()}`)
        },
        now: () => NOW,
        log: message => { logged.push(message) },
        mail: { from: 'Horizons <quotes@dev.horizons.gg>', notifyTo: 'koda@horizons.gg', replyTo: 'info@dev.horizons.gg', siteUrl: 'https://www.horizons.gg' },
    }
    return { deps, sent, marked, logged }
}

describe('deliverQuoteEmails', () => {
    it('sends both emails and records each one', async () => {
        const { deps, sent, marked } = fakes()
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: true, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['koda@horizons.gg', 'ann@example.com'])
        expect(marked).toEqual([`notified q1 ${NOW.toISOString()}`, `confirmed q1 ${NOW.toISOString()}`])
    })

    it('still sends the confirmation when the notification fails, and records only what was sent', async () => {
        const { deps, sent, marked, logged } = fakes({ failTo: ['koda@horizons.gg'] })
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: false, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['ann@example.com'])
        expect(marked).toEqual([`confirmed q1 ${NOW.toISOString()}`])
        expect(logged).toEqual(['Quote q1: the notification email was not sent'])
    })

    it('skips an email that was already sent, which is how a resend only sends the missing one', async () => {
        const { deps, sent } = fakes()
        const result = await deliverQuoteEmails({ ...quote, notifiedAt: NOW }, deps)
        expect(result).toEqual({ notified: true, confirmed: true })
        expect(sent.map(email => email.to)).toEqual(['ann@example.com'])
    })

    it('counts an email as sent even when recording it fails, and logs that', async () => {
        const { deps, logged } = fakes({ failMark: true })
        expect(await deliverQuoteEmails(quote, deps)).toEqual({ notified: true, confirmed: true })
        expect(logged).toEqual([
            'Quote q1: the notification email was sent but could not be recorded',
            'Quote q1: the confirmation email was sent but could not be recorded',
        ])
    })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run server/quotes/deliver.test.ts`
Expected: FAIL, cannot resolve `./deliver`.

- [ ] **Step 4: Write the modules**

Create `server/mailer.ts`:

```ts
// Sends through the transactional relay (or Mailpit locally) over plain SMTP, so any provider works

import 'server-only'

import nodemailer from 'nodemailer'

import type { MailConfig } from './env'
import type { Email } from './quotes/emails'

export type SendEmail = (email: Email) => Promise<void>

export function createMailer(config: MailConfig): SendEmail {
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        // 465 is TLS from the first byte; other ports upgrade with STARTTLS whenever the server offers it
        secure: config.port === 465,
        auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    })
    return async email => {
        await transport.sendMail(email)
    }
}
```

Create `server/quotes/deliver.ts`:

```ts
// Sends whichever of a quote's two emails haven't gone yet, and records each one that does. Used right after a quote
// is saved, and again by the admin area's resend button. Never throws: a failure is logged and left unrecorded, which
// is what makes the admin area show "email not sent".

import 'server-only'

import type { MailConfig } from '../env'
import type { SendEmail } from '../mailer'
import { confirmationEmail, notificationEmail, type Email, type QuoteForEmail } from './emails'

export type DeliverableQuote = QuoteForEmail & { notifiedAt: Date | null, confirmedAt: Date | null }

export type DeliverDeps = {
    send: SendEmail
    markNotified(id: string, at: Date): Promise<void>
    markConfirmed(id: string, at: Date): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    mail: Pick<MailConfig, 'from' | 'notifyTo' | 'replyTo' | 'siteUrl'>
}

export type DeliverResult = { notified: boolean, confirmed: boolean }

export async function deliverQuoteEmails(quote: DeliverableQuote, deps: DeliverDeps): Promise<DeliverResult> {
    const { mail } = deps

    async function attempt(kind: string, email: Email, record: (at: Date) => Promise<void>): Promise<boolean> {
        try {
            await deps.send(email)
        } catch (error) {
            deps.log(`Quote ${quote.id}: the ${kind} email was not sent`, error)
            return false
        }
        try {
            await record(deps.now())
        } catch (error) {
            // It did go, so it counts as sent; the admin area may offer a resend that would send it twice
            deps.log(`Quote ${quote.id}: the ${kind} email was sent but could not be recorded`, error)
        }
        return true
    }

    // One after the other but independent: a failed notification doesn't stop the confirmation, or the reverse
    const notified = quote.notifiedAt !== null || await attempt(
        'notification',
        notificationEmail(quote, { from: mail.from, to: mail.notifyTo, siteUrl: mail.siteUrl }),
        at => deps.markNotified(quote.id, at),
    )
    const confirmed = quote.confirmedAt !== null || await attempt(
        'confirmation',
        confirmationEmail(quote, { from: mail.from, replyTo: mail.replyTo }),
        at => deps.markConfirmed(quote.id, at),
    )
    return { notified, confirmed }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run server/quotes/deliver.test.ts` then `npx tsc --noEmit`
Expected: PASS, and no type errors (this checks `Email` is accepted by `transport.sendMail`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/mailer.ts server/quotes/deliver.ts server/quotes/deliver.test.ts
git commit -m "Send a quote's emails through the relay and record each one

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Turnstile and the submission pipeline

**Files:**
- Create: `server/turnstile.ts`
- Create: `server/quotes/submit.ts`
- Test: `server/turnstile.test.ts`, `server/quotes/submit.test.ts`

**Interfaces:**
- Consumes: `quoteSchema`, `firstErrors`, `QuoteInput`, `FieldErrors` (Task 1); `RATE_LIMIT`, `RATE_WINDOW_MS` (Task 2)
- Produces:
  - `turnstile.ts`: `SITEVERIFY_URL`; `verifyTurnstile(token: string, ip: string, secret: string, fetchImpl?: typeof fetch): Promise<boolean>` (throws on network errors)
  - `submit.ts`: `HONEYPOT_FIELD = 'fax'`; `type SubmitResult = { ok: true } | { ok: false, reason: 'turnstile' | 'rate-limited' | 'server' } | { ok: false, reason: 'invalid', fieldErrors: FieldErrors }`; `type SubmitDeps = { verifyTurnstile(token: string, ip: string): Promise<boolean>, hashIp(ip: string): string, countRecent(ipHash: string, since: Date): Promise<number>, save(input: QuoteInput, ipHash: string): Promise<{ id: string }>, afterResponse(task: () => Promise<void>): void, deliver(id: string): Promise<void>, now(): Date, log(message: string, error?: unknown): void }`; `submitQuote(raw: unknown, ip: string, deps: SubmitDeps): Promise<SubmitResult>`

- [ ] **Step 1: Write the failing tests**

Create `server/turnstile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { SITEVERIFY_URL, verifyTurnstile } from './turnstile'

function fakeFetch(status: number, body: unknown) {
    const calls: { url: string, body: URLSearchParams }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as URLSearchParams })
        return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('verifyTurnstile', () => {
    it("sends the secret, the token and the visitor's IP to Cloudflare", async () => {
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        expect(await verifyTurnstile('token', '203.0.113.9', 'secret', fetchImpl)).toBe(true)
        expect(calls[0].url).toBe(SITEVERIFY_URL)
        expect(Object.fromEntries(calls[0].body)).toEqual({ secret: 'secret', response: 'token', remoteip: '203.0.113.9' })
    })

    it('leaves the IP out when it is unknown', async () => {
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        await verifyTurnstile('token', 'unknown', 'secret', fetchImpl)
        expect(calls[0].body.has('remoteip')).toBe(false)
    })

    it('fails when Cloudflare says so, answers with an error, or there is no token', async () => {
        expect(await verifyTurnstile('token', 'unknown', 'secret', fakeFetch(200, { success: false }).fetchImpl)).toBe(false)
        expect(await verifyTurnstile('token', 'unknown', 'secret', fakeFetch(500, {}).fetchImpl)).toBe(false)
        const { fetchImpl, calls } = fakeFetch(200, { success: true })
        expect(await verifyTurnstile('', 'unknown', 'secret', fetchImpl)).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
```

Create `server/quotes/submit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { submitQuote, type SubmitDeps } from './submit'

const NOW = new Date('2026-09-20T01:00:00Z')
const valid = { name: 'Ann', email: 'ann@example.com', message: 'A new website please', turnstileToken: 'token', fax: '' }

function fakes(overrides: Partial<SubmitDeps> = {}) {
    const events: string[] = []
    const tasks: (() => Promise<void>)[] = []
    const deps: SubmitDeps = {
        verifyTurnstile: async token => { events.push(`turnstile ${token}`); return true },
        hashIp: ip => `hash(${ip})`,
        countRecent: async (ipHash, since) => { events.push(`count ${ipHash} since ${since.toISOString()}`); return 0 },
        save: async input => { events.push(`save ${input.name}`); return { id: 'q1' } },
        afterResponse: task => { events.push('scheduled'); tasks.push(task) },
        deliver: async id => { events.push(`deliver ${id}`) },
        now: () => NOW,
        log: message => { events.push(`log ${message}`) },
        ...overrides,
    }
    // Runs what would run after the response, as after() would
    const flush = async () => { for (const task of tasks) await task() }
    return { deps, events, flush }
}

describe('submitQuote', () => {
    it('checks, saves, and only then schedules the emails for after the response', async () => {
        const { deps, events, flush } = fakes()
        expect(await submitQuote(valid, '203.0.113.9', deps)).toEqual({ ok: true })
        expect(events).toEqual([
            'turnstile token',
            'count hash(203.0.113.9) since 2026-09-20T00:00:00.000Z',
            'save Ann',
            'scheduled',
        ])
        await flush()
        expect(events.at(-1)).toBe('deliver q1')
    })

    it('reports success to a bot that fills in the honeypot, and does nothing else', async () => {
        const { deps, events } = fakes()
        expect(await submitQuote({ ...valid, fax: '555 1234' }, 'ip', deps)).toEqual({ ok: true })
        expect(events).toEqual([])
    })

    it('stops at a failed or broken Turnstile check', async () => {
        const failed = fakes({ verifyTurnstile: async () => false })
        expect(await submitQuote(valid, 'ip', failed.deps)).toEqual({ ok: false, reason: 'turnstile' })
        expect(failed.events).toEqual([])

        const broken = fakes({ verifyTurnstile: async () => { throw new Error('TURNSTILE_SECRET_KEY is not set') } })
        expect(await submitQuote(valid, 'ip', broken.deps)).toEqual({ ok: false, reason: 'turnstile' })
        expect(broken.events).toEqual(['log Turnstile check failed'])
    })

    it('refuses the sixth quote from one IP within the hour', async () => {
        const { deps, events } = fakes({ countRecent: async () => 5 })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'rate-limited' })
        expect(events.some(event => event.startsWith('save'))).toBe(false)
    })

    it('allows the fifth', async () => {
        const { deps } = fakes({ countRecent: async () => 4 })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: true })
    })

    it('returns field errors for invalid input, without saving', async () => {
        const { deps, events } = fakes()
        expect(await submitQuote({ ...valid, email: 'nope' }, 'ip', deps)).toEqual({
            ok: false, reason: 'invalid', fieldErrors: { email: 'Please enter a valid email address' },
        })
        expect(events.some(event => event.startsWith('save'))).toBe(false)
    })

    it('saves the validated values, not the raw ones, with the IP hash', async () => {
        let saved: unknown
        const { deps } = fakes({ save: async (input, ipHash) => { saved = { input, ipHash }; return { id: 'q1' } } })
        await submitQuote({ ...valid, name: '  Ann  ', company: '' }, 'ip', deps)
        expect(saved).toEqual({
            ipHash: 'hash(ip)',
            input: { name: 'Ann', email: 'ann@example.com', message: 'A new website please', company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [] },
        })
    })

    it('reports a server error, and schedules nothing, when saving fails', async () => {
        const { deps, events } = fakes({ save: async () => { throw new Error('db down') } })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'server' })
        expect(events).not.toContain('scheduled')
        expect(events).toContain('log Saving a quote failed')
    })

    it('reports a server error when the rate limit cannot be checked', async () => {
        const { deps } = fakes({ countRecent: async () => { throw new Error('db down') } })
        expect(await submitQuote(valid, 'ip', deps)).toEqual({ ok: false, reason: 'server' })
    })

    it('logs, rather than throws, when sending the emails fails after the response', async () => {
        const { deps, events, flush } = fakes({ deliver: async () => { throw new Error('no settings') } })
        await submitQuote(valid, 'ip', deps)
        await flush()
        expect(events.at(-1)).toBe('log Quote q1: sending its emails failed')
    })

    it('copes with input that is not an object', async () => {
        const { deps } = fakes({ verifyTurnstile: async token => token !== '' })
        expect(await submitQuote(null, 'ip', deps)).toEqual({ ok: false, reason: 'turnstile' })
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run server/turnstile.test.ts server/quotes/submit.test.ts`
Expected: FAIL, cannot resolve `./turnstile` and `./submit`.

- [ ] **Step 3: Write the modules**

Create `server/turnstile.ts`:

```ts
// Asks Cloudflare whether a Turnstile token (from the widget on the form) came from a person

import 'server-only'

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstile(token: string, ip: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (!token) return false
    const body = new URLSearchParams({ secret, response: token })
    if (ip !== 'unknown') body.set('remoteip', ip)
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return false
    const result = await response.json() as { success?: unknown }
    return result.success === true
}
```

Create `server/quotes/submit.ts`:

```ts
// What happens when someone sends the quote form, in order: the honeypot, Turnstile, the rate limit, validation, the
// save, and then the emails, which run after the response so nobody waits on the relay. Everything it touches is passed
// in (see wiring.ts for the real ones), so it can be tested without a database or the network.

import 'server-only'

import { RATE_LIMIT, RATE_WINDOW_MS } from '../ratelimit'
import { firstErrors, quoteSchema, type FieldErrors, type QuoteInput } from './schema'

// The hidden field people never fill in. A plausible name, so bots do.
export const HONEYPOT_FIELD = 'fax'

export type SubmitResult =
    | { ok: true }
    | { ok: false, reason: 'turnstile' | 'rate-limited' | 'server' }
    | { ok: false, reason: 'invalid', fieldErrors: FieldErrors }

export type SubmitDeps = {
    verifyTurnstile(token: string, ip: string): Promise<boolean>
    hashIp(ip: string): string
    countRecent(ipHash: string, since: Date): Promise<number>
    save(input: QuoteInput, ipHash: string): Promise<{ id: string }>
    afterResponse(task: () => Promise<void>): void
    deliver(id: string): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

export async function submitQuote(raw: unknown, ip: string, deps: SubmitDeps): Promise<SubmitResult> {
    const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

    // A bot filled in the field people never see. It gets the answer a person would, so it has nothing to learn from.
    const trap = fields[HONEYPOT_FIELD]
    if (typeof trap === 'string' && trap.trim() !== '') return { ok: true }

    const token = typeof fields.turnstileToken === 'string' ? fields.turnstileToken : ''
    let human = false
    try {
        human = await deps.verifyTurnstile(token, ip)
    } catch (error) {
        // Includes a missing secret key: refusing is safer than accepting everything unchecked
        deps.log('Turnstile check failed', error)
    }
    if (!human) return { ok: false, reason: 'turnstile' }

    let ipHash: string
    let recent: number
    try {
        ipHash = deps.hashIp(ip)
        recent = await deps.countRecent(ipHash, new Date(deps.now().getTime() - RATE_WINDOW_MS))
    } catch (error) {
        deps.log('Rate limit check failed', error)
        return { ok: false, reason: 'server' }
    }
    if (recent >= RATE_LIMIT) return { ok: false, reason: 'rate-limited' }

    const parsed = quoteSchema.safeParse(fields)
    if (!parsed.success) return { ok: false, reason: 'invalid', fieldErrors: firstErrors(parsed.error) }

    let id: string
    try {
        ({ id } = await deps.save(parsed.data, ipHash))
    } catch (error) {
        deps.log('Saving a quote failed', error)
        return { ok: false, reason: 'server' }
    }

    // The quote is safe in the database from here, so nothing that goes wrong with email can lose it
    deps.afterResponse(async () => {
        try {
            await deps.deliver(id)
        } catch (error) {
            deps.log(`Quote ${id}: sending its emails failed`, error)
        }
    })
    return { ok: true }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run server/turnstile.test.ts server/quotes/submit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/turnstile.ts server/turnstile.test.ts server/quotes/submit.ts server/quotes/submit.test.ts
git commit -m "Check, save and email a submitted quote

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The database

**Files:**
- Modify: `package.json` (Prisma, dotenv, scripts), `.gitignore`, `eslint.config.mjs`
- Create: `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations/*` (generated)
- Create: `docker-compose.dev.yml`, `docker/dev-initdb/01-test-database.sql`, `.env.example`
- Create: `server/db.ts`, `server/quotes/repo.ts`
- Test: `server/quotes/labels.test.ts`, `server/quotes/repo.test.ts`

**Interfaces:**
- Consumes: `QuoteInput` (Task 1), label tuples (Task 1), `Status` (Task 1)
- Produces:
  - Generated client at `server/generated/prisma` (gitignored); import `PrismaClient` from `server/generated/prisma/client`, enums from `server/generated/prisma/enums`
  - `db.ts`: `createDb(connectionString: string): PrismaClient`; `getDb(): PrismaClient`
  - `repo.ts`: `type InboxFilter = { status?: Status, archived: boolean }`; `quoteRepo(db: PrismaClient)` returning `{ create(input: QuoteInput, ipHash: string): Promise<{ id: string }>, countRecent(ipHash: string, since: Date): Promise<number>, list(filter: InboxFilter): Promise<InboxRow[]>, countNew(): Promise<number>, get(id: string): Promise<(Quote & { notes: Note[] }) | null>, setStatus(id: string, status: Status): Promise<void>, setArchived(id: string, archived: boolean, now: Date): Promise<void>, remove(id: string): Promise<void>, addNote(quoteId: string, body: string): Promise<void>, removeNote(quoteId: string, noteId: string): Promise<void>, markNotified(id: string, at: Date): Promise<void>, markConfirmed(id: string, at: Date): Promise<void> }`; `type QuoteRepo = ReturnType<typeof quoteRepo>`; `type InboxRow = { id, createdAt, name, company, projectType, budget, status, notifiedAt, confirmedAt }`

- [ ] **Step 1: Install Prisma and set up the local services**

```bash
npm install --save-exact @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0
npm install --save-exact --save-dev prisma@7.10.0 dotenv@18.0.1
```

In `package.json` `scripts`, set (keeping `start`, `lint`, `wallpaper`, `wallpaper:serve`):

```json
    "dev": "prisma generate && next dev",
    "build": "prisma generate && next build",
    "test": "prisma generate && vitest run",
    "db:migrate": "prisma migrate dev",
    "services": "docker compose -f docker-compose.dev.yml up -d",
```

In `.gitignore`, add under `# env files (can opt-in for committing if needed)`:

```
!.env.example
```

and under `# next.js`:

```
/server/generated/
```

In `eslint.config.mjs`, make the array start with an ignore entry:

```js
const eslintConfig = [
  // Prisma's generated client
  { ignores: ["server/generated/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
```

Create `docker-compose.dev.yml`:

```yaml
# Local development only: Postgres, and Mailpit, which catches every email the site sends (read them at
# http://localhost:8025). The site itself runs with npm run dev. Start these with npm run services.

name: horizons-dev

services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: horizons
      POSTGRES_PASSWORD: horizons
      POSTGRES_DB: horizons
    # 5433, so that a Postgres already installed on the machine can keep 5432
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - dev-db:/var/lib/postgresql
      # Creates the horizons_test database the database tests use (only on the very first start)
      - ./docker/dev-initdb:/docker-entrypoint-initdb.d:ro

  mailpit:
    image: axllent/mailpit:v1.31
    ports:
      - "127.0.0.1:8025:8025"
      - "127.0.0.1:1025:1025"

volumes:
  dev-db:
```

Create `docker/dev-initdb/01-test-database.sql`:

```sql
CREATE DATABASE horizons_test OWNER horizons;
```

Create `.env.example`:

```bash
# Copy this to .env and fill it in. Locally, everything below works with docker-compose.dev.yml as it is, apart from
# AUTH_SECRET and the Google keys. On the server, docker-compose.yml builds DATABASE_URL itself from POSTGRES_PASSWORD,
# so there only POSTGRES_PASSWORD is needed from the database section.

# Database
DATABASE_URL=postgresql://horizons:horizons@localhost:5433/horizons
TEST_DATABASE_URL=postgresql://horizons:horizons@localhost:5433/horizons_test
POSTGRES_PASSWORD=

# Sign-in. AUTH_SECRET is any long random string, for example from: openssl rand -base64 33
AUTH_SECRET=
AUTH_URL=http://localhost:3000
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
ADMIN_EMAIL=koda@horizons.gg

# Cloudflare Turnstile. These are Cloudflare's test keys, which always pass. Use the real ones on the server.
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA

# Email. These point at Mailpit locally; on the server, use the relay's SMTP details.
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Horizons <quotes@dev.horizons.gg>"
QUOTE_NOTIFY_TO=koda@horizons.gg
QUOTE_REPLY_TO=info@dev.horizons.gg
```

Then create a local `.env` from it (never committed) with a random `AUTH_SECRET`, and start the services:

```bash
cp .env.example .env
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 33)|" .env
npm run services
```

- [ ] **Step 2: Write the schema and config**

Create `prisma.config.ts`:

```ts
// Prisma's settings. DATABASE_URL comes from .env locally and from docker-compose.yml on the server. It can be unset
// for prisma generate, which is how the Docker build generates the client without a database.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url: process.env.DATABASE_URL },
})
```

Create `prisma/schema.prisma`:

```prisma
// The quotes feature's tables. The enum values match server/quotes/labels.ts (a test checks that).

generator client {
  provider            = "prisma-client"
  output              = "../server/generated/prisma"
  // Extensionless imports inside the generated client, which Next's bundler and Vitest both resolve
  importFileExtension = ""
}

datasource db {
  provider = "postgresql"
}

enum QuoteStatus {
  NEW
  REPLIED
  WON
  LOST
}

enum ProjectType {
  NEW_SITE
  REDESIGN
  WEB_APP
  ONLINE_STORE
  OTHER
}

enum Budget {
  UNDER_2K
  FROM_2K_TO_5K
  FROM_5K_TO_10K
  OVER_10K
  NOT_SURE
}

enum Timeline {
  ASAP
  ONE_TO_THREE_MONTHS
  OVER_THREE_MONTHS
  FLEXIBLE
}

model Quote {
  id             String       @id @default(cuid())
  createdAt      DateTime     @default(now())
  name           String
  email          String
  company        String?
  website        String?
  projectType    ProjectType?
  budget         Budget?
  timeline       Timeline?
  message        String
  referenceSites String[]
  status         QuoteStatus  @default(NEW)
  archivedAt     DateTime?
  // When the email to Koda went
  notifiedAt     DateTime?
  // When the confirmation to the prospect went
  confirmedAt    DateTime?
  // HMAC of the sender's IP, for the rate limit; the IP itself is never stored
  ipHash         String
  notes          Note[]

  @@index([ipHash, createdAt])
  @@index([archivedAt, createdAt])
}

model Note {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  body      String
  quote     Quote    @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  quoteId   String

  @@index([quoteId])
}
```

- [ ] **Step 3: Create the first migration**

```bash
npx prisma migrate dev --name init
npx prisma generate
```

Expected: `prisma/migrations/<timestamp>_init/migration.sql` and `prisma/migrations/migration_lock.toml` are created, and the client is generated into `server/generated/prisma`. Open `migration.sql` and check it creates the four enums, both tables, the three indexes and the cascade foreign key.

- [ ] **Step 4: Write the failing tests**

Create `server/quotes/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { Budget, ProjectType, QuoteStatus, Timeline } from '../generated/prisma/enums'
import { BUDGETS, PROJECT_TYPES, STATUSES, TIMELINES } from './labels'

// The form and the database each list the choices; this keeps the two lists the same
describe('the choices match the database enums', () => {
    it.each([
        ['project types', PROJECT_TYPES, ProjectType],
        ['budgets', BUDGETS, Budget],
        ['timelines', TIMELINES, Timeline],
        ['statuses', STATUSES, QuoteStatus],
    ])('%s', (_, labels, enumObject) => {
        expect([...labels]).toEqual(Object.values(enumObject))
    })
})
```

Create `server/quotes/repo.test.ts`:

```ts
// Runs against a real Postgres: the horizons_test database from docker-compose.dev.yml, named by TEST_DATABASE_URL.
// Skipped when that isn't set, so npm test still works without Docker.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'
import type { Status } from './labels'
import { quoteRepo, type QuoteRepo } from './repo'
import type { QuoteInput } from './schema'

const url = process.env.TEST_DATABASE_URL

const input: QuoteInput = {
    name: 'Ann', email: 'ann@example.com', message: 'A new website please', company: null, website: null,
    projectType: 'WEB_APP', budget: null, timeline: null, referenceSites: ['https://one.example.com'],
}

describe.skipIf(!url)('quoteRepo', () => {
    let db: PrismaClient
    let repo: QuoteRepo

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
        repo = quoteRepo(db)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE "Quote", "Note" CASCADE')
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    // Inserts a quote with a chosen creation time, which create() doesn't allow
    const at = (iso: string, extra: { ipHash?: string, status?: Status, archivedAt?: Date } = {}) =>
        db.quote.create({ data: { ...input, ipHash: 'h1', createdAt: new Date(iso), ...extra } })

    it('creates a quote with the defaults', async () => {
        const { id } = await repo.create(input, 'h1')
        const quote = await repo.get(id)
        expect(quote).toMatchObject({ ...input, ipHash: 'h1', status: 'NEW', archivedAt: null, notifiedAt: null, confirmedAt: null, notes: [] })
    })

    it('counts recent quotes from one IP hash only, within the window', async () => {
        await at('2026-09-20T00:30:00Z')
        await at('2026-09-20T00:59:00Z')
        await at('2026-09-19T23:00:00Z')
        await at('2026-09-20T00:45:00Z', { ipHash: 'h2' })
        expect(await repo.countRecent('h1', new Date('2026-09-20T00:00:00Z'))).toBe(2)
    })

    it('lists the inbox newest first, keeping archived quotes to their own view', async () => {
        const older = await at('2026-09-20T00:00:00Z')
        const newer = await at('2026-09-20T01:00:00Z')
        const archived = await at('2026-09-20T02:00:00Z', { archivedAt: new Date() })
        expect((await repo.list({ archived: false })).map(q => q.id)).toEqual([newer.id, older.id])
        expect((await repo.list({ archived: true })).map(q => q.id)).toEqual([archived.id])
    })

    it('filters the inbox by status, and counts new quotes that are not archived', async () => {
        const won = await at('2026-09-20T00:00:00Z', { status: 'WON' })
        await at('2026-09-20T01:00:00Z')
        await at('2026-09-20T02:00:00Z', { archivedAt: new Date() })
        expect((await repo.list({ status: 'WON', archived: false })).map(q => q.id)).toEqual([won.id])
        expect(await repo.countNew()).toBe(1)
    })

    it('changes status, archives and unarchives', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.setStatus(id, 'REPLIED')
        await repo.setArchived(id, true, new Date('2026-09-20T03:00:00Z'))
        expect(await repo.get(id)).toMatchObject({ status: 'REPLIED', archivedAt: new Date('2026-09-20T03:00:00Z') })
        await repo.setArchived(id, false, new Date())
        expect((await repo.get(id))?.archivedAt).toBeNull()
    })

    it('keeps notes newest first, and deletes a note only from its own quote', async () => {
        const { id } = await repo.create(input, 'h1')
        const other = await repo.create(input, 'h1')
        await repo.addNote(id, 'first')
        await new Promise(resolve => setTimeout(resolve, 5))
        await repo.addNote(id, 'second')
        const notes = (await repo.get(id))!.notes
        expect(notes.map(note => note.body)).toEqual(['second', 'first'])

        await repo.removeNote(other.id, notes[0].id)
        expect((await repo.get(id))!.notes).toHaveLength(2)
        await repo.removeNote(id, notes[0].id)
        expect((await repo.get(id))!.notes.map(note => note.body)).toEqual(['first'])
    })

    it('deletes a quote along with its notes', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.addNote(id, 'a note')
        await repo.remove(id)
        expect(await repo.get(id)).toBeNull()
        expect(await db.note.count()).toBe(0)
    })

    it('records when each email went', async () => {
        const { id } = await repo.create(input, 'h1')
        await repo.markNotified(id, new Date('2026-09-20T00:00:01Z'))
        expect(await repo.get(id)).toMatchObject({ notifiedAt: new Date('2026-09-20T00:00:01Z'), confirmedAt: null })
        await repo.markConfirmed(id, new Date('2026-09-20T00:00:02Z'))
        expect((await repo.get(id))?.confirmedAt).toEqual(new Date('2026-09-20T00:00:02Z'))
    })
})
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `npx vitest run server/quotes/labels.test.ts server/quotes/repo.test.ts`
Expected: `labels.test.ts` PASSES already (the enums exist); `repo.test.ts` FAILS, cannot resolve `../db` and `./repo`.

- [ ] **Step 6: Write the database modules**

Create `server/db.ts`:

```ts
// The Prisma client. Created on first use rather than on import, so building the site (which imports this without a
// database) never tries to connect.

import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from './generated/prisma/client'

export function createDb(connectionString: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

// One client per process. In development Next reloads modules on every change, so the client lives on globalThis
// rather than opening a new connection pool each time.
const cache = globalThis as unknown as { horizonsDb?: PrismaClient }

export function getDb(): PrismaClient {
    if (!cache.horizonsDb) {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL is not set')
        cache.horizonsDb = createDb(url)
    }
    return cache.horizonsDb
}
```

Create `server/quotes/repo.ts`:

```ts
// Every query the quotes feature makes, in one place, taking the client as a parameter so the tests can point it at
// the test database

import 'server-only'

import type { PrismaClient } from '../generated/prisma/client'
import type { Status } from './labels'
import type { QuoteInput } from './schema'

export type InboxFilter = { status?: Status, archived: boolean }

const inboxColumns = {
    id: true, createdAt: true, name: true, company: true, projectType: true, budget: true, status: true,
    notifiedAt: true, confirmedAt: true,
} as const

export function quoteRepo(db: PrismaClient) {
    return {
        create: (input: QuoteInput, ipHash: string) =>
            db.quote.create({ data: { ...input, ipHash }, select: { id: true } }),

        countRecent: (ipHash: string, since: Date) =>
            db.quote.count({ where: { ipHash, createdAt: { gte: since } } }),

        list: (filter: InboxFilter) => db.quote.findMany({
            where: { archivedAt: filter.archived ? { not: null } : null, ...(filter.status && { status: filter.status }) },
            orderBy: { createdAt: 'desc' },
            select: inboxColumns,
        }),

        countNew: () => db.quote.count({ where: { status: 'NEW', archivedAt: null } }),

        get: (id: string) => db.quote.findUnique({ where: { id }, include: { notes: { orderBy: { createdAt: 'desc' } } } }),

        setStatus: async (id: string, status: Status) => {
            await db.quote.update({ where: { id }, data: { status } })
        },

        setArchived: async (id: string, archived: boolean, now: Date) => {
            await db.quote.update({ where: { id }, data: { archivedAt: archived ? now : null } })
        },

        remove: async (id: string) => {
            await db.quote.delete({ where: { id } })
        },

        addNote: async (quoteId: string, body: string) => {
            await db.note.create({ data: { quoteId, body } })
        },

        // Scoped to the quote, so a note can only be deleted from the page it is shown on
        removeNote: async (quoteId: string, noteId: string) => {
            await db.note.deleteMany({ where: { id: noteId, quoteId } })
        },

        markNotified: async (id: string, at: Date) => {
            await db.quote.update({ where: { id }, data: { notifiedAt: at } })
        },

        markConfirmed: async (id: string, at: Date) => {
            await db.quote.update({ where: { id }, data: { confirmedAt: at } })
        },
    }
}

export type QuoteRepo = ReturnType<typeof quoteRepo>
export type InboxRow = Awaited<ReturnType<QuoteRepo['list']>>[number]
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm test`
Expected: every test passes, including `repo.test.ts` (not skipped: check the output lists its 8 tests). Then `npx tsc --noEmit` and `npm run lint`: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore eslint.config.mjs .env.example docker-compose.dev.yml docker/dev-initdb prisma prisma.config.ts server/db.ts server/quotes/repo.ts server/quotes/repo.test.ts server/quotes/labels.test.ts
git commit -m "Store quotes in Postgres with Prisma

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The quote page

**Files:**
- Create: `server/quotes/wiring.ts`
- Create: `app/(quote)/quote/page.tsx`, `app/(quote)/quote/actions.ts`, `app/(quote)/quote/quoteForm.tsx`, `app/(quote)/quote/turnstile.tsx`
- Modify: `app/(landing)/page.tsx` (two links), `app/sitemap.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 6
- Produces: `wiring.ts`: `log(message: string, error?: unknown): void`; `submitDeps(): SubmitDeps`; `deliverById(id: string): Promise<DeliverResult>` (throws `EnvError` when mail settings are missing, or an `Error` when the quote doesn't exist). `actions.ts`: `submitQuoteAction(raw: unknown): Promise<SubmitResult>`

- [ ] **Step 1: Wire the pure modules to the real services**

Create `server/quotes/wiring.ts`:

```ts
// Connects the quotes feature's pure modules (submit.ts, deliver.ts) to the real database, relay, Turnstile and
// Next's after(). The only file that does, so everything else can be tested with stand-ins.

import 'server-only'

import { after } from 'next/server'

import { getDb } from '../db'
import { ipHashKey, mailConfig, turnstileSecret } from '../env'
import { createMailer } from '../mailer'
import { hashIp } from '../ratelimit'
import { verifyTurnstile } from '../turnstile'
import { deliverQuoteEmails, type DeliverResult } from './deliver'
import { quoteRepo } from './repo'
import type { SubmitDeps } from './submit'

export function log(message: string, error?: unknown) {
    console.error(`[quotes] ${message}`, error ?? '')
}

export async function deliverById(id: string): Promise<DeliverResult> {
    const repo = quoteRepo(getDb())
    const quote = await repo.get(id)
    if (!quote) throw new Error(`Quote ${id} does not exist`)
    // Read here rather than at startup, so a missing relay setting only stops email
    const mail = mailConfig()
    return deliverQuoteEmails(quote, {
        send: createMailer(mail),
        markNotified: repo.markNotified,
        markConfirmed: repo.markConfirmed,
        now: () => new Date(),
        log,
        mail,
    })
}

export function submitDeps(): SubmitDeps {
    const repo = quoteRepo(getDb())
    return {
        verifyTurnstile: (token, ip) => verifyTurnstile(token, ip, turnstileSecret()),
        hashIp: ip => hashIp(ip, ipHashKey()),
        countRecent: repo.countRecent,
        save: repo.create,
        afterResponse: task => after(task),
        deliver: async id => {
            await deliverById(id)
        },
        now: () => new Date(),
        log,
    }
}
```

- [ ] **Step 2: Write the server action**

Create `app/(quote)/quote/actions.ts`:

```ts
'use server'

import { headers } from 'next/headers'

import { clientIp } from '@/server/ratelimit'
import { submitQuote, type SubmitResult } from '@/server/quotes/submit'
import { submitDeps } from '@/server/quotes/wiring'

export async function submitQuoteAction(raw: unknown): Promise<SubmitResult> {
    return submitQuote(raw, clientIp(await headers()), submitDeps())
}
```

- [ ] **Step 3: Write the Turnstile widget**

Create `app/(quote)/quote/turnstile.tsx`:

```tsx
'use client'

// Cloudflare's Turnstile check, rendered explicitly so it can be reset after each attempt (a token is only good once)

import Script from 'next/script'
import { useCallback, useEffect, useRef } from 'react'

type TurnstileOptions = {
    sitekey: string
    theme: 'dark'
    callback(token: string): void
    'expired-callback'(): void
    'error-callback'(): void
}

declare global {
    interface Window {
        turnstile?: {
            render(element: HTMLElement, options: TurnstileOptions): string
            reset(widgetId: string): void
            remove(widgetId: string): void
        }
    }
}

export default function Turnstile({ siteKey, onToken, resetCount }: { siteKey: string, onToken(token: string | null): void, resetCount: number }) {
    const box = useRef<HTMLDivElement>(null)
    const widget = useRef<string | null>(null)
    const handler = useRef(onToken)
    useEffect(() => { handler.current = onToken })

    const render = useCallback(() => {
        if (!window.turnstile || !box.current || widget.current) return
        widget.current = window.turnstile.render(box.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: token => handler.current(token),
            'expired-callback': () => handler.current(null),
            'error-callback': () => handler.current(null),
        })
    }, [siteKey])

    // The script may already be loaded (after navigating away and back), in which case its onLoad won't fire again
    useEffect(() => {
        render()
        return () => {
            if (widget.current) window.turnstile?.remove(widget.current)
            widget.current = null
        }
    }, [render])

    useEffect(() => {
        if (resetCount && widget.current) window.turnstile?.reset(widget.current)
    }, [resetCount])

    return (
        <>
            <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onLoad={render} />
            <div ref={box} className="min-h-[65px]" />
        </>
    )
}
```

- [ ] **Step 4: Write the form**

Create `app/(quote)/quote/quoteForm.tsx`:

```tsx
'use client'

// The quote form: checks itself as it's sent for instant feedback, then the server checks again (see
// server/quotes/submit.ts). On success it's replaced by a thank-you in place.

import { useState } from 'react'
import { Add, Close } from '@mui/icons-material'

import { BUDGETS, BUDGET_LABELS, PROJECT_TYPES, PROJECT_TYPE_LABELS, TIMELINES, TIMELINE_LABELS } from '@/server/quotes/labels'
import { MAX_REFERENCE_SITES, firstErrors, quoteSchema, type FieldErrors, type QuoteField } from '@/server/quotes/schema'
import { submitQuoteAction } from './actions'
import Turnstile from './turnstile'

type TextField = Exclude<QuoteField, 'referenceSites'>
type Values = Record<TextField, string> & { referenceSites: string[] }

const EMPTY: Values = {
    name: '', email: '', company: '', website: '', projectType: '', budget: '', timeline: '', message: '', referenceSites: [''],
}

const FAILURES = {
    turnstile: "The spam check didn't go through. Please try again.",
    'rate-limited': "You've sent a few requests already. Please try again in an hour or so.",
    server: 'Something went wrong on my end. Please try again in a moment.',
    invalid: 'A few details need another look.',
}

const panel = 'rounded-3xl border border-[#8fd4f5]/10 bg-[#111a38]/55 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_60px_-30px_rgba(0,0,0,0.6)]'
const input = 'w-full rounded-2xl border border-[#8fd4f5]/15 bg-[#0b101f]/70 px-4 py-3 text-sm text-white placeholder:text-[#8fa3c7]/50 transition-colors focus:border-[#8fd4f5]/50 focus:outline-none'
const label = 'mb-2 block text-sm font-medium text-[#dbe6f7]'

function Field({ id, title, optional, error, children }: { id: string, title: string, optional?: boolean, error?: string, children: React.ReactNode }) {
    return (
        <div>
            <label htmlFor={id} className={label}>
                {title}
                {optional && <span className="ml-2 text-xs font-normal text-[#8fa3c7]">optional</span>}
            </label>
            {children}
            {error && <p id={`${id}-error`} className="mt-2 text-sm text-[#f19bb3]">{error}</p>}
        </div>
    )
}

export default function QuoteForm({ siteKey }: { siteKey: string }) {
    const [values, setValues] = useState<Values>(EMPTY)
    const [trap, setTrap] = useState('')
    const [errors, setErrors] = useState<FieldErrors>({})
    const [failure, setFailure] = useState<string | null>(null)
    const [token, setToken] = useState<string | null>(null)
    const [resetCount, setResetCount] = useState(0)
    const [sending, setSending] = useState(false)
    const [sent, setSent] = useState(false)

    const set = (field: TextField) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
        setValues(current => ({ ...current, [field]: event.target.value }))

    const setSite = (index: number, site: string) =>
        setValues(current => ({ ...current, referenceSites: current.referenceSites.map((s, i) => (i === index ? site : s)) }))

    const describedBy = (field: QuoteField) => (errors[field] ? `${field}-error` : undefined)

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault()
        setFailure(null)
        const checked = quoteSchema.safeParse(values)
        if (!checked.success) {
            setErrors(firstErrors(checked.error))
            return
        }
        setErrors({})
        if (!token) {
            setFailure('Please wait a moment for the spam check to finish.')
            return
        }

        setSending(true)
        try {
            const result = await submitQuoteAction({ ...values, turnstileToken: token, fax: trap })
            if (result.ok) {
                setSent(true)
                return
            }
            if (result.reason === 'invalid') setErrors(result.fieldErrors)
            setFailure(FAILURES[result.reason])
        } catch {
            setFailure(FAILURES.server)
        } finally {
            setSending(false)
            // Each token is good for one check, so the next attempt needs a fresh one
            setToken(null)
            setResetCount(count => count + 1)
        }
    }

    if (sent) {
        return (
            <div className={`${panel} p-8 text-center`} role="status">
                <h2 className="mb-3 text-2xl font-bold text-white">Thanks, it&apos;s on its way</h2>
                <p className="text-[#b4c3dc]/80">
                    I&apos;ve got your request, and a confirmation is heading to your inbox. I&apos;ll be in touch soon.
                </p>
            </div>
        )
    }

    return (
        <form onSubmit={onSubmit} noValidate className={`${panel} space-y-6 p-6 sm:p-8`}>
            <div className="grid gap-6 sm:grid-cols-2">
                <Field id="name" title="Name" error={errors.name}>
                    <input id="name" className={input} value={values.name} onChange={set('name')} autoComplete="name" aria-invalid={!!errors.name} aria-describedby={describedBy('name')} />
                </Field>
                <Field id="email" title="Email" error={errors.email}>
                    <input id="email" type="email" className={input} value={values.email} onChange={set('email')} autoComplete="email" aria-invalid={!!errors.email} aria-describedby={describedBy('email')} />
                </Field>
                <Field id="company" title="Company" optional error={errors.company}>
                    <input id="company" className={input} value={values.company} onChange={set('company')} autoComplete="organization" aria-invalid={!!errors.company} aria-describedby={describedBy('company')} />
                </Field>
                <Field id="website" title="Current website" optional error={errors.website}>
                    <input id="website" type="url" className={input} value={values.website} onChange={set('website')} placeholder="https://" aria-invalid={!!errors.website} aria-describedby={describedBy('website')} />
                </Field>
            </div>

            <div className="grid gap-6 sm:grid-cols-3">
                <Field id="projectType" title="Project type" optional error={errors.projectType}>
                    <select id="projectType" className={input} value={values.projectType} onChange={set('projectType')}>
                        <option value="">Choose one</option>
                        {PROJECT_TYPES.map(value => <option key={value} value={value}>{PROJECT_TYPE_LABELS[value]}</option>)}
                    </select>
                </Field>
                <Field id="budget" title="Budget (AUD)" optional error={errors.budget}>
                    <select id="budget" className={input} value={values.budget} onChange={set('budget')}>
                        <option value="">Choose one</option>
                        {BUDGETS.map(value => <option key={value} value={value}>{BUDGET_LABELS[value]}</option>)}
                    </select>
                </Field>
                <Field id="timeline" title="Timeline" optional error={errors.timeline}>
                    <select id="timeline" className={input} value={values.timeline} onChange={set('timeline')}>
                        <option value="">Choose one</option>
                        {TIMELINES.map(value => <option key={value} value={value}>{TIMELINE_LABELS[value]}</option>)}
                    </select>
                </Field>
            </div>

            <Field id="message" title="Tell me about your project" error={errors.message}>
                <textarea id="message" rows={6} className={input} value={values.message} onChange={set('message')} aria-invalid={!!errors.message} aria-describedby={describedBy('message')} />
            </Field>

            <div>
                <p className={label}>
                    Sites you like the look of
                    <span className="ml-2 text-xs font-normal text-[#8fa3c7]">optional, up to {MAX_REFERENCE_SITES}</span>
                </p>
                <div className="space-y-3">
                    {values.referenceSites.map((site, index) => (
                        <div key={index} className="flex gap-2">
                            <input type="url" aria-label={`Example site ${index + 1}`} className={input} value={site} placeholder="https://" onChange={event => setSite(index, event.target.value)} />
                            {values.referenceSites.length > 1 && (
                                <button type="button" aria-label={`Remove example site ${index + 1}`} onClick={() => setValues(current => ({ ...current, referenceSites: current.referenceSites.filter((_, i) => i !== index) }))}
                                    className="shrink-0 rounded-2xl border border-[#8fd4f5]/15 px-3 text-[#8fa3c7] transition-colors hover:text-white">
                                    <Close sx={{ fontSize: 18 }} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                {values.referenceSites.length < MAX_REFERENCE_SITES && (
                    <button type="button" onClick={() => setValues(current => ({ ...current, referenceSites: [...current.referenceSites, ''] }))}
                        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#8fd4f5] transition-colors hover:text-white">
                        <Add sx={{ fontSize: 18 }} /> Add another
                    </button>
                )}
                {errors.referenceSites && <p className="mt-2 text-sm text-[#f19bb3]">{errors.referenceSites}</p>}
            </div>

            {/* The honeypot: hidden from people and screen readers, so only bots fill it in */}
            <div aria-hidden="true" className="absolute left-[-10000px] top-auto h-px w-px overflow-hidden">
                <label htmlFor="fax">Fax</label>
                <input id="fax" name="fax" tabIndex={-1} autoComplete="off" value={trap} onChange={event => setTrap(event.target.value)} />
            </div>

            <Turnstile siteKey={siteKey} onToken={setToken} resetCount={resetCount} />

            {failure && <p className="text-sm text-[#f19bb3]" role="alert">{failure}</p>}

            <div className="flex flex-wrap items-center gap-4">
                <button type="submit" disabled={sending}
                    className="rounded-full border border-[#f19bb3]/40 bg-[#f19bb3]/[0.12] px-6 py-3 text-sm font-semibold text-[#f7c5d3] transition-colors hover:border-[#f19bb3]/70 hover:text-white disabled:opacity-50">
                    {sending ? 'Sending...' : 'Send request'}
                </button>
                <p className="text-xs text-[#8fa3c7]">I&apos;ll only use these details to reply to your enquiry.</p>
            </div>
        </form>
    )
}
```

- [ ] **Step 5: Write the page**

Create `app/(quote)/quote/page.tsx`:

```tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowBack } from '@mui/icons-material'

import QuoteForm from './quoteForm'

// Rendered per request, so the Turnstile key below is read when the page is served. A NEXT_PUBLIC_ variable would be
// baked in at build time instead, and .env is deliberately left out of the Docker build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
    title: 'Get a quote',
    description: "Tell me about the website or web app you have in mind, and I'll get back to you with a quote.",
    alternates: { canonical: '/quote' },
}

export default function QuotePage() {
    const siteKey = process.env.TURNSTILE_SITE_KEY
    const fallback = process.env.QUOTE_REPLY_TO

    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-16 text-[#dbe6f7] sm:py-24">
            <div className="mx-auto max-w-2xl">
                <Link href="/" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack sx={{ fontSize: 16 }} /> Horizons
                </Link>
                <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Get a quote</h1>
                <p className="mb-10 max-w-xl text-base leading-relaxed text-[#b4c3dc]/80">
                    Tell me about the website or web app you have in mind. The more I know, the better the quote, but only
                    your name, email and a few words about the project are needed.
                </p>
                {siteKey
                    ? <QuoteForm siteKey={siteKey} />
                    : <p className="text-[#b4c3dc]/80">The form isn&apos;t available right now.{fallback && <> You can email <a className="text-[#8fd4f5] underline" href={`mailto:${fallback}`}>{fallback}</a> instead.</>}</p>}
            </div>
        </main>
    )
}
```

- [ ] **Step 6: Link to it from the landing page, and list it in the sitemap**

In `app/(landing)/page.tsx`:

1. Add `ArrowForward` to the `@mui/icons-material` import.
2. Below the `clients` array definition, add:

```tsx
// The way into the quote form, shown in the introduction and again at the end of the page
function QuoteLink({ className = '' }: { className?: string }) {
    return (
        <Link href="/quote"
            className={`group inline-flex items-center gap-2 rounded-full border border-[#f19bb3]/35 bg-[#f19bb3]/[0.08] px-5 py-2.5 text-sm font-semibold text-[#f7c5d3] transition-colors hover:border-[#f19bb3]/60 hover:text-white ${className}`}>
            Get a quote
            <ArrowForward sx={{ fontSize: 16 }} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
    )
}
```

3. In the About section, directly after the `<p className="max-w-xl ...">` introduction paragraph, add `<QuoteLink className="mt-8" />`.
4. In the Contact section, directly after the "Have a project in mind" paragraph and before the socials `<div>`, add `<div className="mb-8"><QuoteLink /></div>`.

Change nothing else in the file.

In `app/sitemap.ts`, change the comment and add the quote page:

```ts
// The home page and the quote form: the wallpaper page is kept out of search results (see app/wallpaper/layout.tsx),
// and the admin area is disallowed in robots.ts
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: SITE.url, lastModified: new Date(), changeFrequency: 'monthly', priority: 1 },
        { url: `${SITE.url}/quote`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.8 },
    ]
}
```

- [ ] **Step 7: Check it builds**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. `npm run build` lists `/quote` as dynamic (ƒ).

- [ ] **Step 8: Check it in the browser**

With `npm run services` running, start the dev server with the `preview_start` tool (`name: "dev"`), then:

1. Open `/` and confirm the two "Get a quote" links appear (About section and the closing section) and the scene looks as before. Take a screenshot.
2. Open `/quote`. Click "Send request" with the form empty: name, email and message errors appear, nothing is sent.
3. Fill in name, email, a message, a project type, a budget and two example sites, wait for the Turnstile widget to show success (the test key passes automatically), and send. The thank-you replaces the form.
4. Check Mailpit: `curl -s http://localhost:8025/api/v1/messages` lists two messages: one to `koda@horizons.gg` with Reply-To the address you entered, one to that address whose body does not contain the message you typed.
5. Check the row: `docker compose -f docker-compose.dev.yml exec db psql -U horizons -c 'select name, status, "notifiedAt" is not null as notified, "confirmedAt" is not null as confirmed from "Quote"'` shows the quote as NEW, notified and confirmed.
6. Check the browser console has no errors (`read_console_messages`).

- [ ] **Step 9: Commit**

```bash
git add server/quotes/wiring.ts "app/(quote)" "app/(landing)/page.tsx" app/sitemap.ts
git commit -m "Add the Get a quote page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Keep the wallpaper build static

**Files:**
- Modify: `scripts/wallpaper.mjs`

**Interfaces:**
- Consumes: the route groups from Task 7 (and Tasks 9 and 10 later)
- Produces: nothing new

- [ ] **Step 1: See it fail**

Run: `npm run wallpaper`
Expected: FAIL. The static export can't build `app/(quote)/quote` (a dynamic page with a server action). Note the error.

- [ ] **Step 2: Skip the server-side route groups when copying**

In `scripts/wallpaper.mjs`, change the `node:path` import to `import { join, normalize, sep } from 'node:path'`, add below `SOURCES`:

```js
// The quote form, the admin area and the API are server-side (server actions, route handlers, sign-in), which a
// static export can't contain, and the wallpaper uses none of them. (middleware.ts and server/ aren't in SOURCES.)
const SERVER_SIDE = [join('app', '(quote)'), join('app', '(admin)'), join('app', 'api')]
const isServerSide = path => SERVER_SIDE.some(dir => normalize(path) === dir || normalize(path).startsWith(dir + sep))
```

and change the copy line to:

```js
    for (const source of SOURCES) cpSync(source, join(work, source), { recursive: true, filter: path => !isServerSide(path) })
```

- [ ] **Step 3: See it pass**

Run: `npm run wallpaper`
Expected: "Wallpaper built into dist/wallpaper-engine", and `dist/wallpaper-engine/index.html` exists.

- [ ] **Step 4: Commit**

```bash
git add scripts/wallpaper.mjs
git commit -m "Leave the server-side pages out of the wallpaper build

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Admin sign-in

**Files:**
- Modify: `package.json` (next-auth, MUI Next.js helpers), `app/robots.ts`
- Create: `server/auth/allow.ts`, `server/auth/config.ts`, `server/auth/index.ts`, `middleware.ts`, `app/api/auth/[...nextauth]/route.ts`
- Create: `app/(admin)/admin/layout.tsx`, `app/(admin)/admin/theme.tsx`, `app/(admin)/admin/sign-in/page.tsx`
- Test: `server/auth/allow.test.ts`

The spec lists `server/auth.ts`; it's a folder here because the middleware needs a part of it that must not import `server-only` or anything Node-specific.

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `allow.ts`: `isAllowedAdmin(profile: { email?: string | null, email_verified?: unknown } | null | undefined, adminEmail: string | undefined): boolean`; `isAdminSession(session: { user?: { email?: string | null } | null } | null | undefined, adminEmail: string | undefined): boolean`. `config.ts`: `SIGN_IN_PATH = '/admin/sign-in'`, `authConfig`. `index.ts`: `handlers`, `auth`, `signIn`, `signOut`, `requireAdmin(): Promise<Session>`

- [ ] **Step 1: Install**

```bash
npm install --save-exact next-auth@5.0.0-beta.32 @mui/material-nextjs@6.5.0 @emotion/cache@11.14.0
```

- [ ] **Step 2: Write the failing tests**

Create `server/auth/allow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isAdminSession, isAllowedAdmin } from './allow'

const ADMIN = 'koda@horizons.gg'

describe('isAllowedAdmin', () => {
    it('allows the admin account once Google has verified it, ignoring case and spaces', () => {
        expect(isAllowedAdmin({ email: 'koda@horizons.gg', email_verified: true }, ADMIN)).toBe(true)
        expect(isAllowedAdmin({ email: ' Koda@Horizons.gg ', email_verified: true }, ' KODA@horizons.gg')).toBe(true)
    })

    it('refuses any other account', () => {
        expect(isAllowedAdmin({ email: 'someone@gmail.com', email_verified: true }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: 'koda@horizons.gg.evil.com', email_verified: true }, ADMIN)).toBe(false)
    })

    it('refuses the right address when Google has not verified it', () => {
        expect(isAllowedAdmin({ email: ADMIN, email_verified: false }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: ADMIN }, ADMIN)).toBe(false)
        expect(isAllowedAdmin({ email: ADMIN, email_verified: 'true' }, ADMIN)).toBe(false)
    })

    it('refuses everyone when ADMIN_EMAIL is not set', () => {
        expect(isAllowedAdmin({ email: ADMIN, email_verified: true }, undefined)).toBe(false)
        expect(isAllowedAdmin({ email: '', email_verified: true }, '')).toBe(false)
    })

    it('refuses a missing profile', () => {
        expect(isAllowedAdmin(undefined, ADMIN)).toBe(false)
    })
})

describe('isAdminSession', () => {
    it('accepts a session for the admin address only', () => {
        expect(isAdminSession({ user: { email: 'KODA@horizons.gg' } }, ADMIN)).toBe(true)
        expect(isAdminSession({ user: { email: 'someone@gmail.com' } }, ADMIN)).toBe(false)
    })

    it('refuses no session, a session without an email, and an unset ADMIN_EMAIL', () => {
        expect(isAdminSession(null, ADMIN)).toBe(false)
        expect(isAdminSession({ user: {} }, ADMIN)).toBe(false)
        expect(isAdminSession({ user: { email: ADMIN } }, undefined)).toBe(false)
    })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run server/auth/allow.test.ts`
Expected: FAIL, cannot resolve `./allow`.

- [ ] **Step 4: Write the auth modules**

Create `server/auth/allow.ts`:

```ts
// Who may use the admin area: one Google account, named by ADMIN_EMAIL. Plain functions with no server-only import,
// because the middleware uses them too.

const normalise = (email: string) => email.trim().toLowerCase()

export function isAllowedAdmin(profile: { email?: string | null, email_verified?: unknown } | null | undefined, adminEmail: string | undefined): boolean {
    if (!adminEmail?.trim() || !profile?.email || profile.email_verified !== true) return false
    return normalise(profile.email) === normalise(adminEmail)
}

export function isAdminSession(session: { user?: { email?: string | null } | null } | null | undefined, adminEmail: string | undefined): boolean {
    const email = session?.user?.email
    if (!adminEmail?.trim() || !email) return false
    return normalise(email) === normalise(adminEmail)
}
```

Create `server/auth/config.ts`:

```ts
// Auth.js settings shared by the middleware and the server. Kept free of server-only and Node-specific imports because
// the middleware runs in Next's edge runtime.

import type { NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'

import { isAllowedAdmin } from './allow'

export const SIGN_IN_PATH = '/admin/sign-in'

export const authConfig = {
    // Reads AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET
    providers: [Google],
    // A refused sign-in comes back to the sign-in page with ?error=AccessDenied
    pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
    // Signed cookies rather than database sessions, so checking one never touches Postgres
    session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
    // The site sits behind Cloudflare, and AUTH_URL pins the public address
    trustHost: true,
    callbacks: {
        signIn: ({ account, profile }) => account?.provider === 'google' && isAllowedAdmin(profile, process.env.ADMIN_EMAIL),
        // Used by the middleware: the sign-in page is open, everything else under /admin needs a session. Pages and
        // actions check the email again themselves with requireAdmin().
        authorized: ({ auth, request }) => request.nextUrl.pathname === SIGN_IN_PATH || !!auth?.user,
    },
} satisfies NextAuthConfig
```

Create `server/auth/index.ts`:

```ts
import 'server-only'

import NextAuth, { type Session } from 'next-auth'
import { redirect } from 'next/navigation'

import { isAdminSession } from './allow'
import { SIGN_IN_PATH, authConfig } from './config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

// Every admin page and server action calls this first. The middleware already turns away requests without a session,
// but this doesn't rely on it: middleware has been bypassed before (CVE-2025-29927), so one bug mustn't expose the
// inbox.
export async function requireAdmin(): Promise<Session> {
    const session = await auth()
    if (!session || !isAdminSession(session, process.env.ADMIN_EMAIL)) redirect(SIGN_IN_PATH)
    return session
}
```

Create `middleware.ts` (repo root):

```ts
// Sends anyone without a session from /admin to the sign-in page (see server/auth/config.ts)

import NextAuth from 'next-auth'

import { authConfig } from './server/auth/config'

export const { auth: middleware } = NextAuth(authConfig)

export const config = { matcher: ['/admin/:path*'] }
```

Create `app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from '@/server/auth'

export const { GET, POST } = handlers
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run server/auth/allow.test.ts`
Expected: PASS

- [ ] **Step 6: Write the admin layout and sign-in page**

Create `app/(admin)/admin/theme.tsx`:

```tsx
'use client'

// A plain dark MUI theme in the site's navy, for the admin area only

import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'

const theme = createTheme({
    palette: {
        mode: 'dark',
        background: { default: '#0b101f', paper: '#111a38' },
        primary: { main: '#8fd4f5' },
        secondary: { main: '#f19bb3' },
    },
    typography: { fontFamily: 'inherit' },
    shape: { borderRadius: 12 },
})

export default function AdminTheme({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {children}
        </ThemeProvider>
    )
}
```

Create `app/(admin)/admin/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'

import AdminTheme from './theme'

// MUI's providers live here rather than in the root layout, so the landing page and the wallpaper build don't get them
export const metadata: Metadata = {
    title: { default: 'Admin', template: '%s · Admin' },
    robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <AppRouterCacheProvider>
            <AdminTheme>{children}</AdminTheme>
        </AppRouterCacheProvider>
    )
}
```

Create `app/(admin)/admin/sign-in/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Alert, Box, Button, Paper, Typography } from '@mui/material'

import { auth, signIn } from '@/server/auth'
import { isAdminSession } from '@/server/auth/allow'

export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
    if (isAdminSession(await auth(), process.env.ADMIN_EMAIL)) redirect('/admin')
    const { error } = await searchParams

    async function signInWithGoogle() {
        'use server'
        await signIn('google', { redirectTo: '/admin' })
    }

    return (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
            <Paper sx={{ p: 4, width: '100%', maxWidth: 380 }}>
                <Typography variant="h5" component="h1" sx={{ mb: 3, fontWeight: 700 }}>Horizons admin</Typography>
                {error && (
                    <Alert severity="error" sx={{ mb: 3 }}>
                        {error === 'AccessDenied' ? 'That Google account is not authorised.' : 'Sign-in failed. Please try again.'}
                    </Alert>
                )}
                <form action={signInWithGoogle}>
                    <Button type="submit" variant="contained" fullWidth size="large">Sign in with Google</Button>
                </form>
            </Paper>
        </Box>
    )
}
```

In `app/robots.ts`, change the rules line to:

```ts
        rules: { userAgent: '*', allow: '/', disallow: '/admin' },
```

- [ ] **Step 7: Check it builds and redirects**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. If `next-auth`'s types for the `signIn` or `authorized` callback parameters differ from the code above, adjust the code to the installed types without changing its behaviour.

Then with the dev server running (`preview_start` `name: "dev"`):

1. `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:3000/admin` prints a 307 redirect to `/admin/sign-in?callbackUrl=...`.
2. The same for `/admin/quotes/anything`.
3. Open `/admin/sign-in` in the browser pane: the card with "Sign in with Google" renders on the navy background, with no console errors.
4. Open `/admin/sign-in?error=AccessDenied`: the "not authorised" alert shows.
5. `curl -s http://localhost:3000/robots.txt` includes `Disallow: /admin`.

Do not click "Sign in with Google": that needs Koda's Google client and account.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/auth middleware.ts app/api "app/(admin)" app/robots.ts
git commit -m "Let only Koda's Google account into the admin area

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The admin inbox and quote page

**Files:**
- Create: `app/(admin)/admin/actions.ts`, `app/(admin)/admin/header.tsx`, `app/(admin)/admin/format.ts`, `app/(admin)/admin/page.tsx`
- Create: `app/(admin)/admin/quotes/[id]/page.tsx`, `app/(admin)/admin/quotes/[id]/controls.tsx`

**Interfaces:**
- Consumes: `requireAdmin`, `signOut` (Task 9); `getDb` (Task 6); `quoteRepo`, `InboxRow` (Task 6); `deliverById`, `log` (Task 7); `EnvError` (Task 2); `emailsMissing` (Task 3); labels (Task 1)
- Produces: `actions.ts`: `type ActionResult = { ok: true } | { ok: false, error: string }`; `setStatusAction(quoteId: string, status: string)`, `setArchivedAction(quoteId: string, archived: boolean)`, `addNoteAction(quoteId: string, body: string)`, `deleteNoteAction(quoteId: string, noteId: string)`, `resendEmailsAction(quoteId: string)` all `Promise<ActionResult>`; `deleteQuoteAction(quoteId: string): Promise<ActionResult>` (redirects to `/admin` on success)

- [ ] **Step 1: Write the server actions**

Create `app/(admin)/admin/actions.ts`:

```ts
'use server'

// Everything the admin area changes. Each action checks the session itself first, validates what it was sent, and
// reports failure as a message rather than throwing, so the page can show it.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { EnvError } from '@/server/env'
import { STATUSES } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { deliverById, log } from '@/server/quotes/wiring'

export type ActionResult = { ok: true } | { ok: false, error: string }

const id = z.string().min(1).max(64)
const INVALID: ActionResult = { ok: false, error: 'That request was not valid.' }
const FAILED: ActionResult = { ok: false, error: 'That did not work. The quote may have been deleted, so try reloading.' }

function refresh(quoteId: string) {
    revalidatePath('/admin')
    revalidatePath(`/admin/quotes/${quoteId}`)
}

async function change(quoteId: string, work: () => Promise<void>): Promise<ActionResult> {
    try {
        await work()
    } catch (error) {
        log(`Admin change to quote ${quoteId} failed`, error)
        return FAILED
    }
    refresh(quoteId)
    return { ok: true }
}

export async function setStatusAction(quoteId: string, status: string): Promise<ActionResult> {
    await requireAdmin()
    const parsed = z.object({ quoteId: id, status: z.enum(STATUSES) }).safeParse({ quoteId, status })
    if (!parsed.success) return INVALID
    return change(quoteId, () => quoteRepo(getDb()).setStatus(parsed.data.quoteId, parsed.data.status))
}

export async function setArchivedAction(quoteId: string, archived: boolean): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success || typeof archived !== 'boolean') return INVALID
    return change(quoteId, () => quoteRepo(getDb()).setArchived(quoteId, archived, new Date()))
}

export async function addNoteAction(quoteId: string, body: string): Promise<ActionResult> {
    await requireAdmin()
    const parsed = z.object({
        quoteId: id,
        body: z.string().trim().min(1, 'Write something first').max(5000, 'Keep notes under 5,000 characters'),
    }).safeParse({ quoteId, body })
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    return change(quoteId, () => quoteRepo(getDb()).addNote(parsed.data.quoteId, parsed.data.body))
}

export async function deleteNoteAction(quoteId: string, noteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success || !id.safeParse(noteId).success) return INVALID
    return change(quoteId, () => quoteRepo(getDb()).removeNote(quoteId, noteId))
}

export async function deleteQuoteAction(quoteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success) return INVALID
    try {
        await quoteRepo(getDb()).remove(quoteId)
    } catch (error) {
        log(`Deleting quote ${quoteId} failed`, error)
        return FAILED
    }
    revalidatePath('/admin')
    // Outside the try: redirect() works by throwing
    redirect('/admin')
}

export async function resendEmailsAction(quoteId: string): Promise<ActionResult> {
    await requireAdmin()
    if (!id.safeParse(quoteId).success) return INVALID
    try {
        const result = await deliverById(quoteId)
        refresh(quoteId)
        if (result.notified && result.confirmed) return { ok: true }
        return { ok: false, error: 'An email still did not send. The server log has the reason.' }
    } catch (error) {
        // Names the missing settings, never their values
        if (error instanceof EnvError) return { ok: false, error: error.message }
        log(`Resending quote ${quoteId}'s emails failed`, error)
        return { ok: false, error: 'Sending failed. The server log has the reason.' }
    }
}
```

- [ ] **Step 2: Write the shared pieces**

Create `app/(admin)/admin/format.ts`:

```ts
import type { Status } from '@/server/quotes/labels'

// The server runs in UTC; Koda reads times in Queensland
const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })

export const formatWhen = (date: Date) => when.format(date)

export const STATUS_COLOURS: Record<Status, 'info' | 'default' | 'success' | 'error'> = {
    NEW: 'info',
    REPLIED: 'default',
    WON: 'success',
    LOST: 'error',
}
```

Create `app/(admin)/admin/header.tsx`:

```tsx
import Link from 'next/link'
import { Box, Button, Typography } from '@mui/material'

import { signOut } from '@/server/auth'

export default function AdminHeader() {
    async function signOutAction() {
        'use server'
        await signOut({ redirectTo: '/admin/sign-in' })
    }

    return (
        <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 2, mb: 3, borderBottom: 1, borderColor: 'divider' }}>
            <Link href="/admin" style={{ color: 'inherit', textDecoration: 'none' }}>
                <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>Horizons admin</Typography>
            </Link>
            <form action={signOutAction}>
                <Button type="submit" size="small" color="inherit">Sign out</Button>
            </form>
        </Box>
    )
}
```

- [ ] **Step 3: Write the inbox**

Create `app/(admin)/admin/page.tsx`:

```tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { Box, Chip, Container, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material'
import { WarningAmber } from '@mui/icons-material'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { STATUS_COLOURS, formatWhen } from './format'
import AdminHeader from './header'

export const metadata: Metadata = { title: 'Quotes' }

const isStatus = (value: string | undefined): value is Status => (STATUSES as readonly string[]).includes(value ?? '')

export default async function Inbox({ searchParams }: { searchParams: Promise<{ status?: string, archived?: string }> }) {
    await requireAdmin()
    const params = await searchParams
    const status = isStatus(params.status) ? params.status : undefined
    const archived = params.archived === '1'

    const repo = quoteRepo(getDb())
    const [quotes, newCount] = await Promise.all([repo.list({ status, archived }), repo.countNew()])
    const now = new Date()

    const filters: { label: string, href: string, active: boolean }[] = [
        { label: 'All', href: '/admin', active: !status && !archived },
        ...STATUSES.map(value => ({ label: STATUS_LABELS[value], href: `/admin?status=${value}`, active: status === value && !archived })),
        { label: 'Archived', href: '/admin?archived=1', active: archived },
    ]

    return (
        <Container maxWidth="lg" sx={{ pb: 6 }}>
            <AdminHeader />
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2 }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>Quotes</Typography>
                <Typography color="text.secondary">{newCount} new</Typography>
            </Box>

            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 3 }}>
                {filters.map(filter => (
                    <Link key={filter.label} href={filter.href}>
                        <Chip label={filter.label} clickable color={filter.active ? 'primary' : 'default'} variant={filter.active ? 'filled' : 'outlined'} />
                    </Link>
                ))}
            </Stack>

            {quotes.length === 0 ? (
                <Typography color="text.secondary">Nothing here.</Typography>
            ) : (
                <Paper>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>Received</TableCell>
                                <TableCell>Name</TableCell>
                                <TableCell>Company</TableCell>
                                <TableCell>Project</TableCell>
                                <TableCell>Budget</TableCell>
                                <TableCell>Status</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {quotes.map(quote => (
                                <TableRow key={quote.id} hover>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatWhen(quote.createdAt)}</TableCell>
                                    <TableCell>
                                        <Link href={`/admin/quotes/${quote.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{quote.name}</Link>
                                        {emailsMissing(quote, now) && (
                                            <Tooltip title="An email for this quote was not sent">
                                                <WarningAmber color="warning" sx={{ fontSize: 18, ml: 1, verticalAlign: 'middle' }} />
                                            </Tooltip>
                                        )}
                                    </TableCell>
                                    <TableCell>{quote.company}</TableCell>
                                    <TableCell>{quote.projectType && PROJECT_TYPE_LABELS[quote.projectType]}</TableCell>
                                    <TableCell>{quote.budget && BUDGET_LABELS[quote.budget]}</TableCell>
                                    <TableCell><Chip size="small" label={STATUS_LABELS[quote.status]} color={STATUS_COLOURS[quote.status]} /></TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
                </Paper>
            )}
        </Container>
    )
}
```

- [ ] **Step 4: Write the quote page controls**

Create `app/(admin)/admin/quotes/[id]/controls.tsx`:

```tsx
'use client'

// The parts of the quote page that change things. Each calls a server action and shows its error, if any; a
// successful action refreshes the page itself (the actions revalidate it).

import { useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, MenuItem, Stack, TextField } from '@mui/material'
import { DeleteOutline } from '@mui/icons-material'

import { STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { addNoteAction, deleteNoteAction, deleteQuoteAction, resendEmailsAction, setArchivedAction, setStatusAction, type ActionResult } from '../../actions'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function run(action: () => Promise<ActionResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, run }
}

const Problem = ({ error }: { error: string | null }) => (error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null)

export function StatusPicker({ quoteId, status }: { quoteId: string, status: Status }) {
    const { pending, error, run } = useAction()
    return (
        <div>
            <TextField select size="small" label="Status" value={status} disabled={pending} sx={{ minWidth: 160 }}
                onChange={event => run(() => setStatusAction(quoteId, event.target.value))}>
                {STATUSES.map(value => <MenuItem key={value} value={value}>{STATUS_LABELS[value]}</MenuItem>)}
            </TextField>
            <Problem error={error} />
        </div>
    )
}

export function QuoteActions({ quoteId, archived, emailsMissing }: { quoteId: string, archived: boolean, emailsMissing: boolean }) {
    const { pending, error, run } = useAction()
    const [confirming, setConfirming] = useState(false)
    return (
        <div>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                <Button variant="outlined" disabled={pending} onClick={() => run(() => setArchivedAction(quoteId, !archived))}>
                    {archived ? 'Unarchive' : 'Archive'}
                </Button>
                {emailsMissing && (
                    <Button variant="outlined" color="warning" disabled={pending} onClick={() => run(() => resendEmailsAction(quoteId))}>
                        Resend emails
                    </Button>
                )}
                <Button variant="outlined" color="error" disabled={pending} onClick={() => setConfirming(true)}>Delete</Button>
            </Stack>
            <Problem error={error} />
            <Dialog open={confirming} onClose={() => setConfirming(false)}>
                <DialogTitle>Delete this quote?</DialogTitle>
                <DialogContent>
                    <DialogContentText>This removes the quote and its notes. It can&apos;t be undone from here.</DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirming(false)}>Cancel</Button>
                    <Button color="error" disabled={pending} onClick={() => run(() => deleteQuoteAction(quoteId), () => setConfirming(false))}>Delete</Button>
                </DialogActions>
            </Dialog>
        </div>
    )
}

export function NoteForm({ quoteId }: { quoteId: string }) {
    const { pending, error, run } = useAction()
    const [body, setBody] = useState('')
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => addNoteAction(quoteId, body), () => setBody('')) }}>
            <TextField label="Add a note" multiline minRows={2} fullWidth value={body} onChange={event => setBody(event.target.value)} />
            <Button type="submit" variant="contained" disabled={pending || !body.trim()} sx={{ mt: 1 }}>Save note</Button>
            <Problem error={error} />
        </form>
    )
}

export function DeleteNoteButton({ quoteId, noteId }: { quoteId: string, noteId: string }) {
    const { pending, error, run } = useAction()
    return (
        <>
            <IconButton size="small" aria-label="Delete note" disabled={pending} onClick={() => run(() => deleteNoteAction(quoteId, noteId))}>
                <DeleteOutline fontSize="small" />
            </IconButton>
            <Problem error={error} />
        </>
    )
}
```

- [ ] **Step 5: Write the quote page**

Create `app/(admin)/admin/quotes/[id]/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Alert, Box, Button, Chip, Container, Divider, Paper, Stack, Typography } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUS_LABELS, TIMELINE_LABELS } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { STATUS_COLOURS, formatWhen } from '../../format'
import AdminHeader from '../../header'
import { DeleteNoteButton, NoteForm, QuoteActions, StatusPicker } from './controls'

export const metadata: Metadata = { title: 'Quote' }

// Links the prospect typed in: only ever http or https (the schema refuses anything else), opened without telling the
// other site where the click came from
function External({ href }: { href: string }) {
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'inherit', wordBreak: 'break-all' }}>{href}</a>
}

function Detail({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <Box>
            <Typography variant="caption" color="text.secondary" component="p">{label}</Typography>
            <Typography component="div">{children}</Typography>
        </Box>
    )
}

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const quote = await quoteRepo(getDb()).get(id)
    if (!quote) notFound()
    const missing = emailsMissing(quote, new Date())

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <AdminHeader />
            <Stack direction="row" sx={{ alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>{quote.name}</Typography>
                <Chip label={STATUS_LABELS[quote.status]} color={STATUS_COLOURS[quote.status]} />
                {quote.archivedAt && <Chip label="Archived" variant="outlined" />}
            </Stack>
            <Typography color="text.secondary" sx={{ mb: 3 }}>Received {formatWhen(quote.createdAt)}</Typography>

            {missing && (
                <Alert severity="warning" sx={{ mb: 3 }}>
                    {!quote.notifiedAt && 'The email to you was not sent. '}
                    {!quote.confirmedAt && 'The confirmation to them was not sent.'}
                </Alert>
            )}

            <Paper sx={{ p: 3, mb: 3 }}>
                <Stack sx={{ gap: 2 }}>
                    <Detail label="Email"><a href={`mailto:${quote.email}`} style={{ color: 'inherit' }}>{quote.email}</a></Detail>
                    {quote.company && <Detail label="Company">{quote.company}</Detail>}
                    {quote.website && <Detail label="Website"><External href={quote.website} /></Detail>}
                    {quote.projectType && <Detail label="Project type">{PROJECT_TYPE_LABELS[quote.projectType]}</Detail>}
                    {quote.budget && <Detail label="Budget">{BUDGET_LABELS[quote.budget]}</Detail>}
                    {quote.timeline && <Detail label="Timeline">{TIMELINE_LABELS[quote.timeline]}</Detail>}
                    {quote.referenceSites.length > 0 && (
                        <Detail label="Sites they like">
                            {quote.referenceSites.map(site => <div key={site}><External href={site} /></div>)}
                        </Detail>
                    )}
                    <Divider />
                    <Typography sx={{ whiteSpace: 'pre-wrap' }}>{quote.message}</Typography>
                </Stack>
            </Paper>

            <Stack direction="row" sx={{ gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <StatusPicker quoteId={quote.id} status={quote.status} />
                <Button variant="contained" href={`mailto:${quote.email}?subject=${encodeURIComponent('Re: your quote request')}`}>Reply by email</Button>
            </Stack>
            <Box sx={{ mb: 4 }}>
                <QuoteActions quoteId={quote.id} archived={!!quote.archivedAt} emailsMissing={missing} />
            </Box>

            <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Notes</Typography>
            <NoteForm quoteId={quote.id} />
            <Stack sx={{ gap: 1.5, mt: 3 }}>
                {quote.notes.map(note => (
                    <Paper key={note.id} variant="outlined" sx={{ p: 2, display: 'flex', gap: 1 }}>
                        <Box sx={{ flex: 1 }}>
                            <Typography variant="caption" color="text.secondary">{formatWhen(note.createdAt)}</Typography>
                            <Typography sx={{ whiteSpace: 'pre-wrap' }}>{note.body}</Typography>
                        </Box>
                        <DeleteNoteButton quoteId={quote.id} noteId={note.id} />
                    </Paper>
                ))}
            </Stack>
        </Container>
    )
}
```

- [ ] **Step 6: Check it builds**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; `/admin` and `/admin/quotes/[id]` are dynamic (ƒ).

- [ ] **Step 7: Check it in the browser with a local test session**

Google sign-in can't be used here, so mint a session cookie with the local `AUTH_SECRET` (a verification step only; nothing is added to the code). From the repo root:

```bash
node --env-file=.env --input-type=module -e "import { encode } from 'next-auth/jwt'; console.log(await encode({ token: { email: process.env.ADMIN_EMAIL, name: 'Koda', sub: 'local-check' }, secret: process.env.AUTH_SECRET, salt: 'authjs.session-token', maxAge: 3600 }))"
```

In the browser pane on `http://localhost:3000`, set it with `javascript_tool`: `document.cookie = 'authjs.session-token=<token>; path=/'`. Then, with at least three quotes submitted through `/quote` (Task 7's steps):

1. `/admin` lists them newest first, with the new count; the filter chips change the list; the page has no console errors. Screenshot.
2. Open a quote: every field shows, example links open in a new tab.
3. Change the status to Replied: the chip updates, and the inbox shows it under the Replied filter.
4. Add two notes (newest shows first), delete one.
5. Archive: it leaves the default view and appears under Archived; unarchive brings it back.
6. Resend: make one quote look unsent with `docker compose -f docker-compose.dev.yml exec db psql -U horizons -c "update \"Quote\" set \"confirmedAt\" = null, \"createdAt\" = now() - interval '5 minutes' where id = (select id from \"Quote\" limit 1)"`, reload: the warning mark shows in the inbox and the alert on the quote page. Click "Resend emails": the warning goes, and Mailpit has exactly one new message (the confirmation).
7. Delete a quote through the dialog: it returns to the inbox without it.
8. Sign out: back to `/admin/sign-in`, and `/admin` redirects there again.
9. Set a cookie minted for another address (change `process.env.ADMIN_EMAIL` in the command to `'someone@example.com'`): `/admin` redirects to sign-in (this is `requireAdmin()` doing its job even though the middleware lets the session through).

- [ ] **Step 8: Commit**

```bash
git add "app/(admin)"
git commit -m "Add the admin quote inbox

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Deployment

**Files:**
- Modify: `dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`
- Create: `scripts/db-backup.sh`, `.gitattributes`

**Interfaces:**
- Consumes: the `build` script (Task 6), `prisma/migrations` (Task 6), `.env.example` (Task 6)
- Produces: nothing new

- [ ] **Step 1: Write the image**

Replace `dockerfile` with:

```dockerfile
# Node 22: Node 20 reached end of life in April 2026, and Prisma 7 needs 20.19 or newer anyway
FROM node:22-alpine

WORKDIR /app

# Prisma's migration engine links against OpenSSL
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Generates the Prisma client, then builds the site (see "build" in package.json). No database is needed for this.
RUN npm run build

EXPOSE 3000

# Applies any new database migrations before starting, so deploying stays git pull and docker compose up -d --build
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
```

Add to `.dockerignore`:

```
server/generated/
dist/
```

- [ ] **Step 2: Write the backup job**

Create `.gitattributes`:

```
# Shell scripts run inside Linux containers, so they keep LF line endings even when checked out on Windows
*.sh text eol=lf
```

Create `scripts/db-backup.sh`:

```sh
#!/bin/sh
# Runs in the db-backup container (docker-compose.yml): writes a dump of the site's database into /backups once a day,
# and keeps 14 days of them. A stopgap until backups are done properly in a later part of the client portal.
#
# Restore one (this replaces what's in the database):
#   docker compose exec db-backup pg_restore --clean --if-exists -d horizons /backups/horizons-YYYY-MM-DD.dump

set -u

while true; do
    stamp=$(date +%Y-%m-%d)
    if pg_dump --format=custom --file="/backups/horizons-$stamp.dump.partial"; then
        mv "/backups/horizons-$stamp.dump.partial" "/backups/horizons-$stamp.dump"
        echo "db-backup: wrote horizons-$stamp.dump"
    else
        rm -f "/backups/horizons-$stamp.dump.partial"
        echo "db-backup: pg_dump failed, trying again tomorrow" >&2
    fi
    find /backups -name 'horizons-*.dump' -mtime +13 -delete
    sleep 86400
done
```

- [ ] **Step 3: Write the services**

Replace `docker-compose.yml` with:

```yaml
# The site and its database. Secrets come from .env beside this file (see .env.example).

services:
  web:
    build: .
    container_name: horizons
    ports:
      - "5004:3000"
    env_file: .env
    environment:
      # Built here from POSTGRES_PASSWORD, so .env on the server has no DATABASE_URL to keep in step
      DATABASE_URL: postgresql://horizons:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/horizons
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  # No published port: only the site and the backup job can reach it, over the compose network
  db:
    image: postgres:18-alpine
    container_name: horizons-db
    environment:
      POSTGRES_USER: horizons
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: horizons
    volumes:
      # Postgres 18 keeps its data in a versioned folder under here, which makes future major upgrades easier
      - db-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "horizons", "-d", "horizons"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  db-backup:
    image: postgres:18-alpine
    container_name: horizons-db-backup
    entrypoint: ["sh", "/db-backup.sh"]
    environment:
      PGHOST: db
      PGUSER: horizons
      PGPASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      PGDATABASE: horizons
    volumes:
      - ./scripts/db-backup.sh:/db-backup.sh:ro
      - db-backups:/backups
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

volumes:
  db-data:
  db-backups:
```

- [ ] **Step 4: Check the whole stack locally**

Stop the dev server first (it holds nothing the stack needs, but frees the machine). Your local `.env` needs `POSTGRES_PASSWORD` set; set it to any value for this check (`sed -i 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=local-check/' .env`).

```bash
docker compose -p horizons-check up -d --build
docker compose -p horizons-check logs web | tail -20
```

Expected: the logs show `prisma migrate deploy` applying the `init` migration, then Next starting.

1. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5004/quote` prints `200`.
2. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5004/admin` prints `307`.
3. `docker compose -p horizons-check exec db sh -c 'echo $PGDATA'` prints a path under `/var/lib/postgresql` (inside the volume).
4. `docker compose -p horizons-check exec db-backup ls /backups` lists today's `horizons-*.dump`.
5. `docker compose -p horizons-check restart web` then `logs web`: migrate reports nothing to apply, and the site starts again.
6. The `db` service publishes no port: `docker compose -p horizons-check port db 5432` prints nothing (or an error).

Then remove it: `docker compose -p horizons-check down -v`.

- [ ] **Step 5: Document it**

In `README.md`, directly after the opening "Getting Started" section's dev-server paragraph (before `## Wallpaper Engine`), add:

````markdown
## Quotes and the admin area

The "Get a quote" form (`/quote`) saves each request to Postgres, emails it to Koda and sends the person a short
confirmation. The admin area (`/admin`) lists the requests, behind Google sign-in for one account. The design is in
`docs/superpowers/specs/2026-09-20-quote-form-and-admin-inbox-design.md`.

### Running it locally

```bash
cp .env.example .env    # then set AUTH_SECRET (openssl rand -base64 33)
npm install
npm run services        # Postgres and Mailpit, in Docker
npx prisma migrate dev  # creates the tables
npm run dev
```

Emails land in Mailpit at http://localhost:8025. `npm test` runs every test, including the database tests against the
`horizons_test` database that `npm run services` creates.

### Deploying

`docker compose up -d --build` runs the site, Postgres and a nightly database dump (14 days kept, in the `db-backups`
volume). New migrations apply when the site starts. It needs a `.env` beside `docker-compose.yml`, from
`.env.example`, with:

- `POSTGRES_PASSWORD`: any long random string, set once
- `AUTH_SECRET`: another long random string, and `AUTH_URL=https://www.horizons.gg`
- `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, from a Google Cloud OAuth client (web application) whose redirect URIs
  are `https://www.horizons.gg/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`
- `ADMIN_EMAIL`: the one Google account allowed in
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, from a Cloudflare Turnstile widget for `www.horizons.gg`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS`, from the email relay, with `dev.horizons.gg` verified there as
  a sending domain (add the relay's DNS records in Cloudflare; mailops doesn't manage them)
- `MAIL_FROM`, `QUOTE_NOTIFY_TO` and `QUOTE_REPLY_TO` as in `.env.example`

To restore a dump: `docker compose exec db-backup pg_restore --clean --if-exists -d horizons /backups/horizons-YYYY-MM-DD.dump`
(this replaces what's in the database).
````

- [ ] **Step 6: Commit**

```bash
git add dockerfile docker-compose.yml .dockerignore .gitattributes scripts/db-backup.sh README.md
git commit -m "Run Postgres and a nightly dump beside the site

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Final verification

**Files:** none new (fixes only, if a check fails)

- [ ] **Step 1: Run every check**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run wallpaper
```

Expected: all pass. `npm test` output includes the database tests running (not skipped).

- [ ] **Step 2: Check for em dashes in everything this branch added or changed**

```bash
git diff --name-only origin/Master...HEAD | while read -r f; do [ -f "$f" ] && LC_ALL=C grep -Hn $'\xe2\x80\x94' "$f"; done
printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c $'\xe2\x80\x94'
git log origin/Master..HEAD --format=%B | LC_ALL=C grep -c $'\xe2\x80\x94'
git diff --name-only origin/Master...HEAD | while read -r f; do [ -f "$f" ] && grep -Hn '&mdash;' "$f"; done
```

Expected: the first command prints nothing except hits inside code comments; the second prints `1` (proving the search works); the third prints `0`. The fourth prints nothing.

- [ ] **Step 3: Walk through it once more end to end**

With `npm run services` and the dev server running: submit a quote at `/quote`, see both emails in Mailpit, see it in `/admin` (test session cookie as in Task 10), change its status, add a note, archive it. Take a final screenshot of the landing page's two links and of the inbox.

- [ ] **Step 4: Commit any fixes**

If any step needed a fix, commit it with a message saying what was wrong.

---

## What Koda does after merging

These are Koda's (their accounts), listed in the README's "Deploying" section:

1. Create the Google OAuth client, the Turnstile widget and the relay account, and add the relay's DNS records.
2. On the dedicated server: `git pull`, create `.env` from `.env.example`, then `docker compose up -d --build`.
3. Sign in at `https://www.horizons.gg/admin/sign-in`, and send a test quote through `https://www.horizons.gg/quote`.
