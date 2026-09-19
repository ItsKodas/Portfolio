# Quote form and admin inbox design

Date: 2026-09-20
Status: approved design, not yet implemented

## Context

The site (`www.horizons.gg`, a Next.js 15 app with React 18, Tailwind and MUI) has no backend: no database, no route
handlers, no server actions. A self-hosted mail stack now runs on the same dedicated server under `mail/`, receiving
mail for `dev.horizons.gg` and forwarding `info@dev.horizons.gg` to `koda@horizons.gg`.

The long-term goal is a client portal built into the site: an admin area for Koda, and a client area for existing
clients to manage the sites Koda built them. That was split into seven parts. This spec is **Part 1**: the backend
foundation, a public "Get a quote" form, and an admin inbox for the quotes it produces. Everything later parts need
(a database, sign-in, an admin area) is laid down here in the smallest form that serves the quote form.

## Scope

### In scope

- Postgres and Prisma, deployed beside the site
- A public `/quote` page with the form, linked from the landing page
- Spam protection: Cloudflare Turnstile, a honeypot field and a per-IP rate limit
- Two emails per quote through a transactional relay: a notification to Koda and a confirmation to the prospect
- Google sign-in for one admin, and an admin inbox with status, notes, archive, delete and email resend
- Keeping `npm run wallpaper` (the static export) working
- A nightly database dump
- A test setup for the site (Vitest)

### Not in scope

- Client accounts, the client area, or any control of client sites (Parts 2 onward; the site-control service is being
  designed separately)
- Replying to quotes from the admin area (replies happen in Gmail, via Reply-To)
- File attachments on the form
- Any change to the landing page's scene, or to the mail stack
- Any change to `horizons.gg` apex mail records or `koda@horizons.gg`

## Decisions

**Postgres and Prisma.** The later parts (client accounts, sites, backups) are relational, and Postgres is the
obvious home for them. Prisma gives typed queries and versioned migrations. Postgres runs as a container beside the
site with no published port.

**Auth.js (NextAuth v5) with Google, one allowed account.** Koda already signs in to Google as `koda@horizons.gg`, so
there is no password to store or leak. Sign-in is refused unless Google reports the email as verified and it equals
`ADMIN_EMAIL`. Sessions are signed JWT cookies (7 days), so checking a session never touches the database and no users
table exists yet. Part 2 adds real accounts.

**The database is the source of truth; email is a notification.** A quote is saved before any email is attempted. An
email failure is recorded on the quote and can be retried from the admin area. No failure after validation loses a
quote.

**A transactional relay, used only by the site.** The home connection's IP is permanently on the Spamhaus PBL and its
reverse DNS does not forward-confirm, so mail the site sends goes through a relay (Resend or Postmark suggested; the
site speaks plain SMTP, so any provider works). The relay is **not** set as the mail stack's `RELAY_HOST`: relays only
send mail whose From domain is verified with them, and forwarded mail keeps its original sender, so a stack-wide relay
would break forwarding. Inbound forwarding stays exactly as it is.

**The relay needs no change to mailops.** Both suggested providers put their bounce address on their own subdomain
(Resend: `send.dev.horizons.gg`; Postmark: a CNAME such as `pm-bounces.dev.horizons.gg`) and sign with their own DKIM
selector. SPF is checked against that subdomain, and DKIM signs as `dev.horizons.gg`, so DMARC aligns without touching
the SPF record mailops manages on `dev.horizons.gg`. Koda adds the provider's records in Cloudflare; none of them are
names mailops manages.

**The confirmation email never repeats the prospect's message.** Anyone can type any address into the form. If the
confirmation echoed the message, the form would let a stranger send arbitrary text from Koda's domain to anyone. It
says only that the request arrived and Koda will be in touch.

**Two layers of admin protection.** Middleware redirects unauthenticated requests for `/admin`, and every admin page
and server action checks the session again itself (and re-checks the email against `ADMIN_EMAIL`). Middleware alone
has been bypassed before (CVE-2025-29927, patched in the version in use); the second check means one bug does not
expose the inbox.

**No development sign-in bypass.** A switch that skips Google sign-in locally is a switch that can be left on in
production. Google sign-in is tested by Koda at deploy time instead.

## Architecture

### Routes

