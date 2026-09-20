# Client accounts design

Date: 2026-09-20
Status: approved design, not yet implemented

## Context

The portfolio site (`www.horizons.gg`, Next.js 15 App Router, React 18, Tailwind, MUI 6, Prisma 7 and Postgres) now
runs Part 1 of the client portal in production: a public `/quote` form and an admin inbox at `/admin` behind Auth.js
v5 Google sign-in restricted to one account. See
[the Part 1 design](2026-09-20-quote-form-and-admin-inbox-design.md) for the patterns this part follows: server-only
modules under `server/`, dependency-injected logic tested with Vitest, and route groups under `app/`.

This is **Part 2: client accounts**. It establishes who a client is, how they authenticate, and the notion that a
client owns sites. It does not build any site controls. Those are served by `hostd/`, a separate service on the
dedicated server that another session owns, and the portal screens that use it are a later part.

### What the client area will eventually do

Clients will see status and history for their own site, start, stop and restart it, read live logs, run and download
backups, browse the Git commit list, and download their source, env files, volume data and database. All of that is
hostd's work. Part 2 exists so that hostd has an authenticated actor to receive.

### The interface hostd already expects

[The hostd design](2026-09-20-hostd-design.md) is written and partly built, and it already depends on identifiers
this part produces. That makes them an interface, not an implementation detail.

| What hostd expects | Where it appears |
| --- | --- |
| A client id the operator types by hand into `hostd/projects.yaml` as `client: cl_8f2k1` | The registry, one per project |
| `X-Hostd-Actor: client:<clientId>` or `admin` | Every API request from the portal |
| `X-Hostd-User: <portal user id>`, used only for the audit log | Every API request from the portal |
| `CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/` and a separate `USER_ID` format | `hostd/src/shared/formats.ts` |

hostd's registry is the source of truth for which projects exist and who owns them. The portal never writes it.

## Scope

### In scope

- A `Client` record, with a short readable id that is the identifier hostd uses
- A link from a client to the quotes they came from
- An emailed invite, a password, and mandatory authenticator (TOTP) enrolment before the account works
- Recovery codes, a self-service password reset, and admin resets as the lockout escape hatch
- Database-backed client sessions, so suspending a client or resetting their password cuts access immediately
- An admin area for clients: create (including from a won quote), edit, suspend, reset, delete
- A thin `Site` record, so a client owns sites before hostd exists
- A placeholder client landing page after sign-in
- Tests, in the style Part 1 established

### Not in scope

- Anything under `hostd/` or `mail/`
- Any site control: status, start and stop, logs, files, backups, domains
- The client dashboard screens, which another session is designing
- Passkeys or WebAuthn
- Several people signing in for one client (see **Decisions**)
- Any change to `koda@horizons.gg`, the `horizons.gg` apex mail records, or the admin's Google sign-in

## Decisions

**One client, one login, shaped so a split is cheap later.** A client is one contact with one password and one
authenticator, stored on the `Client` row. The credential handling lives behind its own modules that take a record
rather than reach for one, so separating "the organisation" from "the people who sign in" later is a storage change
and a migration, not a rewrite of the auth logic. hostd already distinguishes `client:<clientId>` from the portal
user id, so the seam exists on that side too; for now both headers carry the same value.

**Client authentication is our own, and Auth.js is left alone.** Auth.js only supports its Credentials provider with
JWT sessions, and throws when a Credentials provider is paired with a database session strategy. Database-backed
sessions are a requirement here, because a login that can eventually download a client's database must be revocable
on the next request rather than at the next token expiry. Routing client passwords through Auth.js would therefore
mean bolting a database check onto a token we still could not fully trust, and it would mean editing the config the
admin's Google sign-in depends on.

So: Auth.js keeps doing exactly what it does today, Google only, one account, `/admin`. Client sign-in is a separate
cookie, a separate table, and a handful of small modules under `server/clients/`. The two sign-ins share no
configuration, no callback and no cookie, which is what makes "the admin sign-in is unchanged" a structural fact
rather than a promise. It also means an admin and a client session can coexist in one browser.

The cost is that we own about two hundred lines of session and cookie code. That is accepted because Auth.js would
not have been doing that work for us in this configuration anyway, and because the surface is small enough to test
thoroughly.

**Mandatory 2FA is enforced by the shape of the data, not by a check.** A session row carries `mfaAt`. A session with
`mfaAt` null can reach the second-factor step and nothing else. `requireClient()` demands `mfaAt`. Only three code
paths write it, and each is reached only after a verified TOTP code, a verified recovery code, or completed
enrolment. There is no configuration switch, and no forgotten check, that can produce a usable client session without
an authenticator.

**scrypt, not argon2.** OWASP puts argon2id first and scrypt second, but argon2 for Node is a native module and the
image is `node:24-alpine`, so it means musl prebuilds or a compiler in the build. `crypto.scrypt` ships with Node at
parameters OWASP accepts, and adds no dependency to a security-critical path. The parameters are stored with each
hash so the cost can be raised, or lowered, without invalidating a password.

**Our own TOTP, not a library.** RFC 6238 is small, and the RFC publishes test vectors, so "this matches the
standard" is a test result rather than a claim about a dependency. The implementation is about sixty lines over
`node:crypto`.

The QR code is the one thing worth a dependency, and it is the only one this part adds: `qrcode` (pure JavaScript, no
native build) with `@types/qrcode` as a dev dependency. It renders on the server into a data URI, so no third-party
script runs in the page that shows a client's secret.

**Secrets are encrypted at rest under their own key.** TOTP secrets are AES-256-GCM under a new `CLIENT_SECRET_KEY`,
and recovery codes are keyed HMACs under the same key. The nightly `pg_dump` sits on the same disk as the database,
so a dump that leaks must not hand someone working second factors. It is deliberately not `AUTH_SECRET`: rotating
that today only resets rate-limit windows, and it must not also brick every client's authenticator.

**hostd owns what sites exist; the portal keeps a thin pointer.** A `Site` row holds a display name and the
`projectId` that keys hostd's registry. It exists so the portal can list a client's sites before hostd is reachable,
and so the admin area can show who owns what. Drift is possible and is deliberately visible: a project id the
registry does not know shows as unavailable rather than failing silently.

**Email is a notification, the database is the truth**, as in Part 1. A client is created and their invite token
written in one transaction; a relay failure is reported and retried from the admin area, and never loses the record.

## Data model

Added to `prisma/schema.prisma`. The existing `Quote` model gains one field.

```prisma
enum ClientTokenPurpose { INVITE, PASSWORD_RESET }

model Client {
  id                String    @id            // "cl_" + 8 Crockford base32 chars, generated in code
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  name              String                   // the contact person
  company           String?
  email             String    @unique
  passwordHash      String?                  // null until the invite is completed
  passwordUpdatedAt DateTime?
  totpSecret        String?                  // AES-256-GCM, never plaintext
  totpConfirmedAt   DateTime?
  suspendedAt       DateTime?
  lastSignInAt      DateTime?
  failedSignIns     Int       @default(0)
  lockedUntil       DateTime?
  quotes            Quote[]
  sites             Site[]
  sessions          ClientSession[]
  tokens            ClientToken[]
  recoveryCodes     ClientRecoveryCode[]
  totpUses          ClientTotpUse[]

  @@index([suspendedAt])
}

model Site {
  id        String   @id @default(cuid())
  projectId String   @unique   // the key in hostd's projects.yaml
  name      String
  createdAt DateTime @default(now())
  client    Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String

  @@index([clientId])
}

model ClientSession {
  id         String    @id @default(cuid())
  tokenHash  String    @unique   // SHA-256 of the cookie value
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime  @default(now())
  expiresAt  DateTime
  mfaAt      DateTime?           // null means the second factor is still outstanding
  userAgent  String?
  client     Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId   String

  @@index([clientId])
  @@index([expiresAt])
}

model ClientToken {
  id        String             @id @default(cuid())
  tokenHash String             @unique
  purpose   ClientTokenPurpose
  createdAt DateTime           @default(now())
  expiresAt DateTime
  usedAt    DateTime?
  client    Client             @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String

  @@index([clientId, purpose])
}

model ClientRecoveryCode {
  id       String    @id @default(cuid())
  codeHash String                        // HMAC-SHA256, keyed with CLIENT_SECRET_KEY
  usedAt   DateTime?
  client   Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId String

  @@index([clientId])
}

// A TOTP code that has already been accepted. Replay is refused by the composite key, so a code captured in a
// phishing proxy cannot be used a second time inside its own 30 second window.
model ClientTotpUse {
  clientId String
  step     BigInt                          // the 30 second counter that was accepted
  usedAt   DateTime @default(now())
  client   Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@id([clientId, step])
  @@index([usedAt])
}

// Sign-in attempts counted per IP. In the database rather than in memory so a restart does not reset the window,
// matching the quote rate limit. A row is written for every failed sign-in and every failed second factor, and for
// every reset request whether or not it matched a client, because a reset that finds nothing is not a failure the
// person can see and must still be bounded.
model ClientAuthAttempt {
  id        String   @id @default(cuid())
  ipHash    String                  // HMAC-SHA256 of the IP under AUTH_SECRET, as server/ratelimit.ts does
  createdAt DateTime @default(now())

  @@index([ipHash, createdAt])
}
```