| Route | Contents |
| --- | --- |
| `app/(landing)` | The existing landing page, plus two "Get a quote" links (see below) |
| `app/(quote)/quote` | The public form page and its server action |
| `app/(admin)/admin` | The inbox, a quote page (`/admin/quotes/[id]`) and the sign-in page (`/admin/sign-in`) |
| `app/api/auth/[...nextauth]` | Auth.js's routes |
| `middleware.ts` (repo root) | Redirects `/admin/*` (except `/admin/sign-in`) to sign-in without a session |

Server-only code lives in `server/` at the repo root, outside `app/`. Each module imports `server-only`, so importing it
from a client component fails the build.

| Module | Purpose |
| --- | --- |
| `server/env.ts` | Reads and validates the environment with zod, lazily, with clear messages for anything missing |
| `server/db.ts` | The Prisma client (one instance per process) |
| `server/auth.ts` | Auth.js config and `requireAdmin()` |
| `server/quotes/schema.ts` | The zod schema for a submission, shared by the form (instant feedback) and the server |
| `server/quotes/submit.ts` | The submission pipeline, with its dependencies passed in so it can be tested without a database or network |
| `server/quotes/emails.ts` | Builds the two emails (text and HTML, every value escaped) |
| `server/mailer.ts` | Sends through the relay with nodemailer |
| `server/turnstile.ts` | Verifies a Turnstile token with Cloudflare |
| `server/ratelimit.ts` | Hashes the client IP and counts recent quotes from it |

The schema file has no server-only dependencies, so the client form can import it; it is the one exception to
`server-only`.

### The landing page

Two links to `/quote`, styled like the page's existing pill buttons: one under the introduction in the About section,
and one in the closing "Let's build something" section. The parallax scene, its layout and the wallpaper link are not
touched.

### The quote page

Styled to match the landing page's content: the night navy background, frosted panels and the lake-blue accent. It is
a server component that reads the Turnstile site key at request time and passes it to the client form component. (A
`NEXT_PUBLIC_` variable would be inlined at build time, and `.env` is deliberately not in the Docker build context.)
On success the form is replaced in place by a thank-you message. A short line under the form says the details are only
used to reply to the enquiry.

### The wallpaper build

`scripts/wallpaper.mjs` copies all of `app/` and builds it as a static export, which cannot contain server actions,
route handlers or middleware. Its copy step gets a filter that skips `app/(quote)`, `app/(admin)` and `app/api`.
`middleware.ts` and `server/` are outside the copied sources already. The root layout gains nothing server-side (the
admin area's providers live in the admin layout), so the wallpaper builds from the same code it builds from today.

### MUI in the admin area

The admin layout wraps its pages in `AppRouterCacheProvider` (from `@mui/material-nextjs`, matching the installed MUI
major) and a dark MUI theme using the site's navy, so MUI's styles render on the server without a flash. This stays in
the admin layout and does not affect the landing page.

## Data model

```prisma
enum QuoteStatus { NEW REPLIED WON LOST }
enum ProjectType { NEW_SITE REDESIGN WEB_APP ONLINE_STORE OTHER }
enum Budget      { UNDER_2K FROM_2K_TO_5K FROM_5K_TO_10K OVER_10K NOT_SURE }
enum Timeline    { ASAP ONE_TO_THREE_MONTHS OVER_THREE_MONTHS FLEXIBLE }

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
  notifiedAt     DateTime?    // email to Koda sent
  confirmedAt    DateTime?    // confirmation to the prospect sent
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
}
```

Labels shown to people (for example "$2k to $5k") live in one map beside the schema, so the form, the emails and the
admin area show the same wording.

| Question | Options (AUD for budget) |
| --- | --- |
| Project type | New website, Redesign, Web app, Online store, Other |
| Budget | Under $2k, $2k to $5k, $5k to $10k, $10k+, Not sure yet |
| Timeline | As soon as possible, 1 to 3 months, 3+ months, Flexible |

`ipHash` is an HMAC-SHA256 of the client IP keyed with `AUTH_SECRET`. The IP itself is never stored. Rotating the
secret only resets the rate-limit window.

## Validation

| Field | Rule |
| --- | --- |
| Name | Required, 1 to 100 characters, single line |
| Email | Required, a valid address, at most 254 characters |
| Message | Required, 10 to 5,000 characters |
| Company | Optional, at most 100 characters, single line |
| Website | Optional, an `http` or `https` URL, at most 200 characters |
| Project type, budget, timeline | Optional, one of the listed options |
| Reference sites | Optional, up to 5, each an `http` or `https` URL of at most 200 characters |

Single-line fields reject line breaks, which also keeps them out of email headers. Empty optional fields are stored as
null. The same schema runs in the browser for instant feedback; only the server's result counts.

## Submission flow

The form posts to a server action, which runs these steps in order:

1. **Honeypot.** A visually hidden field (off-screen, `aria-hidden`, `tabIndex={-1}`, `autoComplete="off"`) that people
   never fill in. If it has a value, the action returns the normal success result and stores nothing.
2. **Turnstile.** The token is verified with Cloudflare's `siteverify`, passing the client IP. A failure returns "please
   try again". If the secret key is missing in production, submissions are refused and the error is logged (fail
   closed).