On the existing `Quote`:

```prisma
  client   Client? @relation(fields: [clientId], references: [id], onDelete: SetNull)
  clientId String?

  @@index([clientId])
```

`SetNull` on purpose: deleting a client must never delete the quote history they came from.

### The client id is an interface

`cl_` followed by 8 Crockford base32 characters. Crockford's alphabet drops I, L, O and U, so an id cannot spell a
word and cannot be misread when typed into `projects.yaml` by hand. 40 bits of randomness, with the unique primary
key and a retry on collision.

It is the primary key rather than a second column, so there is no pair of identifiers to keep in step. It is also
what fills `X-Hostd-User` for now. When a client is later split into an organisation with several people, that header
starts carrying the person's id and this one keeps meaning the organisation, which is the split hostd's two headers
already anticipate.

### There is no status enum

State is derived from the fields:

| Shown as | Condition |
| --- | --- |
| Invited | `passwordHash` is null |
| Setup incomplete | `passwordHash` set, `totpConfirmedAt` null |
| Suspended | `suspendedAt` set |
| Locked | `lockedUntil` in the future |
| Active | none of the above |

A status column would allow a row that says `ACTIVE` while `passwordHash` is null, which is a state that must not be
representable.

## Credentials, second factor and sessions

### Passwords

`crypto.scrypt` at OWASP's `N = 2^17, r = 8, p = 1`, a 16 byte random salt and a 32 byte output, stored as:

```
scrypt$17$8$1$<salt base64>$<hash base64>
```

The parameters travel with the hash, so a sign-in that verifies against an old cost rehashes at the current one.
Comparison uses `timingSafeEqual`. A malformed or truncated stored value is refused rather than throwing.

Those parameters cost about 134 MB per hash, which is the point of scrypt but also makes concurrent sign-ins the
expensive path. So the rate limit is checked **before** any hashing. When an email does not exist, a dummy hash runs
anyway, so a missing account and a wrong password take the same time and the form cannot be used to discover who the
clients are.

Policy: at least 12 characters, no composition rules, with a strength hint as they type. This follows current NIST
guidance and is kinder to non-technical clients than rules that push everyone towards `Password1!`.

### TOTP

RFC 6238: HMAC-SHA1, 6 digits, a 30 second step, and a one step window either side, so about 90 seconds of tolerance
for a slightly wrong clock. SHA-1 because it is the RFC default and what authenticator apps actually implement; the
collision work against SHA-1 does not apply to HMAC-SHA1.

A 20 byte secret, base32 encoded, offered as the standard URI:

```
otpauth://totp/Horizons:client@example.com?secret=...&issuer=Horizons&algorithm=SHA1&digits=6&period=30
```

rendered as a QR code and also shown as text in groups of four, for a client whose phone will not scan.

### Recovery codes

Ten codes, each 10 Crockford base32 characters shown as `xxxxx-xxxxx`, about 50 bits each. Generated once at
enrolment and shown once, with copy and download. Stored only as keyed HMACs. A recovery code is accepted anywhere a
TOTP code is, and is marked used the moment it succeeds.

### Sessions

The cookie holds 32 random bytes, base64url. Only its SHA-256 is stored, so reading the database does not let someone
resume a session.

| Attribute | Value |
| --- | --- |
| Name | `__Secure-horizons-client` in production, `horizons-client` in development (the prefix requires HTTPS) |
| Flags | `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/` |