3. **Rate limit.** At most 5 saved quotes per IP hash in the last hour, counted in the database so a restart does not
   reset it. Over the limit returns "you've sent a few already, please try again later". The IP comes from Cloudflare's
   `CF-Connecting-IP` header, falling back to the first `X-Forwarded-For` entry and then `unknown` (local development).
4. **Validation** with the schema above. Failures return per-field messages.
5. **Save.** The quote is inserted and the action returns success.
6. **Emails, after the response.** Scheduled with Next's `after()` so the prospect does not wait on the relay. Each
   email is sent independently; on success its timestamp (`notifiedAt` or `confirmedAt`) is set, on failure the error
   is logged and the timestamp stays null.

### The emails

| | To Koda | To the prospect |
| --- | --- | --- |
| From | `MAIL_FROM` (for example `Horizons <quotes@dev.horizons.gg>`) | `MAIL_FROM` |
| To | `QUOTE_NOTIFY_TO` (`koda@horizons.gg`) | The prospect's address |
| Reply-To | The prospect | `QUOTE_REPLY_TO` (`info@dev.horizons.gg`, forwarded to Koda) |
| Subject | `New quote: <name>` plus the project type when given | `Thanks, I've got your request` |
| Body | Every field, and a link to the quote in the admin area | A short thank-you. **Never** the message or any other free text they entered, apart from their name |

Both are sent as plain text with a simple HTML version. Every user-supplied value is HTML-escaped in the HTML version.

### Failure behaviour

| Failure | What happens |
| --- | --- |
| Database unreachable at save | The form shows "something went wrong, please try again", and the error is logged. Nothing was saved, and the prospect knows it. |
| Relay down, wrong credentials, or the process restarts mid-send | The quote is saved. The timestamp stays null, and the admin area shows "email not sent" with a resend button. |
| Turnstile unreachable | Treated as a failed check: "please try again". |
| SMTP settings missing | Same as a relay failure: saved and flagged, error logged. |

Right after a submission there is a window of a few seconds where a quote legitimately has no timestamps yet. The
inbox shows the warning only for quotes older than two minutes.

## Admin area

### Sign-in

`/admin/sign-in` shows one "Sign in with Google" button. Auth.js's `signIn` callback allows only a verified Google email
equal to `ADMIN_EMAIL`; anything else is sent back to the sign-in page with "not authorised". A sign-out button sits in
the admin header. All admin pages set `robots: noindex`, and `robots.ts` disallows `/admin`.

`requireAdmin()` reads the session, checks the email against `ADMIN_EMAIL`, and redirects to sign-in otherwise. Every
admin page and every admin server action calls it first.

### Inbox (`/admin`)

- A table of quotes, newest first: date, name, company, project type, budget and a status chip
- A status filter (all, new, replied, won, lost) and a separate archived view; the default view hides archived quotes
- A count of new quotes
- A warning mark on quotes with an email not sent

### Quote page (`/admin/quotes/[id]`)

- Every field. Website and reference links open in a new tab with `rel="noopener noreferrer nofollow"`.
- A status picker, and a "Reply by email" `mailto:` link
- Notes, newest first, with a box to add one and a delete button on each
- Archive and unarchive
- "Resend emails", shown only when an email is not sent. It sends only the missing one(s) and sets their timestamps.
- Delete, behind a confirmation dialog. It removes the quote and its notes. (It remains in the nightly dumps until they
  expire, 14 days later.)

Each change is a server action that calls `requireAdmin()`, validates its input, and revalidates the affected pages.

## Deployment

The site runs from the root `docker-compose.yml` on the same dedicated server as the mail stack.

- **`db` service:** the official Postgres image, a named volume, a `pg_isready` healthcheck, and no published port. Only
  services on the compose network can reach it.
- **`web` service:** gains `env_file: .env`, a `DATABASE_URL` built from `POSTGRES_PASSWORD` in the compose file, and
  `depends_on: db` with `condition: service_healthy`.