`Lax` rather than `Strict` because invite and reset links arrive from a mail client as a top-level navigation, and
`Strict` would drop the cookie on that first hop.

Lifetimes:

| Session | Lifetime |
| --- | --- |
| `mfaAt` null | 10 minutes, and can reach only the second-factor or enrolment step |
| `mfaAt` set | 24 hours idle, 7 days absolute, whichever comes first |

`lastUsedAt` and `expiresAt` are written only when more than 5 minutes have passed, so a normal page view costs no
write.

Three tables accumulate rows that stop mattering, and all three are pruned lazily on a successful sign-in rather than
by a scheduled job, because a sign-in is the only moment any of them grows:

| Table | Pruned |
| --- | --- |
| `ClientSession` | Rows for that client whose `expiresAt` has passed |
| `ClientTotpUse` | Rows for that client older than 5 minutes, which is well past the accepted window |
| `ClientAuthAttempt` | Rows older than the 15 minute window, across all clients |

### Limits and lockout

| Guard | Rule | What the person sees |
| --- | --- | --- |
| Per IP | 10 failed attempts in 15 minutes, across sign-in, second factor and reset requests | "Too many attempts. Please try again in a few minutes." |
| Per account | `failedSignIns` counts wrong passwords and wrong codes; `lockedUntil` backs off 1, 5, 15 then 60 minutes | "This account is locked for a short while." The admin area shows the lock and can clear it. |
| Replay | The accepted TOTP counter is inserted into `ClientTotpUse`; a duplicate insert is the replay | "That code has already been used." |

Every failure message is deliberately vague about which half was wrong. A correct password with a wrong code reads
the same as a wrong password.

### CSRF

Everything that changes state is a Next server action, which in Next 15 checks Origin against Host before the action
body runs, and `SameSite=Lax` stops a cross-site form post carrying the cookie. No custom token.

## Flows

### Creating a client

Name, company and email in the admin area, either from scratch or prefilled from a won quote. Saving creates the
`Client` with no password and no secret, creates an `INVITE` token valid 7 days, and sends the invite email. The
client row and its token are written in one transaction. Nothing about the account works until setup is complete.

### Setup, from the invite link

`/portal/invite/<token>`. The token is looked up by its hash and must be unused, unexpired, and belong to a client
who is not suspended.

1. **Set a password.** Minimum 12 characters, with a strength hint and a confirm field. On success the token is
   marked used, the hash is stored, and a session is created with `mfaAt` null.
2. **Set up the authenticator.** Not skippable and not dismissible. QR code, the secret in text, and a box for the
   first code. A correct code stores the encrypted secret, sets `totpConfirmedAt`, and generates the recovery codes.
3. **Save the recovery codes.** Shown once, with copy and download, behind an "I have saved these" confirmation.
   Confirming sets `mfaAt`, which is the moment the client is actually signed in, and lands them on `/portal`.

Leaving halfway means the password is set but no usable session exists, so the next sign-in returns them to step 2.

### Signing in

`/portal/sign-in`, email and password.

| Case | Result |
| --- | --- |
| Wrong, locked, suspended or unknown | One vague message, after the rate limit has already been checked |
| Correct, `totpConfirmedAt` set | A session with `mfaAt` null, then `/portal/sign-in/code` for a 6 digit or recovery code. Passing sets `mfaAt`, resets `failedSignIns`, sets `lastSignInAt`, and clears that client's expired sessions |
| Correct, `totpConfirmedAt` null | The same half-session, sent to `/portal/setup` instead |

### Forgot password

`/portal/forgot` always says the same thing, whether or not the address exists, so it cannot enumerate clients. If
the client exists and is not suspended, a `PASSWORD_RESET` token valid 1 hour is created and emailed, and any earlier
outstanding reset token for that client is invalidated.

The reset page asks for the new password **and** a TOTP or recovery code, so a compromised mailbox alone cannot take
the account. The one exception is a client with no authenticator yet, where there is no second factor to ask for;
they get through on the token alone, and are then forced through enrolment before the session becomes usable.

Any completed reset deletes every session for that client.

### The client's own account page

`/portal/account`:

- **Change password**, current password required. Every other session is signed out; the current one is kept.
- **Sessions**, with a rough device from the user agent, when it was last used, and the current one marked, plus
  "sign out everywhere else".
- **Recovery codes**: how many remain unused, and regenerate after re-entering the password, which invalidates the
  old set.

### Admin actions on a client

| Action | Effect |
| --- | --- |
| Resend invite | New token, previous invite tokens invalidated |
| Send password reset | The same email the client would request themselves |
| Reset 2FA | Clears the secret, `totpConfirmedAt` and every recovery code, deletes every session, and emails the client |
| Suspend / unsuspend | Sets or clears `suspendedAt`; suspending deletes every session, so access stops on the next request |
| Clear lock | Resets `failedSignIns` and `lockedUntil` |
| Edit name, company, email | The email is the sign-in identity, so changing it notifies both the old and the new address |
| Delete | Confirmation dialog; cascades to sessions, tokens, codes and sites, and leaves quotes in place with `clientId` null |

### Converting a won quote

The quote page gains a **Create client from this quote** button, shown when the status is `WON` and the quote is not
already linked. It opens `/admin/clients/new?fromQuote=<id>` prefilled with the name, company and email, so the
details can be seen and corrected before anything is created. Saving sets `Quote.clientId`. If a client with that
email already exists, the form says so and offers to link the quote to them rather than create a duplicate.

## Routes, modules and pages

### Routes

A new `app/(portal)` route group, alongside `(landing)`, `(quote)` and `(admin)`.

| Route | Contents |
| --- | --- |
| `/portal` | The placeholder home, behind `requireClient()` |
| `/portal/sign-in` | Email and password |
| `/portal/sign-in/code` | Second factor, needs a session with `mfaAt` null |
| `/portal/setup` | Authenticator enrolment and recovery codes, same half-session |
| `/portal/invite/[token]` | Set a password from an invite |
| `/portal/forgot` | Request a reset |
| `/portal/reset/[token]` | New password plus a code |
| `/portal/account` | Password, sessions, recovery codes |

`middleware.ts` currently exports Auth.js's middleware directly. It becomes a small function of our own: `/portal/*`
gets a cookie-presence check and a redirect to sign-in when it is missing, and `/admin/*` is delegated to the Auth.js
middleware exactly as today. Presence only, because Prisma does not run in the edge runtime, so the middleware cannot
know whether a session is valid. That is the same cheap first layer the admin area has, for the same
CVE-2025-29927 reason Part 1 gives; `requireClient()` on every page and action is the layer that decides.

`scripts/wallpaper.mjs` gains `join('app', '(portal)')` in its `SERVER_SIDE` list, so the static export keeps
building. `robots.ts` gains a disallow for `/portal`, and the portal layout sets `noindex`.

### Server modules

Under `server/clients/`, each importing `server-only` except `schema.ts`, and each taking its dependencies as
parameters in the style of `server/quotes/`.

| Module | Purpose |
| --- | --- |
| `ids.ts` | Crockford base32 generation for client ids and recovery codes |
| `password.ts` | scrypt hash, verify, rehash-on-verify, the length policy |
| `totp.ts` | base32, HOTP, TOTP verify with a window, the `otpauth://` URI |
| `secrets.ts` | AES-256-GCM for the TOTP secret, keyed HMAC for recovery codes |
| `session.ts` | Token generation and hashing, cookie name and attributes, lifetime arithmetic |
| `limits.ts` | The per-IP window and the per-account backoff, as pure functions over counts and timestamps |
| `schema.ts` | Zod schemas shared with the browser forms; no `server-only`, as `quotes/schema.ts` already is |
| `repo.ts` | Every query, taking the Prisma client as a parameter |
| `signIn.ts` | The sign-in and second-factor pipeline |
| `setup.ts` | Invite completion and enrolment |
| `reset.ts` | Forgot and reset |
| `account.ts` | Change password, sessions, regenerate codes |
| `emails.ts` | The client emails |
| `auth.ts` | `currentClient()` and `requireClient()` |
| `wiring.ts` | The only module that reaches for the real database, mailer and clock |

`ids.ts`, `password.ts`, `totp.ts`, `secrets.ts` and `limits.ts` are pure and have no database in sight, which is
what makes the security-critical parts cheap to test hard.

### One targeted refactor of existing code