- **Migrations on start:** the image generates the Prisma client at build, and the container's command runs
  `prisma migrate deploy` before `next start`. Deploying stays `git pull && docker compose up -d --build`.
- **Building without a database:** every page that reads the database or the session is dynamic, so `next build` never
  connects to Postgres.
- **`db-backup` service:** the Postgres image running a small loop that writes a `pg_dump` into a `db-backups` volume
  once a day and deletes dumps older than 14 days. A stopgap until the backup work in a later part.
- **Secrets:** a root `.env` (already gitignored and excluded by `.dockerignore`), with a committed `.env.example`
  listing every variable.

### Environment

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | The database password (the compose file builds `DATABASE_URL` from it) |
| `AUTH_SECRET` | Signs sessions, and keys the IP hash |
| `AUTH_URL` | `https://www.horizons.gg` |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | The Google OAuth client |
| `ADMIN_EMAIL` | `koda@horizons.gg` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | The relay |
| `MAIL_FROM` | For example `Horizons <quotes@dev.horizons.gg>` |
| `QUOTE_NOTIFY_TO` | `koda@horizons.gg` |
| `QUOTE_REPLY_TO` | `info@dev.horizons.gg` |

### What Koda sets up

These need Koda's own accounts, so they are Koda's to do:

1. A Google OAuth client (Google Cloud Console, web application) with redirect URIs
   `https://www.horizons.gg/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`
2. A Turnstile widget in Cloudflare for `www.horizons.gg` and `localhost`
3. A relay account, with `dev.horizons.gg` added as a sending domain and the provider's DNS records added in Cloudflare
4. The root `.env` on the dedicated server

## Local development

A `docker-compose.dev.yml` runs Postgres (published on localhost only) and **Mailpit**, a local mail catcher, so the
whole flow runs on the development machine without the relay. Cloudflare's published always-pass Turnstile test keys
stand in for real ones.

## Testing strategy

The site already has a `vitest.config.ts` and tests under `app/perf`, but `vitest` is missing from `package.json`
(it is only in the lockfile). It is added as a dev dependency with a `test` script, and the config's `include` gains
`server/**/*.test.ts`.

**Unit tests**, with stand-ins for the database, Turnstile and the mailer, following the dependency-injected style of
`mail/mailops`:

- The schema: every rule in the validation table, including line breaks in single-line fields and non-http URLs
- The pipeline: honeypot stores nothing and reports success; Turnstile failure stores nothing; the rate limit counts
  and refuses; the save happens before any email; an email failure leaves the quote saved with a null timestamp; each
  email's success sets only its own timestamp
- The emails: the confirmation contains none of the prospect's free text; Reply-To is correct on both; HTML is escaped
- The IP extraction and hashing
- The admin allowlist: wrong email, unverified email and the right email
- `requireAdmin()` on a missing session, a wrong-email session and the right one

**Database tests** against a real Postgres (the dev compose file), covering the migrations, the rate-limit count, the
inbox queries (filters, archive, ordering), note cascade on delete and resend. They run when `TEST_DATABASE_URL` is set
and are skipped otherwise.

**Builds:** `npm run build`, `npm run wallpaper`, `npm run lint` and `npx tsc --noEmit` must all pass.

**In the browser:** with the dev compose file running, submit quotes through `/quote` (valid, invalid, honeypot, over
the rate limit), check both emails in Mailpit, and check the landing page looks unchanged apart from the two links.
The admin pages are checked for rendering and redirects; signing in with Google is the one step only Koda can test.

## Known risks and accepted weaknesses

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| `CF-Connecting-IP` can be forged by anyone reaching port 5004 directly rather than through Cloudflare | It only lets someone dodge the rate limit; Turnstile still has to pass. Restricting the origin to Cloudflare's IPs is a separate hardening task. |
| The confirmation email can be aimed at a stranger | Turnstile and the rate limit bound the volume, and the email carries no attacker-chosen text. |
| One admin, identified by email | Deliberate for Part 1. Part 2 replaces it with real accounts and roles. |
| Nightly dumps sit on the same disk as the database | They cover mistakes (a bad delete, a broken migration), not disk loss. Proper backups come in a later part. |
| Auth.js v5's release status | The version is pinned in the plan and upgraded deliberately. |

## Later parts

Part 2 adds client accounts and a client sign-in. The site-control service (start and stop, logs, files, backups and
domains for client sites) is designed separately, as its own service on the dedicated server that the portal talks to
over a narrow API, because the internet-facing site must not hold the Docker socket.