`server/env.ts`'s `mailConfig()` mixes the SMTP transport with quote-specific addresses, and throws when
`QUOTE_NOTIFY_TO` is missing. Client emails need the transport but not those addresses. It splits into:

- `smtpConfig()`: host, port, credentials, from, site URL
- `quoteMailConfig()`: `smtpConfig()` plus `notifyTo` and `replyTo`
- `clientMailConfig()`: `smtpConfig()` plus `CLIENT_REPLY_TO`

Small, and it stops a missing quote setting from silently blocking a client invite.

### Pages

**The portal home** uses the site's navy with the admin area's dark MUI theme, reused rather than reinvented. It
shows who is signed in, their company if set, their sites from the `Site` table as cards reading "Controls are coming
soon", an empty state when there are none, and links to the account page and sign out. Deliberately plain: another
session is designing the dashboard and this must not prejudge it.

**The admin area** gains `app/(admin)/admin/clients/` with a list, `new/`, `[id]/`, its own `actions.ts`, and a
`controls.tsx` in the same shape as the quote page's. The list shows name, company, email, the derived state chip,
site count and last sign-in. `header.tsx` gains two nav links, Quotes and Clients.

Every admin action calls `requireAdmin()` first and every portal action calls `requireClient()` first, before
validating its input, exactly as Part 1's actions do.

## Emails

All from `MAIL_FROM` through the existing relay, with `Reply-To: CLIENT_REPLY_TO`, plain text plus a simple escaped
HTML version, as `server/quotes/emails.ts` does it.

| Email | When | Contains |
| --- | --- | --- |
| Your Horizons account is ready | Client created, or invite resent | The invite link, that it expires in 7 days, and that an authenticator app will be needed |
| Reset your Horizons password | Client asks, or the admin sends one | The link, that it expires in 1 hour, and what to do if they did not ask |
| Your password was changed | Any completed reset or self-service change | No link, just that it happened |
| Your two-factor setup was reset | The admin resets it | That a new authenticator will be set up at next sign-in |
| Your sign-in address has changed | The admin edits the email | Sent to both the old and the new address |

Part 1's rule about never echoing free text applies differently here, and the code says so in a comment: a client's
name is text the operator typed in the admin area, not text a stranger typed into a public form, so the greeting can
use it safely.

The forgot-password email is sent with Next's `after()`. That is not only about speed: sending inline would make a
request for a real address measurably slower than one for an address that does not exist, which would undo the point
of the identical response. Admin-triggered emails are sent inline, because the operator is present and should be told
when the relay refuses.

Every email about a security change exists so that an admin-side takeover cannot be silent.

## Environment

Two new variables, both riding in on the existing `env_file: .env`. Nothing in `docker-compose.yml` changes, and
migrations already run at container start.

| Variable | Purpose |
| --- | --- |
| `CLIENT_SECRET_KEY` | 32 random bytes, base64, from `openssl rand -base64 32`. Encrypts TOTP secrets and keys the recovery code HMACs. Losing or changing it means every client re-enrols. |
| `CLIENT_REPLY_TO` | `info@dev.horizons.gg`, the address client emails ask them to reply to |

Both are added to `.env.example` with a comment, including the warning that `CLIENT_SECRET_KEY` is not `AUTH_SECRET`
and must not be rotated casually.

## Failure behaviour

| Failure | What happens |
| --- | --- |
| Relay down when a client is created | The client and invite token are saved. The action reports "created, but the invite email did not send", and the client page shows a Resend invite button. |
| Database unreachable | The form says something went wrong and the error is logged. Creating a client and its invite token is one transaction, so nothing partial is written. |
| `CLIENT_SECRET_KEY` missing | Enrolment and second-factor checks refuse with an `EnvError` naming the variable, and the page says to get in touch. There is no fallback to plaintext, ever. |
| `CLIENT_SECRET_KEY` changed or wrong | Decryption fails and is treated as a broken second factor: sign-in is refused and the error is logged. It never degrades into letting them past. |
| A client's clock is out | The one step window covers about 90 seconds. Beyond that the code page says to check the phone's time is set automatically, which is the cause almost every time. |
| Invite or reset link expired, used, or for a suspended client | One message: the link is no longer valid, ask Koda for a new one. It does not distinguish the cases, so it cannot be used to probe which tokens exist. |

## Testing strategy

### Unit tests over the pure modules

- `totp.ts` against the RFC 6238 published test vectors, and base32 against RFC 4648's. Plus the window either side,
  the boundary just outside it, and six-digit zero padding.
- `password.ts`: roundtrip, wrong password, a malformed or truncated stored string refused rather than throwing,
  parameters read back off the hash, and rehash when the stored cost is below current.
- `secrets.ts`: roundtrip, a tampered ciphertext refused (which GCM gives), a wrong key refused, and the key version
  prefix honoured.
- `ids.ts`: the alphabet contains no I, L, O or U; length and prefix; a collision retries.
- `limits.ts`: the per-IP window counts correctly at its edges, the backoff ladder steps 1, 5, 15, 60 and stops,
  a lock expires.
- `schema.ts`: every validation rule, including the 12 character minimum and that no composition rule sneaks in.

### Pipeline tests with stand-ins

For the database, mailer and clock, in the dependency-injected style of `server/quotes/submit.ts`:

- An unknown email and a wrong password are indistinguishable in result, and both perform a hash.
- The rate limit is checked before any hashing happens, which is a test about call ordering, not output.
- Locked and suspended accounts are refused; a correct password yields a session with `mfaAt` null and nothing more.
- A recovery code works once and never again; a replayed TOTP counter is refused.
- **The structural test:** enumerate every path that writes `mfaAt` and assert each is reached only after a verified
  TOTP code, a verified recovery code, or completed enrolment. This is what keeps mandatory 2FA true as the code
  grows, and it is the most valuable test in the set.
- Invite and reset tokens are single use and expire; a reset demands a code when the client has an authenticator and
  does not when they do not; a completed reset deletes every session.
- Reset 2FA clears the secret, the confirmation and every recovery code, and deletes every session. Suspend deletes
  every session. Delete cascades and leaves the quote with a null `clientId`.
- Every admin action calls `requireAdmin()` first, and every portal action calls `requireClient()` first.

### Database tests

Against real Postgres when `TEST_DATABASE_URL` is set, skipped otherwise, as Part 1 does: the migration applies, the
email unique constraint holds, the cascades behave, the `ClientTotpUse` composite key is what refuses a replay, and
`Quote.clientId` goes null rather than deleting the quote.

### Builds

`npm run build`, `npm run wallpaper`, `npm run lint` and `npx tsc --noEmit`.

### In the browser

With `docker-compose.dev.yml` and Mailpit: the whole invite flow end to end against a real authenticator app, a
deliberately wrong code, lockout and recovery, forgot password, suspending a client while they have a tab open and
watching the next click bounce them, and converting a won quote.

## Known risks and accepted weaknesses

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| The admin account can take over a client, via reset 2FA plus a password reset | Deliberate: it is the lockout escape hatch. The client is emailed whenever either happens, so it cannot be done silently. |
| We own the session and cookie code rather than a library | Auth.js would not have done this job in this configuration anyway. The surface is one cookie, one table and about two hundred lines, all tested. |
| scrypt at 134 MB a hash is a memory lever | The per-IP limit is checked before any hash runs, and there are a handful of clients. The stored parameters mean the cost can be dropped without invalidating a single password. |
| Middleware only checks that a cookie exists | The same two-layer design the admin area already uses, for the same reason. `requireClient()` is what decides. |
| Losing `CLIENT_SECRET_KEY` means every client re-enrols their authenticator | Noted in `.env.example` and the README, next to a reminder that it is not `AUTH_SECRET`. |
| `Site.projectId` can drift from hostd's registry | Drift is visible rather than silent: a project id the registry does not know shows as unavailable. hostd stays the source of truth. |
| TOTP uses SHA-1 | RFC 6238's default and what authenticator apps implement. The collision work against SHA-1 does not apply to HMAC-SHA1. |
| No passkeys | TOTP works for every client on any phone. A later addition, not a Part 2 blocker. |
| One login per client | Chosen deliberately. The credential modules take a record rather than fetch one, so the split is a migration plus a repo change, and hostd's two headers already anticipate it. |

## Later parts

The portal screens that show and control client sites, once hostd's phases land. They join the `hostd` network and
call its API with `X-Hostd-Actor: client:<id>` and `X-Hostd-User: <id>`, both of which this part now produces.
