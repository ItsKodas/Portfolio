# Client Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the portfolio site client accounts: an emailed invite, a password, a mandatory authenticator app, revocable database-backed sessions, an admin area to manage clients, and a placeholder client landing page.

**Architecture:** Client authentication is ours, not Auth.js. Auth.js keeps handling the admin's Google sign-in unchanged, with no shared config, callback or cookie. Client sign-in is an opaque cookie token over a `ClientSession` row, and a session is only usable once `mfaAt` is set, which only a verified TOTP code, a verified recovery code or completed enrolment can do. Security-critical logic lives in small pure modules under `server/clients/` with no database in sight, so it can be tested hard; one `wiring.ts` connects them to the real database, relay and clock.

**Tech Stack:** Next.js 15 App Router, React 18, MUI 6, Prisma 7 with Postgres, Zod 4, Vitest 3, nodemailer, Node 24 built-in `crypto` (scrypt, AES-256-GCM, HMAC), and `qrcode`.

**Spec:** `docs/superpowers/specs/2026-09-20-client-accounts-design.md`

## Global Constraints

- **No em dashes (U+2014) in any non-comment text.** UI copy, docs, commit messages, PR descriptions. Comments in code are the only exception. See `CLAUDE.md`.
- **Code style:** 4-space indentation, no semicolons, single quotes, comments that say *why*.
- **Commit messages** end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never touch** `hostd/`, `mail/`, anything affecting `koda@horizons.gg` or the `horizons.gg` apex mail records.
- **Never commit `.env`.** Never ask the user to paste a secret into chat.
- **Auth.js config is off limits.** `server/auth/config.ts`, `server/auth/allow.ts` and `server/auth/index.ts` must not change. The admin's Google sign-in must keep working exactly as it does.
- **Every server module** under `server/` imports `server-only` as its first import, except `server/clients/schema.ts`, which the browser forms import.
- **Every admin server action** calls `requireAdmin()` first. **Every portal server action** calls `requireClient()` first (or, for the pre-auth ones, validates its own token first).
- **Password minimum is 12 characters with no composition rules.** Do not add a rule demanding digits, symbols or mixed case.
- **hostd formats, copied verbatim** from `hostd/src/shared/formats.ts`: client ids must satisfy `/^[A-Za-z0-9_-]{1,64}$/`; project ids must satisfy `/^[a-z0-9][a-z0-9-]{1,30}$/`; the reserved project ids are `hostd`, `mail` and `horizons`.
- **Run `npx prisma generate` after any schema change**, or the types will not exist.
- Tests run with `npm test`. A single file: `npx vitest run server/clients/totp.test.ts`.

---

## File Structure

**Created, pure (no database, no network, no `next/*`):**

| File | Responsibility |
| --- | --- |
| `server/clients/ids.ts` | Crockford base32 generation, client ids, recovery code format |
| `server/clients/password.ts` | scrypt hashing, verification, rehash policy, length policy |
| `server/clients/secrets.ts` | AES-256-GCM for TOTP secrets, keyed HMAC for recovery codes |
| `server/clients/totp.ts` | base32, HOTP, TOTP with a window, the `otpauth://` URI |
| `server/clients/limits.ts` | Per-IP window and per-account backoff arithmetic |
| `server/clients/session.ts` | Token generation and hashing, cookie name, lifetime arithmetic |
| `server/clients/schema.ts` | Zod schemas shared with the browser forms (no `server-only`) |

**Created, impure but injected (dependencies passed in, tested with stand-ins):**

| File | Responsibility |
| --- | --- |
| `server/clients/signIn.ts` | Password step and second-factor step |
| `server/clients/setup.ts` | Invite completion and authenticator enrolment |
| `server/clients/reset.ts` | Forgot-password request and reset completion |
| `server/clients/account.ts` | Change password, list and revoke sessions, regenerate codes |
| `server/clients/emails.ts` | The five client emails |

**Created, wiring and access:**

| File | Responsibility |
| --- | --- |
| `server/clients/repo.ts` | Every Prisma query, taking the client as a parameter |
| `server/clients/auth.ts` | `currentClient()` and `requireClient()` |
| `server/clients/wiring.ts` | The only module that reaches for the real database, mailer, clock and cookies |

**Created, pages:** `app/(portal)/` with `layout.tsx`, `theme.tsx`, `portal/page.tsx`, `portal/sign-in/`, `portal/sign-in/code/`, `portal/setup/`, `portal/invite/[token]/`, `portal/forgot/`, `portal/reset/[token]/`, `portal/account/`, plus `app/(admin)/admin/clients/` with `page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `actions.ts` and `controls.tsx`.

**Modified:** `prisma/schema.prisma`, `server/env.ts`, `middleware.ts`, `scripts/wallpaper.mjs`, `app/robots.ts`, `app/(admin)/admin/header.tsx`, `app/(admin)/admin/quotes/[id]/page.tsx`, `app/(admin)/admin/quotes/[id]/controls.tsx`, `.env.example`, `README.md`, `package.json`.

---

### Task 1: Data model and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `package.json` (add `qrcode`, `@types/qrcode`)
- Create: `prisma/migrations/<timestamp>_client_accounts/migration.sql` (generated, never hand-written)
- Test: `server/clients/model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the Prisma models `Client`, `Site`, `ClientSession`, `ClientToken`, `ClientRecoveryCode`, `ClientTotpUse`, `ClientAuthAttempt`, the enum `ClientTokenPurpose`, and `Quote.clientId`. Later tasks import these types from `server/generated/prisma/client`.

- [ ] **Step 1: Start the local services**

```bash
npm run services
```

Brings up Postgres on `127.0.0.1:5433` and Mailpit. Confirm `.env` has `DATABASE_URL` and `TEST_DATABASE_URL` as `.env.example` shows.

- [ ] **Step 2: Write the failing database test**

Create `server/clients/model.test.ts`. It runs against real Postgres and is skipped when `TEST_DATABASE_URL` is unset, exactly like `server/quotes/repo.test.ts`.

```ts
// Runs against a real Postgres: the horizons_test database from docker-compose.dev.yml, named by TEST_DATABASE_URL.
// Skipped when that isn't set, so npm test still works without Docker.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'

const url = process.env.TEST_DATABASE_URL

const TABLES = '"Client", "Site", "ClientSession", "ClientToken", "ClientRecoveryCode", "ClientTotpUse", "ClientAuthAttempt", "Quote", "Note"'

describe.skipIf(!url)('client models', () => {
    let db: PrismaClient

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    const client = (id = 'cl_ABCDEFGH') =>
        db.client.create({ data: { id, name: 'Ann', email: `${id}@example.com` } })

    it('creates a client with nothing set up yet', async () => {
        const created = await client()
        expect(created.passwordHash).toBeNull()
        expect(created.totpSecret).toBeNull()
        expect(created.totpConfirmedAt).toBeNull()
        expect(created.suspendedAt).toBeNull()
        expect(created.failedSignIns).toBe(0)
    })

    it('refuses two clients with the same email', async () => {
        await client('cl_AAAAAAAA')
        await expect(db.client.create({ data: { id: 'cl_BBBBBBBB', name: 'Bo', email: 'cl_AAAAAAAA@example.com' } }))
            .rejects.toThrow()
    })

    it('refuses a replayed TOTP step for the same client', async () => {
        await client()
        await db.clientTotpUse.create({ data: { clientId: 'cl_ABCDEFGH', step: 58000000n } })
        await expect(db.clientTotpUse.create({ data: { clientId: 'cl_ABCDEFGH', step: 58000000n } }))
            .rejects.toThrow()
    })

    it('allows the same step for a different client', async () => {
        await client('cl_AAAAAAAA')
        await client('cl_BBBBBBBB')
        await db.clientTotpUse.create({ data: { clientId: 'cl_AAAAAAAA', step: 58000000n } })
        await db.clientTotpUse.create({ data: { clientId: 'cl_BBBBBBBB', step: 58000000n } })
        expect(await db.clientTotpUse.count()).toBe(2)
    })

    it('cascades sessions, tokens, codes and sites when a client is deleted', async () => {
        await client()
        await db.clientSession.create({ data: { clientId: 'cl_ABCDEFGH', tokenHash: 't1', expiresAt: new Date() } })
        await db.clientToken.create({ data: { clientId: 'cl_ABCDEFGH', tokenHash: 'k1', purpose: 'INVITE', expiresAt: new Date() } })
        await db.clientRecoveryCode.create({ data: { clientId: 'cl_ABCDEFGH', codeHash: 'c1' } })
        await db.site.create({ data: { clientId: 'cl_ABCDEFGH', projectId: 'acme-bakery', name: 'Acme Bakery' } })

        await db.client.delete({ where: { id: 'cl_ABCDEFGH' } })

        expect(await db.clientSession.count()).toBe(0)
        expect(await db.clientToken.count()).toBe(0)
        expect(await db.clientRecoveryCode.count()).toBe(0)
        expect(await db.site.count()).toBe(0)
    })

    // Deleting a client must never delete the quote they came from, so the history survives
    it('keeps a quote and nulls its clientId when the client is deleted', async () => {
        await client()
        const quote = await db.quote.create({
            data: { name: 'Ann', email: 'ann@example.com', message: 'Hello there', ipHash: 'h1', clientId: 'cl_ABCDEFGH' },
        })

        await db.client.delete({ where: { id: 'cl_ABCDEFGH' } })

        const after = await db.quote.findUnique({ where: { id: quote.id } })
        expect(after).not.toBeNull()
        expect(after!.clientId).toBeNull()
    })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run server/clients/model.test.ts
```

Expected: FAIL. `db.client` does not exist on the generated Prisma client.

- [ ] **Step 4: Add the models to the schema**

Append to `prisma/schema.prisma`:

```prisma
// The client accounts feature's tables. See docs/superpowers/specs/2026-09-20-client-accounts-design.md.

enum ClientTokenPurpose {
  INVITE
  PASSWORD_RESET
}

model Client {
  // "cl_" + 8 Crockford base32 chars, generated by server/clients/ids.ts. It is the primary key rather than a
  // second column because hostd's registry names clients by it, and two ids would be two things to keep in step.
  id                String    @id
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  name              String
  company           String?
  email             String    @unique
  // Null until the invite is completed. There is deliberately no status column: a status could say ACTIVE while
  // this is null, and that state must not be representable.
  passwordHash      String?
  passwordUpdatedAt DateTime?
  // AES-256-GCM under CLIENT_SECRET_KEY, never plaintext
  totpSecret        String?
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
  // The key in hostd's projects.yaml. hostd is the source of truth; this is a pointer, and a project id the
  // registry doesn't know simply shows as unavailable.
  projectId String   @unique
  name      String
  createdAt DateTime @default(now())
  client    Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId  String

  @@index([clientId])
}

model ClientSession {
  id         String    @id @default(cuid())
  // SHA-256 of the cookie value, so reading this table doesn't let anyone resume a session
  tokenHash  String    @unique
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime  @default(now())
  expiresAt  DateTime
  // Null means the second factor is still outstanding. requireClient() demands this, which is what makes
  // mandatory 2FA a property of the data rather than a check someone can forget.
  mfaAt      DateTime?
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
  // HMAC-SHA256 under CLIENT_SECRET_KEY. A fast hash is sound here because we generate the codes at full
  // entropy, unlike a password someone chose.
  id       String    @id @default(cuid())
  codeHash String
  usedAt   DateTime?
  client   Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
  clientId String

  @@index([clientId])
}

// A TOTP code that has already been accepted. Replay is refused by the composite key rather than by a lookup,
// so there is no window between checking and recording.
model ClientTotpUse {
  clientId String
  step     BigInt
  usedAt   DateTime @default(now())
  client   Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@id([clientId, step])
  @@index([usedAt])
}

// Sign-in attempts per IP. In the database rather than in memory so a restart doesn't reset the window, matching
// the quote rate limit. Written for every failed sign-in, every failed second factor, and every reset request
// whether or not it matched a client, because a reset that finds nothing is not a failure the person can see.
model ClientAuthAttempt {
  id        String   @id @default(cuid())
  ipHash    String
  createdAt DateTime @default(now())

  @@index([ipHash, createdAt])
}
```

Add to the existing `Quote` model, just before its `@@index` lines:

```prisma
  // SetNull, not Cascade: deleting a client must never delete the quote they came from
  client         Client?      @relation(fields: [clientId], references: [id], onDelete: SetNull)
  clientId       String?
```

And one more index line alongside the existing ones:

```prisma
  @@index([clientId])
```

- [ ] **Step 5: Generate the migration and the client**

```bash
npx prisma migrate dev --name client_accounts
```

Read the generated SQL before moving on. It must create seven tables and add one nullable column with a `SET NULL` foreign key on `Quote`. It must not drop or rewrite `Quote` or `Note`. If it proposes to, stop and work out why rather than accepting it.

- [ ] **Step 6: Run the test and watch it pass**

```bash
npx vitest run server/clients/model.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Add the QR code dependency**

```bash
npm install qrcode@1.5.4
```

```bash
npm install --save-dev @types/qrcode@1.5.5
```

Pure JavaScript, so it needs no build toolchain in the Alpine image.

- [ ] **Step 8: Check nothing else broke**

```bash
npm test && npx tsc --noEmit
```

Expected: every existing quote test still passes.

- [ ] **Step 9: Commit**

```bash
git add prisma server/clients/model.test.ts package.json package-lock.json
git commit -F - <<'MSG'
Add the client account tables

A client is one row holding its own credentials, because Part 2 is one
login per client. The credential fields sit behind their own modules
rather than being read directly, so separating an organisation from the
people who sign in later is a migration rather than a rewrite.

There is no status column on purpose. State is derived from the fields,
so a row cannot claim to be active while it has no password hash.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Crockford base32 ids and recovery codes

**Files:**
- Create: `server/clients/ids.ts`
- Test: `server/clients/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ALPHABET: string`
  - `randomBase32(length: number, random?: (bytes: number) => Buffer): string`
  - `newClientId(random?: (bytes: number) => Buffer): string`
  - `CLIENT_ID_PATTERN: RegExp`
  - `newRecoveryCode(random?: (bytes: number) => Buffer): string`
  - `normaliseRecoveryCode(input: string): string`

- [ ] **Step 1: Write the failing test**

Create `server/clients/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { ALPHABET, CLIENT_ID_PATTERN, newClientId, newRecoveryCode, normaliseRecoveryCode, randomBase32 } from './ids'

// A stand-in for randomBytes that returns the bytes we name, so the output is predictable
const bytes = (...values: number[]) => () => Buffer.from(values)

describe('ALPHABET', () => {
    it('is Crockford base32, so an id cannot spell a word or be misread', () => {
        expect(ALPHABET).toHaveLength(32)
        for (const letter of ['I', 'L', 'O', 'U']) expect(ALPHABET).not.toContain(letter)
        expect(new Set(ALPHABET).size).toBe(32)
    })
})

describe('randomBase32', () => {
    it('maps the low five bits of each byte to a character', () => {
        // 0 -> "0", 1 -> "1", 31 -> "Z", and 32 wraps back to "0" because only five bits are used
        expect(randomBase32(4, bytes(0, 1, 31, 32))).toBe('01Z0')
    })

    it('asks for exactly one byte per character', () => {
        let asked = 0
        randomBase32(7, size => { asked = size; return Buffer.alloc(size) })
        expect(asked).toBe(7)
    })

    it('produces only alphabet characters', () => {
        const out = randomBase32(64)
        expect(out).toHaveLength(64)
        for (const character of out) expect(ALPHABET).toContain(character)
    })
})

describe('newClientId', () => {
    it('is cl_ plus eight characters', () => {
        expect(newClientId(bytes(0, 1, 2, 3, 4, 5, 6, 7))).toBe('cl_01234567')
    })

    it('matches its own pattern, and hostd would accept it', () => {
        const id = newClientId()
        expect(CLIENT_ID_PATTERN.test(id)).toBe(true)
        // hostd/src/shared/formats.ts, copied verbatim
        expect(/^[A-Za-z0-9_-]{1,64}$/.test(id)).toBe(true)
    })

    it('does not repeat itself', () => {
        const ids = new Set(Array.from({ length: 500 }, () => newClientId()))
        expect(ids.size).toBe(500)
    })
})

describe('newRecoveryCode', () => {
    it('is two groups of five, hyphenated', () => {
        expect(newRecoveryCode(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9))).toBe('01234-56789')
    })
})

describe('normaliseRecoveryCode', () => {
    it('accepts what someone actually types', () => {
        expect(normaliseRecoveryCode('  abcde-fghjk ')).toBe('ABCDEFGHJK')
    })

    it('folds the Crockford lookalikes, so O reads as zero and I and L read as one', () => {
        expect(normaliseRecoveryCode('O0I1L')).toBe('00111')
    })

    it('drops anything that is not part of a code', () => {
        expect(normaliseRecoveryCode('ab-cd ef.gh')).toBe('ABCDEFGH')
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/ids.test.ts
```

Expected: FAIL, cannot resolve `./ids`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/ids.ts`:

```ts
// Identifiers a person has to read, type or copy. Deliberately not cuid: a client id is typed by hand into
// hostd's projects.yaml, so it has to survive being read off a screen.

import { randomBytes } from 'node:crypto'

type Random = (bytes: number) => Buffer

// Crockford's base32: no I, L, O or U, so an id can't spell a word and can't be confused with 1 or 0
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// One byte per character, using its low five bits. Uniform without rejection sampling because 32 divides 256
// exactly, so every character is equally likely.
export function randomBase32(length: number, random: Random = randomBytes): string {
    const source = random(length)
    let out = ''
    for (let index = 0; index < length; index += 1) out += ALPHABET[source[index] & 31]
    return out
}

export const CLIENT_ID_PATTERN = /^cl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/

// 40 bits. Collisions are handled by the unique primary key and a retry in the repo, not by length alone.
export const newClientId = (random: Random = randomBytes) => `cl_${randomBase32(8, random)}`

// Two groups of five, about 50 bits, which is far past guessing and still readable off a printout. One draw of
// ten bytes rather than two of five, so a stand-in in the tests only has to supply one buffer.
export function newRecoveryCode(random: Random = randomBytes): string {
    const source = random(10)
    let characters = ''
    for (let index = 0; index < 10; index += 1) characters += ALPHABET[source[index] & 31]
    return `${characters.slice(0, 5)}-${characters.slice(5)}`
}

// What someone types is not what we stored: they may lower-case it, drop the hyphen, or hit O for zero and I or
// L for one. Crockford defines exactly those aliases, so fold them before comparing.
export const normaliseRecoveryCode = (input: string) => input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/ids.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/clients/ids.ts server/clients/ids.test.ts
git commit -F - <<'MSG'
Generate client ids and recovery codes in Crockford base32

A client id is typed by hand into hostd's registry and a recovery code
is read off a printout, so both drop I, L, O and U and both fold those
lookalikes back on the way in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Password hashing with scrypt

**Files:**
- Create: `server/clients/password.ts`
- Test: `server/clients/password.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COST: { logN: 17, r: 8, p: 1 }`, `type Cost = { logN: number, r: number, p: number }`
  - `hashPassword(password: string, cost?: Cost): Promise<string>`
  - `verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>`
  - `parseStoredPassword(stored: string): { cost: Cost, salt: Buffer, hash: Buffer } | null`
  - `burnPasswordTime(cost?: Cost): Promise<void>`

This module does hashing and nothing else. The **length policy lives in `server/clients/schema.ts`** (Task 7), because the browser forms need it and this module imports `server-only`.

- [ ] **Step 1: Write the failing test**

Create `server/clients/password.test.ts`. Note the cheap cost used throughout: real parameters take about a second per hash, which would make the suite unpleasant. One test does use the real cost, because that is the only way to prove `maxmem` is set high enough.

```ts
import { describe, expect, it } from 'vitest'

import { COST, burnPasswordTime, hashPassword, parseStoredPassword, verifyPassword } from './password'

// Deliberately far below COST so the suite stays fast. verifyPassword reads the cost off the hash, so this
// exercises exactly the same code path.
const CHEAP = { logN: 4, r: 8, p: 1 }

describe('hashPassword', () => {
    it('writes the parameters and the salt into the stored value', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(stored.startsWith('scrypt$4$8$1$')).toBe(true)
        expect(stored.split('$')).toHaveLength(6)
    })

    it('salts, so the same password hashes differently every time', async () => {
        const [one, two] = await Promise.all([hashPassword('same password', CHEAP), hashPassword('same password', CHEAP)])
        expect(one).not.toBe(two)
    })
})

describe('verifyPassword', () => {
    it('accepts the right password', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, needsRehash: true })
    })

    it('refuses the wrong password', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect((await verifyPassword('incorrect horse battery', stored)).ok).toBe(false)
    })

    it('asks for a rehash only when the stored cost is below the current one', async () => {
        const cheap = await hashPassword('correct horse battery', CHEAP)
        expect((await verifyPassword('correct horse battery', cheap)).needsRehash).toBe(true)
    })

    // A stored value can be truncated by a bad migration or hand-edited. The sign-in path must answer
    // "doesn't match" rather than throw, which would turn a data problem into a 500 on every attempt.
    it.each([
        ['empty', ''],
        ['not ours', 'argon2id$v=19$m=65536,t=3,p=4$abc$def'],
        ['truncated', 'scrypt$4$8$1$YWJj'],
        ['bad cost', 'scrypt$x$8$1$YWJj$ZGVm'],
        ['absurd cost', 'scrypt$40$8$1$YWJj$ZGVm'],
        ['short salt', 'scrypt$4$8$1$YQ==$ZGVm'],
    ])('refuses a %s stored value without throwing', async (unused, stored) => {
        expect(await verifyPassword('anything', stored)).toEqual({ ok: false, needsRehash: false })
    })
})

describe('parseStoredPassword', () => {
    it('reads the cost back off the hash', async () => {
        const stored = await hashPassword('correct horse battery', CHEAP)
        expect(parseStoredPassword(stored)?.cost).toEqual(CHEAP)
    })
})

describe('the real cost', () => {
    // scrypt at these parameters needs about 134 MB, far above Node's 32 MB default for maxmem. Without an
    // explicit maxmem this throws, and it would throw in production rather than in a test.
    it('hashes and verifies at COST without exceeding maxmem', async () => {
        const stored = await hashPassword('correct horse battery', COST)
        expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, needsRehash: false })
    }, 20_000)

    it('burns comparable time when no account matched', async () => {
        await expect(burnPasswordTime(CHEAP)).resolves.toBeUndefined()
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/password.test.ts
```

Expected: FAIL, cannot resolve `./password`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/password.ts`:

```ts
// Password hashing. scrypt rather than argon2 because it ships with Node: argon2 is a native module, the image
// is node:24-alpine, and a security-critical path is the worst place to take on a build toolchain.

import 'server-only'

import { randomBytes, scrypt as scryptWithCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

type ScryptOptions = { N: number, r: number, p: number, maxmem: number }
const scrypt = promisify(scryptWithCallback) as (password: string, salt: Buffer, length: number, options: ScryptOptions) => Promise<Buffer>

export type Cost = { logN: number, r: number, p: number }

// OWASP's first scrypt option. Stored with every hash, so raising or lowering it later doesn't invalidate a
// single password: verify reads the cost off the value it is checking.
export const COST: Cost = { logN: 17, r: 8, p: 1 }

const KEY_LENGTH = 32
const SALT_LENGTH = 16

// scrypt allocates about 128 * N * r bytes, which at COST is roughly 134 MB. Node's default maxmem is 32 MB,
// so without raising it the call throws.
const maxmem = ({ logN, r }: Cost) => 256 * (2 ** logN) * r

// NFKC first, so a password typed with a different Unicode composition still matches the one that was stored
const derive = (password: string, salt: Buffer, cost: Cost) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: 2 ** cost.logN, r: cost.r, p: cost.p, maxmem: maxmem(cost) })

export async function hashPassword(password: string, cost: Cost = COST): Promise<string> {
    const salt = randomBytes(SALT_LENGTH)
    const hash = await derive(password, salt, cost)
    return `scrypt$${cost.logN}$${cost.r}$${cost.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export type ParsedPassword = { cost: Cost, salt: Buffer, hash: Buffer }

// Defensive on purpose. Anything unparseable answers "doesn't match" rather than throwing, because a data
// problem must not become a 500 on every sign-in attempt.
export function parseStoredPassword(stored: string): ParsedPassword | null {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null
    const [logN, r, p] = [parts[1], parts[2], parts[3]].map(Number)
    if (![logN, r, p].every(value => Number.isInteger(value) && value > 0)) return null
    // An absurd cost would be a denial of service against ourselves, so refuse it rather than run it
    if (logN > 20 || r > 32 || p > 16) return null
    const salt = Buffer.from(parts[4], 'base64')
    const hash = Buffer.from(parts[5], 'base64')
    if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) return null
    return { cost: { logN, r, p }, salt, hash }
}

export type VerifyResult = { ok: boolean, needsRehash: boolean }

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
    const parsed = parseStoredPassword(stored)
    if (!parsed) return { ok: false, needsRehash: false }
    const candidate = await derive(password, parsed.salt, parsed.cost)
    // Both buffers are KEY_LENGTH, so timingSafeEqual never throws on a length mismatch
    const ok = timingSafeEqual(candidate, parsed.hash)
    return { ok, needsRehash: ok && parsed.cost.logN < COST.logN }
}

// Burns the same work as a real verification when no account matched, so a missing email and a wrong password
// take the same time and the form can't be used to discover who the clients are.
export async function burnPasswordTime(cost: Cost = COST): Promise<void> {
    await derive('a password that matches nothing', Buffer.alloc(SALT_LENGTH), cost)
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/password.test.ts
```

Expected: PASS, 12 tests. The real-cost test takes a second or two; that is the point of it.

- [ ] **Step 5: Commit**

```bash
git add server/clients/password.ts server/clients/password.test.ts
git commit -F - <<'MSG'
Hash client passwords with scrypt

scrypt ships with Node, so a security-critical path takes on no native
build in an Alpine image. The parameters are stored with each hash, so
the cost can be raised or dropped later without invalidating a password.

A test runs at the real cost, because Node's default maxmem is far below
what these parameters need and getting that wrong fails in production
rather than in a cheap test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Secrets at rest, and the key that protects them

**Files:**
- Create: `server/clients/secrets.ts`
- Modify: `server/env.ts` (add `clientSecretKey`)
- Test: `server/clients/secrets.test.ts`, `server/env.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `encryptSecret(plaintext: string, key: Buffer): string`
  - `decryptSecret(stored: string, key: Buffer): string` (throws `SecretError`)
  - `hashRecoveryCode(normalisedCode: string, key: Buffer): string`
  - `recoveryCodeMatches(normalisedCode: string, storedHash: string, key: Buffer): boolean`
  - `class SecretError extends Error`
  - From `server/env.ts`: `clientSecretKey(env?: Env): Buffer`

- [ ] **Step 1: Write the failing test**

Create `server/clients/secrets.test.ts`:

```ts
import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { SecretError, decryptSecret, encryptSecret, hashRecoveryCode, recoveryCodeMatches } from './secrets'

const key = randomBytes(32)
const otherKey = randomBytes(32)

describe('encryptSecret and decryptSecret', () => {
    it('round-trips', () => {
        const stored = encryptSecret('JBSWY3DPEHPK3PXP', key)
        expect(decryptSecret(stored, key)).toBe('JBSWY3DPEHPK3PXP')
    })

    it('never contains the plaintext', () => {
        expect(encryptSecret('JBSWY3DPEHPK3PXP', key)).not.toContain('JBSWY3DPEHPK3PXP')
    })

    it('uses a fresh nonce, so the same secret stores differently each time', () => {
        expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key))
    })

    it('carries a version, so the key can be rotated later', () => {
        expect(encryptSecret('same', key).startsWith('v1$')).toBe(true)
    })

    it('refuses a value encrypted under a different key', () => {
        const stored = encryptSecret('JBSWY3DPEHPK3PXP', otherKey)
        expect(() => decryptSecret(stored, key)).toThrow(SecretError)
    })

    // GCM authenticates as well as encrypts, so a changed byte is detected rather than decrypting to rubbish
    it('refuses a tampered value', () => {
        const parts = encryptSecret('JBSWY3DPEHPK3PXP', key).split('$')
        const body = Buffer.from(parts[3], 'base64')
        body[0] ^= 0xff
        parts[3] = body.toString('base64')
        expect(() => decryptSecret(parts.join('$'), key)).toThrow(SecretError)
    })

    it.each(['', 'nonsense', 'v2$a$b$c', 'v1$a$b'])('refuses the malformed value %j', stored => {
        expect(() => decryptSecret(stored, key)).toThrow(SecretError)
    })

    it('refuses a key that is not 32 bytes', () => {
        expect(() => encryptSecret('x', randomBytes(16))).toThrow(SecretError)
    })
})

describe('recovery code hashing', () => {
    it('matches the code it was made from', () => {
        const stored = hashRecoveryCode('ABCDE12345', key)
        expect(recoveryCodeMatches('ABCDE12345', stored, key)).toBe(true)
    })

    it('does not match another code', () => {
        expect(recoveryCodeMatches('ZZZZZ99999', hashRecoveryCode('ABCDE12345', key), key)).toBe(false)
    })

    // Keyed, so a leaked database dump on its own doesn't let anyone check guesses offline
    it('does not match under a different key', () => {
        expect(recoveryCodeMatches('ABCDE12345', hashRecoveryCode('ABCDE12345', otherKey), key)).toBe(false)
    })

    it('does not throw on a stored value of the wrong shape', () => {
        expect(recoveryCodeMatches('ABCDE12345', 'not hex', key)).toBe(false)
    })
})
```

Add to the existing `server/env.test.ts`:

```ts
describe('clientSecretKey', () => {
    it('decodes 32 base64 bytes', () => {
        const key = Buffer.alloc(32, 7).toString('base64')
        expect(clientSecretKey({ CLIENT_SECRET_KEY: key })).toEqual(Buffer.alloc(32, 7))
    })

    it('names the variable when it is missing', () => {
        expect(() => clientSecretKey({})).toThrow(/CLIENT_SECRET_KEY/)
    })

    it('refuses a key of the wrong length, rather than padding it', () => {
        expect(() => clientSecretKey({ CLIENT_SECRET_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/)
    })
})
```

Import `clientSecretKey` at the top of that file alongside the existing imports.

- [ ] **Step 2: Run both and watch them fail**

```bash
npx vitest run server/clients/secrets.test.ts server/env.test.ts
```

Expected: FAIL, cannot resolve `./secrets`, and `clientSecretKey` is not exported.

- [ ] **Step 3: Write `server/clients/secrets.ts`**

```ts
// TOTP secrets and recovery codes at rest. The nightly pg_dump sits on the same disk as the database, so a dump
// that leaks must not hand anyone working second factors.

import 'server-only'

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Prefixed to every ciphertext, so a future key rotation can tell which key made which value
const VERSION = 'v1'
const IV_LENGTH = 12
export const KEY_LENGTH = 32

export class SecretError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SecretError'
    }
}

const checkKey = (key: Buffer) => {
    if (key.length !== KEY_LENGTH) throw new SecretError('The client secret key must be 32 bytes')
}

export function encryptSecret(plaintext: string, key: Buffer): string {
    checkKey(key)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('$')
}

// Throws rather than returning null on purpose. A secret that won't decrypt means the key is wrong or the row
// was tampered with, and sign-in must refuse rather than quietly treat the client as having no second factor.
export function decryptSecret(stored: string, key: Buffer): string {
    checkKey(key)
    const parts = stored.split('$')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretError('Unrecognised secret format')
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'))
        decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8')
    } catch {
        // GCM's tag check lands here when the key is wrong or a byte changed
        throw new SecretError('The stored secret could not be read')
    }
}

// Keyed rather than plain SHA-256, so a database dump alone doesn't let anyone check guesses offline. A fast
// hash is sound here, unlike for a password, because we generate these codes at full entropy.
export const hashRecoveryCode = (normalisedCode: string, key: Buffer) =>
    createHmac('sha256', key).update(normalisedCode).digest('hex')

export function recoveryCodeMatches(normalisedCode: string, storedHash: string, key: Buffer): boolean {
    const candidate = Buffer.from(hashRecoveryCode(normalisedCode, key), 'hex')
    const stored = Buffer.from(storedHash, 'hex')
    if (candidate.length !== stored.length) return false
    return timingSafeEqual(candidate, stored)
}
```

- [ ] **Step 4: Add `clientSecretKey` to `server/env.ts`**

Append, beside the existing `turnstileSecret` and `ipHashKey`:

```ts
// Encrypts TOTP secrets and keys the recovery code HMACs. Deliberately not AUTH_SECRET: rotating that today
// only resets rate-limit windows, and it must not also brick every client's authenticator.
export function clientSecretKey(env: Env = process.env): Buffer {
    const value = single(env, 'CLIENT_SECRET_KEY')
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32) throw new EnvError(['CLIENT_SECRET_KEY must be 32 bytes, base64 encoded, from: openssl rand -base64 32'])
    return key
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx vitest run server/clients/secrets.test.ts server/env.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/clients/secrets.ts server/clients/secrets.test.ts server/env.ts server/env.test.ts
git commit -F - <<'MSG'
Encrypt TOTP secrets and key the recovery code hashes

The nightly dump sits on the same disk as the database, so a dump that
leaks must not hand anyone a working second factor. AES-256-GCM under
CLIENT_SECRET_KEY, with a version prefix so the key can be rotated.

A secret that will not decrypt throws rather than returning null, so a
wrong key refuses the sign-in instead of quietly treating the client as
having no second factor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: TOTP, against the published vectors

**Files:**
- Create: `server/clients/totp.ts`
- Test: `server/clients/totp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `base32Encode(data: Buffer): string`, `base32Decode(text: string): Buffer`
  - `hotp(secret: Buffer, counter: bigint, digits?: number): string`
  - `STEP_SECONDS: 30`, `WINDOW: 1`, `stepFor(now: Date): bigint`
  - `verifyTotp(secret: Buffer, code: string, now: Date, window?: number): bigint | null` (returns the matched step, which the caller records against replay)
  - `newTotpSecret(random?: (bytes: number) => Buffer): Buffer`
  - `otpauthUri(options: { secret: Buffer, email: string, issuer?: string }): string`
  - `formatSecretForTyping(secret: Buffer): string`

- [ ] **Step 1: Write the failing test**

Create `server/clients/totp.test.ts`. The vectors are copied from the RFCs, which is the whole reason for writing this rather than taking a dependency.

```ts
import { describe, expect, it } from 'vitest'

import { base32Decode, base32Encode, formatSecretForTyping, hotp, newTotpSecret, otpauthUri, stepFor, verifyTotp } from './totp'

// RFC 4226 and RFC 6238 both use this 20 byte ASCII secret
const SECRET = Buffer.from('12345678901234567890', 'ascii')

describe('base32, against the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
        ['', ''],
        ['f', 'MY======'],
        ['fo', 'MZXQ===='],
        ['foo', 'MZXW6==='],
        ['foob', 'MZXW6YQ='],
        ['fooba', 'MZXW6YTB'],
        ['foobar', 'MZXW6YTBOI======'],
    ]

    it.each(vectors)('encodes %j', (plain, encoded) => {
        expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded)
    })

    it.each(vectors)('decodes back to %j', (plain, encoded) => {
        expect(base32Decode(encoded).toString('ascii')).toBe(plain)
    })

    it('decodes what a person types: lower case, spaces, no padding', () => {
        expect(base32Decode('mzxw 6ytb').toString('ascii')).toBe('fooba')
    })

    it('refuses a character that is not base32', () => {
        expect(() => base32Decode('MZXW6YT1')).toThrow()
    })
})

describe('hotp, against the RFC 4226 appendix D vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']

    it.each(expected.map((code, counter): [number, string] => [counter, code]))('counter %i is %s', (counter, code) => {
        expect(hotp(SECRET, BigInt(counter))).toBe(code)
    })
})

describe('totp, against the RFC 6238 SHA-1 vectors', () => {
    // The RFC prints eight digit codes; the step is the unix time divided by 30
    const vectors: [number, string][] = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ]

    it.each(vectors)('time %i gives %s', (seconds, code) => {
        expect(hotp(SECRET, BigInt(Math.floor(seconds / 30)), 8)).toBe(code)
    })

    it('derives the same step from a Date', () => {
        expect(stepFor(new Date(59_000))).toBe(1n)
    })
})

describe('verifyTotp', () => {
    const at = (seconds: number) => new Date(seconds * 1000)
    const codeFor = (seconds: number) => hotp(SECRET, BigInt(Math.floor(seconds / 30)))

    it('accepts the current code and reports which step matched', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109), at(1111111109))).toBe(37037036n)
    })

    it('accepts one step late, for a phone whose clock is behind', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 - 30), at(1111111109))).toBe(37037035n)
    })

    it('accepts one step early', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 + 30), at(1111111109))).toBe(37037037n)
    })

    it('refuses two steps out, so the window really is about 90 seconds', () => {
        expect(verifyTotp(SECRET, codeFor(1111111109 + 60), at(1111111109))).toBeNull()
    })

    it('ignores spaces, because authenticator apps show codes in two groups', () => {
        const spaced = codeFor(1111111109).replace(/^(\d{3})/, '$1 ')
        expect(verifyTotp(SECRET, spaced, at(1111111109))).toBe(37037036n)
    })

    it.each(['', '12345', '1234567', 'abcdef', '12 34 5'])('refuses %j, which is not a six digit code', code => {
        expect(verifyTotp(SECRET, code, at(1111111109))).toBeNull()
    })
})

describe('newTotpSecret', () => {
    it('is 20 bytes, as the RFC recommends', () => {
        expect(newTotpSecret()).toHaveLength(20)
    })

    it('does not repeat itself', () => {
        const secrets = new Set(Array.from({ length: 200 }, () => newTotpSecret().toString('hex')))
        expect(secrets.size).toBe(200)
    })
})

describe('otpauthUri', () => {
    const uri = otpauthUri({ secret: SECRET, email: 'client@example.com' })

    it('is the standard URI an authenticator app expects', () => {
        expect(uri.startsWith('otpauth://totp/Horizons%3Aclient%40example.com?')).toBe(true)
        expect(uri).toContain('issuer=Horizons')
        expect(uri).toContain('algorithm=SHA1')
        expect(uri).toContain('digits=6')
        expect(uri).toContain('period=30')
    })

    it('carries the secret unpadded, which is what apps accept', () => {
        expect(uri).toContain(`secret=${base32Encode(SECRET).replace(/=+$/, '')}`)
        expect(uri).not.toContain('%3D')
    })
})

describe('formatSecretForTyping', () => {
    it('groups in fours for a phone that will not scan', () => {
        expect(formatSecretForTyping(SECRET)).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/totp.test.ts
```

Expected: FAIL, cannot resolve `./totp`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/totp.ts`:

```ts
// RFC 6238 time-based one-time passwords, written here rather than taken as a dependency because the RFCs
// publish test vectors, so "this matches the standard" is a test result rather than a claim about a package.

import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// RFC 4648 base32, which is what authenticator apps read
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(data: Buffer): string {
    let bits = 0
    let value = 0
    let out = ''
    for (const byte of data) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    // Whatever is left over is padded out to a full character, then to a full eight character group
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
    while (out.length % 8 !== 0) out += '='
    return out
}

export function base32Decode(text: string): Buffer {
    // Tolerant of what a person types: lower case, spaces, and the padding left off
    const clean = text.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '')
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const character of clean) {
        const index = BASE32.indexOf(character)
        if (index < 0) throw new Error(`Not base32: ${character}`)
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(out)
}

// HMAC-SHA1 because that is the RFC default and what authenticator apps implement. The collision work against
// SHA-1 does not apply to HMAC-SHA1.
export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
    const message = Buffer.alloc(8)
    message.writeBigUInt64BE(counter)
    const mac = createHmac('sha1', secret).update(message).digest()
    // RFC 4226 dynamic truncation: the low nibble of the last byte picks where to read four bytes from
    const offset = mac[mac.length - 1] & 0x0f
    const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
    return String(binary % 10 ** digits).padStart(digits, '0')
}

export const STEP_SECONDS = 30
// One step either side, so about 90 seconds of tolerance for a phone whose clock is slightly out
export const WINDOW = 1

export const stepFor = (now: Date) => BigInt(Math.floor(now.getTime() / 1000 / STEP_SECONDS))

// Returns the step that matched rather than a boolean, because the caller records it so the same code cannot
// be used twice inside its own window.
export function verifyTotp(secret: Buffer, code: string, now: Date, window = WINDOW): bigint | null {
    const typed = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(typed)) return null
    const typedBuffer = Buffer.from(typed, 'ascii')
    const current = stepFor(now)
    for (let drift = -window; drift <= window; drift += 1) {
        const step = current + BigInt(drift)
        // Both are six ASCII digits, so the lengths always match and timingSafeEqual never throws
        if (timingSafeEqual(Buffer.from(hotp(secret, step), 'ascii'), typedBuffer)) return step
    }
    return null
}

// 20 bytes, as RFC 4226 recommends for HMAC-SHA1
export const newTotpSecret = (random: (bytes: number) => Buffer = randomBytes) => random(20)

export function otpauthUri(options: { secret: Buffer, email: string, issuer?: string }): string {
    const issuer = options.issuer ?? 'Horizons'
    const label = encodeURIComponent(`${issuer}:${options.email}`)
    const params = new URLSearchParams({
        // Unpadded: some apps refuse a secret with trailing equals signs
        secret: base32Encode(options.secret).replace(/=+$/, ''),
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: String(STEP_SECONDS),
    })
    return `otpauth://totp/${label}?${params.toString()}`
}

// Shown beside the QR code, for a phone that will not scan
export const formatSecretForTyping = (secret: Buffer) =>
    base32Encode(secret).replace(/=+$/, '').replace(/(.{4})/g, '$1 ').trim()
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/totp.test.ts
```

Expected: PASS. If an RFC vector fails, the bug is in the implementation, not the vector. Check the truncation offset and that the counter is written big-endian.

- [ ] **Step 5: Commit**

```bash
git add server/clients/totp.ts server/clients/totp.test.ts
git commit -F - <<'MSG'
Add TOTP, checked against the published RFC vectors

Written here rather than taken as a dependency: RFC 4226 and RFC 6238
publish test vectors, so matching the standard is something the suite
proves rather than something a package claims.

Verification returns the step that matched rather than a boolean, so the
caller can record it and refuse the same code a second time inside its
own window.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Rate limit and lockout arithmetic

**Files:**
- Create: `server/clients/limits.ts`
- Test: `server/clients/limits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IP_LIMIT: 10`, `IP_WINDOW_MS: number`, `FREE_ATTEMPTS: 2`, `LOCK_LADDER_MS: number[]`
  - `overIpLimit(recentAttempts: number): boolean`
  - `ipWindowStart(now: Date): Date`
  - `isLocked(client: { lockedUntil: Date | null }, now: Date): boolean`
  - `afterFailure(client: { failedSignIns: number }, now: Date): LockUpdate`
  - `afterSuccess(): LockUpdate`
  - `type LockUpdate = { failedSignIns: number, lockedUntil: Date | null }`

- [ ] **Step 1: Write the failing test**

Create `server/clients/limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { FREE_ATTEMPTS, IP_LIMIT, afterFailure, afterSuccess, ipWindowStart, isLocked, overIpLimit } from './limits'

const now = new Date('2026-09-20T10:00:00Z')
const minutesLater = (minutes: number) => new Date(now.getTime() + minutes * 60_000)

describe('overIpLimit', () => {
    it('allows attempts below the limit and refuses at it', () => {
        expect(overIpLimit(IP_LIMIT - 1)).toBe(false)
        expect(overIpLimit(IP_LIMIT)).toBe(true)
    })
})

describe('ipWindowStart', () => {
    it('looks back fifteen minutes', () => {
        expect(ipWindowStart(now)).toEqual(new Date('2026-09-20T09:45:00Z'))
    })
})

describe('isLocked', () => {
    it('is false when nothing is set', () => {
        expect(isLocked({ lockedUntil: null }, now)).toBe(false)
    })

    it('is true while the lock is in the future and false once it passes', () => {
        expect(isLocked({ lockedUntil: minutesLater(1) }, now)).toBe(true)
        expect(isLocked({ lockedUntil: minutesLater(-1) }, now)).toBe(false)
    })
})

describe('afterFailure', () => {
    // A typo is normal, and locking someone out on their second attempt would be hostile
    it('gives two free attempts before any lock', () => {
        expect(afterFailure({ failedSignIns: 0 }, now)).toEqual({ failedSignIns: 1, lockedUntil: null })
        expect(afterFailure({ failedSignIns: 1 }, now)).toEqual({ failedSignIns: 2, lockedUntil: null })
    })

    it('climbs 1, 5, 15 then 60 minutes', () => {
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS }, now).lockedUntil).toEqual(minutesLater(1))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 1 }, now).lockedUntil).toEqual(minutesLater(5))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 2 }, now).lockedUntil).toEqual(minutesLater(15))
        expect(afterFailure({ failedSignIns: FREE_ATTEMPTS + 3 }, now).lockedUntil).toEqual(minutesLater(60))
    })

    it('stops at an hour rather than climbing forever', () => {
        expect(afterFailure({ failedSignIns: 50 }, now).lockedUntil).toEqual(minutesLater(60))
    })
})

describe('afterSuccess', () => {
    it('clears the count and the lock', () => {
        expect(afterSuccess()).toEqual({ failedSignIns: 0, lockedUntil: null })
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/limits.test.ts
```

Expected: FAIL, cannot resolve `./limits`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/limits.ts`:

```ts
// How hard someone may try. Pure arithmetic over counts and timestamps, so the rules are readable in one place
// and testable without a database.

import 'server-only'

// Across sign-in, the second factor and reset requests, per IP
export const IP_LIMIT = 10
export const IP_WINDOW_MS = 15 * 60 * 1000

// A typo is normal, so the first two failures cost nothing. After that the wait climbs and stops at an hour:
// long enough to make grinding pointless, short enough that a real client isn't locked out for the day.
export const FREE_ATTEMPTS = 2
export const LOCK_LADDER_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export const overIpLimit = (recentAttempts: number) => recentAttempts >= IP_LIMIT

export const ipWindowStart = (now: Date) => new Date(now.getTime() - IP_WINDOW_MS)

export const isLocked = (client: { lockedUntil: Date | null }, now: Date) =>
    !!client.lockedUntil && client.lockedUntil.getTime() > now.getTime()

export type LockUpdate = { failedSignIns: number, lockedUntil: Date | null }

export function afterFailure(client: { failedSignIns: number }, now: Date): LockUpdate {
    const failedSignIns = client.failedSignIns + 1
    const rung = failedSignIns - FREE_ATTEMPTS
    if (rung < 1) return { failedSignIns, lockedUntil: null }
    const wait = LOCK_LADDER_MS[Math.min(rung, LOCK_LADDER_MS.length) - 1]
    return { failedSignIns, lockedUntil: new Date(now.getTime() + wait) }
}

export const afterSuccess = (): LockUpdate => ({ failedSignIns: 0, lockedUntil: null })
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/limits.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/clients/limits.ts server/clients/limits.test.ts
git commit -F - <<'MSG'
Add the sign-in rate limit and lockout ladder

Two free attempts before anything locks, because a typo is normal, then
1, 5, 15 and 60 minutes. It stops at an hour: long enough that grinding
is pointless, short enough that a real client is not out for the day.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Shared validation schemas

**Files:**
- Create: `server/clients/schema.ts`
- Test: `server/clients/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MIN_PASSWORD_LENGTH: 12`, `MAX_PASSWORD_LENGTH: 200`
  - `passwordSchema`, `emailSchema`, `codeSchema`
  - `clientDetailsSchema` and `type ClientDetails = { name: string, company: string | null, email: string }`
  - `siteSchema` and `type SiteInput = { projectId: string, name: string }`
  - `RESERVED_PROJECT_IDS: readonly string[]`

**This is the one module in `server/` with no `server-only` import**, because the browser forms import it for instant feedback, exactly as `server/quotes/schema.ts` already does. Do not import anything from `password.ts`, `secrets.ts` or `repo.ts` here: they are server-only and would poison the browser bundle.

- [ ] **Step 1: Write the failing test**

Create `server/clients/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { MIN_PASSWORD_LENGTH, clientDetailsSchema, codeSchema, emailSchema, passwordSchema, siteSchema } from './schema'

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success

describe('passwordSchema', () => {
    it('demands twelve characters', () => {
        expect(ok(passwordSchema, 'a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true)
        expect(ok(passwordSchema, 'a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false)
    })

    // No composition rules. A long all lower-case passphrase is exactly what current NIST guidance wants.
    it('accepts a plain passphrase with no digits or symbols', () => {
        expect(ok(passwordSchema, 'correct horse battery staple')).toBe(true)
    })

    it('refuses something absurdly long, which would only be a way to burn scrypt time', () => {
        expect(ok(passwordSchema, 'x'.repeat(5000))).toBe(false)
    })
})

describe('codeSchema', () => {
    it('accepts a six digit code and a recovery code', () => {
        expect(ok(codeSchema, '123456')).toBe(true)
        expect(ok(codeSchema, 'ABCDE-FGHJK')).toBe(true)
    })

    it('refuses empty and overlong input', () => {
        expect(ok(codeSchema, '')).toBe(false)
        expect(ok(codeSchema, 'x'.repeat(100))).toBe(false)
    })
})

describe('clientDetailsSchema', () => {
    const valid = { name: 'Ann Example', company: 'Acme', email: 'ann@example.com' }

    it('accepts a full set of details', () => {
        expect(ok(clientDetailsSchema, valid)).toBe(true)
    })

    it('turns an empty company into null, so the column is never an empty string', () => {
        expect(clientDetailsSchema.parse({ ...valid, company: '  ' }).company).toBeNull()
    })

    it('lower-cases and trims the email, because it is the sign-in identity', () => {
        expect(clientDetailsSchema.parse({ ...valid, email: '  Ann@Example.COM ' }).email).toBe('ann@example.com')
    })

    // Line breaks would otherwise travel into an email header
    it('refuses a line break in the name', () => {
        expect(ok(clientDetailsSchema, { ...valid, name: 'Ann\nBcc: someone@example.com' })).toBe(false)
    })

    it('refuses a missing name or a bad email', () => {
        expect(ok(clientDetailsSchema, { ...valid, name: '   ' })).toBe(false)
        expect(ok(clientDetailsSchema, { ...valid, email: 'not an address' })).toBe(false)
    })
})

describe('siteSchema', () => {
    it('accepts a hostd project id', () => {
        expect(ok(siteSchema, { projectId: 'acme-bakery', name: 'Acme Bakery' })).toBe(true)
    })

    // Copied verbatim from hostd/src/shared/formats.ts, so the portal cannot store an id hostd would reject
    it.each(['Acme-Bakery', '-acme', 'a', 'acme_bakery', 'x'.repeat(32)])('refuses the project id %j', projectId => {
        expect(ok(siteSchema, { projectId, name: 'Site' })).toBe(false)
    })

    it.each(['hostd', 'mail', 'horizons'])('refuses the reserved project id %j', projectId => {
        expect(ok(siteSchema, { projectId, name: 'Site' })).toBe(false)
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/schema.test.ts
```

Expected: FAIL, cannot resolve `./schema`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/schema.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/clients/schema.ts server/clients/schema.test.ts
git commit -F - <<'MSG'
Add the shared validation rules for client accounts

The password rule is length only, with no composition rules, which is
current NIST guidance and kinder to clients who are not developers.

Project ids are validated against hostd's own pattern, copied verbatim,
so the portal cannot store an id hostd would refuse.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 8: Split the mail configuration

**Files:**
- Modify: `server/env.ts`
- Modify: `server/quotes/wiring.ts` (rename the call)
- Test: `server/env.test.ts` (extend)

**Why:** `mailConfig()` currently mixes the SMTP transport with quote-specific addresses, and throws when `QUOTE_NOTIFY_TO` is missing. Client emails need the transport but not those addresses, and a missing quote setting must not block a client invite.

**Interfaces:**
- Consumes: the existing `Env`, `EnvError`, `required` and `single` helpers in `server/env.ts`.
- Produces:
  - `smtpConfig(env?: Env): SmtpConfig` where `SmtpConfig = { host: number, port: number, user?: string, pass?: string, from: string, siteUrl: string }`
  - `quoteMailConfig(env?: Env): MailConfig` (the existing `MailConfig` shape, unchanged, so `server/quotes/*` keeps compiling)
  - `clientMailConfig(env?: Env): ClientMailConfig` where `ClientMailConfig = SmtpConfig & { replyTo: string }`

- [ ] **Step 1: Write the failing test**

Add to `server/env.test.ts`:

```ts
const smtp = {
    SMTP_HOST: 'localhost', SMTP_PORT: '1025', MAIL_FROM: 'Horizons <quotes@dev.horizons.gg>',
    AUTH_URL: 'https://www.horizons.gg/',
}

describe('smtpConfig', () => {
    it('reads the transport without needing any quote setting', () => {
        expect(smtpConfig(smtp)).toMatchObject({ host: 'localhost', port: 1025, siteUrl: 'https://www.horizons.gg' })
    })
})

describe('clientMailConfig', () => {
    it('adds the client reply-to', () => {
        expect(clientMailConfig({ ...smtp, CLIENT_REPLY_TO: 'info@dev.horizons.gg' }).replyTo).toBe('info@dev.horizons.gg')
    })

    it('names the variable when it is missing', () => {
        expect(() => clientMailConfig(smtp)).toThrow(/CLIENT_REPLY_TO/)
    })

    // The whole point of the split: a missing quote setting must not stop a client invite going out
    it('does not need QUOTE_NOTIFY_TO or QUOTE_REPLY_TO', () => {
        expect(() => clientMailConfig({ ...smtp, CLIENT_REPLY_TO: 'info@dev.horizons.gg' })).not.toThrow()
    })
})
```

Import `smtpConfig` and `clientMailConfig` alongside the existing imports, and rename any existing `mailConfig` references in that file to `quoteMailConfig`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/env.test.ts
```

Expected: FAIL, `smtpConfig` is not exported.

- [ ] **Step 3: Restructure `server/env.ts`**

Replace the existing `MailConfig` type and `mailConfig` function with:

```ts
export type SmtpConfig = {
    host: string
    port: number
    user?: string
    pass?: string
    from: string
    // The site's own address, for links in emails
    siteUrl: string
}

// Just the transport. Split out from the quote settings so a missing QUOTE_NOTIFY_TO can't stop a client
// invite going out: the two features fail independently.
export function smtpConfig(env: Env = process.env): SmtpConfig {
    const problems: string[] = []
    const host = required(env, 'SMTP_HOST', problems)
    const portText = required(env, 'SMTP_PORT', problems)
    const port = Number(portText)
    if (portText && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push('SMTP_PORT must be a port number, such as 587')
    const from = required(env, 'MAIL_FROM', problems)
    const siteUrl = required(env, 'AUTH_URL', problems)
    if (problems.length) throw new EnvError(problems)

    return {
        host, port, from,
        user: env.SMTP_USER?.trim() || undefined,
        // Not trimmed on purpose: a password may legitimately start or end with whitespace
        pass: env.SMTP_PASS || undefined,
        siteUrl: siteUrl.replace(/\/+$/, ''),
    }
}

export type MailConfig = SmtpConfig & { notifyTo: string, replyTo: string }

export function quoteMailConfig(env: Env = process.env): MailConfig {
    const base = smtpConfig(env)
    const problems: string[] = []
    const notifyTo = required(env, 'QUOTE_NOTIFY_TO', problems)
    const replyTo = required(env, 'QUOTE_REPLY_TO', problems)
    if (problems.length) throw new EnvError(problems)
    return { ...base, notifyTo, replyTo }
}

export type ClientMailConfig = SmtpConfig & { replyTo: string }

export function clientMailConfig(env: Env = process.env): ClientMailConfig {
    return { ...smtpConfig(env), replyTo: single(env, 'CLIENT_REPLY_TO') }
}
```

- [ ] **Step 4: Update the one caller**

In `server/quotes/wiring.ts`, change the import and the call from `mailConfig` to `quoteMailConfig`. Check for others:

```bash
grep -rn "mailConfig" server app --include=*.ts --include=*.tsx
```

Every hit must now read `quoteMailConfig`, `clientMailConfig` or `smtpConfig`.

- [ ] **Step 5: Run the whole suite**

```bash
npm test && npx tsc --noEmit
```

Expected: PASS. The quote tests must be unaffected: `MailConfig` still has the same shape, so `createMailer` and `server/quotes/emails.ts` need no change.

- [ ] **Step 6: Commit**

```bash
git add server/env.ts server/env.test.ts server/quotes/wiring.ts
git commit -F - <<'MSG'
Split the SMTP transport out of the quote mail settings

Client emails need the transport but not QUOTE_NOTIFY_TO, and a missing
quote setting must not be what stops a client invite going out. The two
features now fail independently.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 9: The repository

**Files:**
- Create: `server/clients/repo.ts`
- Test: `server/clients/repo.test.ts`

**Interfaces:**
- Consumes: `PrismaClient` from `server/generated/prisma/client`, `LockUpdate` from `./limits`, `ClientDetails` and `SiteInput` from `./schema`.
- Produces: `clientRepo(db: PrismaClient)` returning the object below, and the types `ClientRepo = ReturnType<typeof clientRepo>`, `ClientRecord`, `SessionWithClient`, `ClientListRow`.

Every later task talks to the database only through this object. The exact surface, which later tasks call by name:

```ts
// Clients
createWithInvite(details: ClientDetails, id: string, token: { tokenHash: string, expiresAt: Date }): Promise<ClientRecord>
byId(id: string): Promise<ClientRecord | null>
byEmail(email: string): Promise<ClientRecord | null>
list(): Promise<ClientListRow[]>
updateDetails(id: string, details: ClientDetails): Promise<void>
remove(id: string): Promise<void>
setPassword(id: string, passwordHash: string, now: Date): Promise<void>
setTotpPending(id: string, totpSecret: string): Promise<void>   // stored before it is proved, not yet usable
confirmTotp(id: string, now: Date): Promise<void>               // the moment it becomes usable
clearTotp(id: string): Promise<void>
setSuspended(id: string, suspendedAt: Date | null): Promise<void>
recordFailure(id: string, update: LockUpdate): Promise<void>
recordSuccess(id: string, now: Date): Promise<void>
clearLock(id: string): Promise<void>

// Tokens
createToken(clientId: string, purpose: 'INVITE' | 'PASSWORD_RESET', tokenHash: string, expiresAt: Date): Promise<void>
tokenByHash(tokenHash: string): Promise<(ClientToken & { client: ClientRecord }) | null>
useToken(id: string, now: Date): Promise<void>
invalidateTokens(clientId: string, purpose: 'INVITE' | 'PASSWORD_RESET', now: Date): Promise<void>

// Sessions
createSession(clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<{ id: string }>
sessionByHash(tokenHash: string): Promise<SessionWithClient | null>
completeMfa(sessionId: string, mfaAt: Date, expiresAt: Date): Promise<void>
touchSession(sessionId: string, lastUsedAt: Date, expiresAt: Date): Promise<void>
listSessions(clientId: string): Promise<ClientSession[]>
deleteSession(id: string): Promise<void>
deleteSessionsFor(clientId: string, exceptId?: string): Promise<void>

// Recovery codes
replaceRecoveryCodes(clientId: string, codeHashes: string[]): Promise<void>
unusedRecoveryCodes(clientId: string): Promise<{ id: string, codeHash: string }[]>
useRecoveryCode(id: string, now: Date): Promise<void>
countUnusedRecoveryCodes(clientId: string): Promise<number>

// Replay and rate limiting
recordTotpUse(clientId: string, step: bigint): Promise<boolean>   // false means it was already used
countAttempts(ipHash: string, since: Date): Promise<number>
recordAttempt(ipHash: string): Promise<void>
prune(clientId: string, now: Date): Promise<void>                  // expired sessions, old TOTP uses, old attempts

// Sites and quotes
listSites(clientId: string): Promise<Site[]>
createSite(clientId: string, input: SiteInput): Promise<void>
removeSite(clientId: string, siteId: string): Promise<void>
linkQuote(quoteId: string, clientId: string): Promise<void>
```

- [ ] **Step 1: Write the failing test**

Create `server/clients/repo.test.ts`, following `server/quotes/repo.test.ts` exactly for setup and teardown:

```ts
// Runs against a real Postgres, the horizons_test database named by TEST_DATABASE_URL. Skipped without it.

import 'dotenv/config'

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDb } from '../db'
import type { PrismaClient } from '../generated/prisma/client'
import { clientRepo, type ClientRepo } from './repo'

const url = process.env.TEST_DATABASE_URL
const TABLES = '"Client", "Site", "ClientSession", "ClientToken", "ClientRecoveryCode", "ClientTotpUse", "ClientAuthAttempt", "Quote", "Note"'

const details = { name: 'Ann Example', company: 'Acme', email: 'ann@example.com' }
const hour = (count: number) => new Date(Date.now() + count * 60 * 60 * 1000)

describe.skipIf(!url)('clientRepo', () => {
    let db: PrismaClient
    let repo: ClientRepo

    beforeAll(() => {
        execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
        db = createDb(url!)
        repo = clientRepo(db)
    })

    beforeEach(async () => {
        await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
    })

    afterAll(async () => {
        await db?.$disconnect()
    })

    const invited = () => repo.createWithInvite(details, 'cl_ABCDEFGH', { tokenHash: 'invite1', expiresAt: hour(1) })

    it('creates the client and its invite in one go', async () => {
        const client = await invited()
        expect(client.id).toBe('cl_ABCDEFGH')
        expect(await db.clientToken.count({ where: { clientId: client.id, purpose: 'INVITE' } })).toBe(1)
    })

    // One transaction: a client with no way to accept the invite is worse than no client at all
    it('writes neither the client nor the token when the email is taken', async () => {
        await invited()
        await expect(repo.createWithInvite(details, 'cl_BBBBBBBB', { tokenHash: 'invite2', expiresAt: hour(1) })).rejects.toThrow()
        expect(await db.client.count()).toBe(1)
        expect(await db.clientToken.count()).toBe(1)
    })

    it('finds a client by a lower-cased email', async () => {
        await invited()
        expect((await repo.byEmail('ann@example.com'))?.id).toBe('cl_ABCDEFGH')
        expect(await repo.byEmail('nobody@example.com')).toBeNull()
    })

    it('reads a token back with its client attached', async () => {
        await invited()
        const found = await repo.tokenByHash('invite1')
        expect(found?.client.email).toBe('ann@example.com')
        expect(found?.usedAt).toBeNull()
    })

    it('invalidates earlier tokens of the same purpose', async () => {
        const client = await invited()
        await repo.invalidateTokens(client.id, 'INVITE', new Date())
        expect((await repo.tokenByHash('invite1'))?.usedAt).not.toBeNull()
    })

    it('refuses a replayed TOTP step and accepts a new one', async () => {
        const client = await invited()
        expect(await repo.recordTotpUse(client.id, 100n)).toBe(true)
        expect(await repo.recordTotpUse(client.id, 100n)).toBe(false)
        expect(await repo.recordTotpUse(client.id, 101n)).toBe(true)
    })

    it('keeps every session but the one named when signing out elsewhere', async () => {
        const client = await invited()
        const keep = await repo.createSession(client.id, 'keep', hour(1), 'Firefox')
        await repo.createSession(client.id, 'drop', hour(1), 'Chrome')
        await repo.deleteSessionsFor(client.id, keep.id)
        expect((await repo.listSessions(client.id)).map(session => session.id)).toEqual([keep.id])
    })

    it('replaces the whole set of recovery codes', async () => {
        const client = await invited()
        await repo.replaceRecoveryCodes(client.id, ['a', 'b'])
        await repo.replaceRecoveryCodes(client.id, ['c'])
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(1)
    })

    it('stops counting a recovery code once it is used', async () => {
        const client = await invited()
        await repo.replaceRecoveryCodes(client.id, ['a', 'b'])
        const [first] = await repo.unusedRecoveryCodes(client.id)
        await repo.useRecoveryCode(first.id, new Date())
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(1)
    })

    it('clears the authenticator, its codes and every session together', async () => {
        const client = await invited()
        await repo.setTotpPending(client.id, 'v1$a$b$c')
        await repo.confirmTotp(client.id, new Date())
        await repo.replaceRecoveryCodes(client.id, ['a'])
        await repo.createSession(client.id, 'session', hour(1), null)

        await repo.clearTotp(client.id)

        const after = await repo.byId(client.id)
        expect(after?.totpSecret).toBeNull()
        expect(after?.totpConfirmedAt).toBeNull()
        expect(await repo.countUnusedRecoveryCodes(client.id)).toBe(0)
        expect(await repo.listSessions(client.id)).toEqual([])
    })

    it('prunes expired sessions, old codes and old attempts', async () => {
        const client = await invited()
        await repo.createSession(client.id, 'stale', hour(-1), null)
        await repo.createSession(client.id, 'live', hour(1), null)
        await repo.recordTotpUse(client.id, 1n)
        await repo.recordAttempt('ip1')

        await db.$executeRawUnsafe(`UPDATE "ClientTotpUse" SET "usedAt" = now() - interval '1 day'`)
        await db.$executeRawUnsafe(`UPDATE "ClientAuthAttempt" SET "createdAt" = now() - interval '1 day'`)
        await repo.prune(client.id, new Date())

        expect((await repo.listSessions(client.id)).map(session => session.tokenHash)).toEqual(['live'])
        expect(await db.clientTotpUse.count()).toBe(0)
        expect(await db.clientAuthAttempt.count()).toBe(0)
    })

    it('counts only recent attempts from the same IP', async () => {
        await repo.recordAttempt('ip1')
        await repo.recordAttempt('ip1')
        await repo.recordAttempt('ip2')
        expect(await repo.countAttempts('ip1', new Date(Date.now() - 60_000))).toBe(2)
    })

    it('links a quote to a client', async () => {
        const client = await invited()
        const quote = await db.quote.create({ data: { name: 'Ann', email: 'ann@example.com', message: 'Hello there', ipHash: 'h' } })
        await repo.linkQuote(quote.id, client.id)
        expect((await db.quote.findUnique({ where: { id: quote.id } }))?.clientId).toBe(client.id)
    })

    it('only removes a site that belongs to the client it was asked about', async () => {
        const client = await invited()
        await repo.createSite(client.id, { projectId: 'acme-bakery', name: 'Acme Bakery' })
        const [site] = await repo.listSites(client.id)
        await repo.removeSite('cl_SOMEONEE', site.id)
        expect(await repo.listSites(client.id)).toHaveLength(1)
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/repo.test.ts
```

Expected: FAIL, cannot resolve `./repo`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/repo.ts`:

```ts
// Every query the client accounts feature makes, in one place, taking the client as a parameter so the tests
// can point it at the test database. Same shape as server/quotes/repo.ts.

import 'server-only'

import type { ClientSession, ClientTokenPurpose, PrismaClient, Site } from '../generated/prisma/client'
import type { LockUpdate } from './limits'
import type { ClientDetails, SiteInput } from './schema'

// How long a used TOTP step stays recorded. Well past the accepted window, and short enough that the table
// never grows.
const TOTP_USE_TTL_MS = 5 * 60 * 1000
const ATTEMPT_TTL_MS = 60 * 60 * 1000

const listColumns = {
    id: true, name: true, company: true, email: true, createdAt: true, lastSignInAt: true,
    passwordHash: true, totpConfirmedAt: true, suspendedAt: true, lockedUntil: true,
    _count: { select: { sites: true } },
} as const

export function clientRepo(db: PrismaClient) {
    const repo = {
        // One transaction: a client who exists with no way to accept the invite is worse than no client at all
        createWithInvite: (details: ClientDetails, id: string, token: { tokenHash: string, expiresAt: Date }) =>
            db.client.create({
                data: {
                    id, ...details,
                    tokens: { create: { purpose: 'INVITE', tokenHash: token.tokenHash, expiresAt: token.expiresAt } },
                },
            }),

        byId: (id: string) => db.client.findUnique({ where: { id } }),

        // The schema lower-cases every address on the way in, so a plain equality match is enough
        byEmail: (email: string) => db.client.findUnique({ where: { email } }),

        list: () => db.client.findMany({ orderBy: { createdAt: 'desc' }, select: listColumns }),

        updateDetails: async (id: string, details: ClientDetails) => {
            await db.client.update({ where: { id }, data: details })
        },

        remove: async (id: string) => {
            await db.client.delete({ where: { id } })
        },

        setPassword: async (id: string, passwordHash: string, now: Date) => {
            await db.client.update({ where: { id }, data: { passwordHash, passwordUpdatedAt: now } })
        },

        // Stored before the client has proved they can read it, so a page reload doesn't strand a half-scanned
        // QR code. Not usable for sign-in until confirmTotp sets totpConfirmedAt.
        setTotpPending: async (id: string, totpSecret: string) => {
            await db.client.update({ where: { id }, data: { totpSecret, totpConfirmedAt: null } })
        },

        confirmTotp: async (id: string, now: Date) => {
            await db.client.update({ where: { id }, data: { totpConfirmedAt: now } })
        },

        // Everything the old authenticator could reach goes with it, including open sessions
        clearTotp: async (id: string) => {
            await db.$transaction([
                db.client.update({ where: { id }, data: { totpSecret: null, totpConfirmedAt: null } }),
                db.clientRecoveryCode.deleteMany({ where: { clientId: id } }),
                db.clientSession.deleteMany({ where: { clientId: id } }),
            ])
        },

        setSuspended: async (id: string, suspendedAt: Date | null) => {
            await db.$transaction([
                db.client.update({ where: { id }, data: { suspendedAt } }),
                // Suspending must take effect on the next request, not at the next token expiry
                ...(suspendedAt ? [db.clientSession.deleteMany({ where: { clientId: id } })] : []),
            ])
        },

        recordFailure: async (id: string, update: LockUpdate) => {
            await db.client.update({ where: { id }, data: update })
        },

        recordSuccess: async (id: string, now: Date) => {
            await db.client.update({ where: { id }, data: { failedSignIns: 0, lockedUntil: null, lastSignInAt: now } })
        },

        clearLock: async (id: string) => {
            await db.client.update({ where: { id }, data: { failedSignIns: 0, lockedUntil: null } })
        },

        createToken: async (clientId: string, purpose: ClientTokenPurpose, tokenHash: string, expiresAt: Date) => {
            await db.clientToken.create({ data: { clientId, purpose, tokenHash, expiresAt } })
        },

        tokenByHash: (tokenHash: string) => db.clientToken.findUnique({ where: { tokenHash }, include: { client: true } }),

        useToken: async (id: string, now: Date) => {
            await db.clientToken.update({ where: { id }, data: { usedAt: now } })
        },

        // Marked used rather than deleted, so an old link reads as "no longer valid" rather than "never existed"
        invalidateTokens: async (clientId: string, purpose: ClientTokenPurpose, now: Date) => {
            await db.clientToken.updateMany({ where: { clientId, purpose, usedAt: null }, data: { usedAt: now } })
        },

        createSession: (clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null) =>
            db.clientSession.create({ data: { clientId, tokenHash, expiresAt, userAgent }, select: { id: true } }),

        sessionByHash: (tokenHash: string) => db.clientSession.findUnique({ where: { tokenHash }, include: { client: true } }),

        completeMfa: async (sessionId: string, mfaAt: Date, expiresAt: Date) => {
            await db.clientSession.update({ where: { id: sessionId }, data: { mfaAt, expiresAt, lastUsedAt: mfaAt } })
        },

        touchSession: async (sessionId: string, lastUsedAt: Date, expiresAt: Date) => {
            await db.clientSession.update({ where: { id: sessionId }, data: { lastUsedAt, expiresAt } })
        },

        listSessions: (clientId: string) => db.clientSession.findMany({ where: { clientId }, orderBy: { lastUsedAt: 'desc' } }),

        deleteSession: async (id: string) => {
            await db.clientSession.deleteMany({ where: { id } })
        },

        deleteSessionsFor: async (clientId: string, exceptId?: string) => {
            await db.clientSession.deleteMany({ where: { clientId, ...(exceptId && { id: { not: exceptId } }) } })
        },

        // Regenerating invalidates the old set, which is the whole point of offering it
        replaceRecoveryCodes: async (clientId: string, codeHashes: string[]) => {
            await db.$transaction([
                db.clientRecoveryCode.deleteMany({ where: { clientId } }),
                db.clientRecoveryCode.createMany({ data: codeHashes.map(codeHash => ({ clientId, codeHash })) }),
            ])
        },

        unusedRecoveryCodes: (clientId: string) =>
            db.clientRecoveryCode.findMany({ where: { clientId, usedAt: null }, select: { id: true, codeHash: true } }),

        useRecoveryCode: async (id: string, now: Date) => {
            await db.clientRecoveryCode.update({ where: { id }, data: { usedAt: now } })
        },

        countUnusedRecoveryCodes: (clientId: string) => db.clientRecoveryCode.count({ where: { clientId, usedAt: null } }),

        // The unique key is what refuses the replay, so there is no window between checking and recording
        recordTotpUse: async (clientId: string, step: bigint): Promise<boolean> => {
            try {
                await db.clientTotpUse.create({ data: { clientId, step } })
                return true
            } catch {
                return false
            }
        },

        countAttempts: (ipHash: string, since: Date) =>
            db.clientAuthAttempt.count({ where: { ipHash, createdAt: { gte: since } } }),

        recordAttempt: async (ipHash: string) => {
            await db.clientAuthAttempt.create({ data: { ipHash } })
        },

        // Lazily, on a successful sign-in, which is the only moment any of these three grows
        prune: async (clientId: string, now: Date) => {
            await db.$transaction([
                db.clientSession.deleteMany({ where: { clientId, expiresAt: { lt: now } } }),
                db.clientTotpUse.deleteMany({ where: { clientId, usedAt: { lt: new Date(now.getTime() - TOTP_USE_TTL_MS) } } }),
                db.clientAuthAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ATTEMPT_TTL_MS) } } }),
            ])
        },

        listSites: (clientId: string) => db.site.findMany({ where: { clientId }, orderBy: { name: 'asc' } }),

        createSite: async (clientId: string, input: SiteInput) => {
            await db.site.create({ data: { clientId, ...input } })
        },

        // Scoped to the client, so a site can only be removed from the page it is shown on
        removeSite: async (clientId: string, siteId: string) => {
            await db.site.deleteMany({ where: { id: siteId, clientId } })
        },

        linkQuote: async (quoteId: string, clientId: string) => {
            await db.quote.update({ where: { id: quoteId }, data: { clientId } })
        },
    }
    return repo
}

export type ClientRepo = ReturnType<typeof clientRepo>
export type ClientRecord = NonNullable<Awaited<ReturnType<ClientRepo['byId']>>>
export type ClientListRow = Awaited<ReturnType<ClientRepo['list']>>[number]
export type SessionWithClient = NonNullable<Awaited<ReturnType<ClientRepo['sessionByHash']>>>
export type { ClientSession, Site }
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/repo.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add server/clients/repo.ts server/clients/repo.test.ts
git commit -F - <<'MSG'
Add every client account query in one repository

Creating a client and its invite is one transaction: a client who exists
with no way to accept the invite is worse than no client at all.

Recording a used TOTP step relies on the unique key to refuse a replay,
so there is no window between checking and recording. Suspending and
clearing an authenticator both delete open sessions in the same
transaction, so neither can half apply.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 10: Session tokens, cookie and lifetimes

**Files:**
- Create: `server/clients/session.ts`
- Test: `server/clients/session.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PENDING_SESSION_MS`, `IDLE_MS`, `ABSOLUTE_MS`, `TOUCH_AFTER_MS`
  - `cookieName(secure: boolean): string`, `cookieOptions(secure: boolean)`
  - `newSessionToken(random?: (bytes: number) => Buffer): string`, `hashSessionToken(token: string): string`
  - `pendingExpiry(now: Date): Date`, `activeExpiry(createdAt: Date, now: Date): Date`
  - `shouldTouch(lastUsedAt: Date, now: Date): boolean`
  - `isExpired(session, now): boolean`, `isUsable(session, now): boolean`, `isPending(session, now): boolean`

- [ ] **Step 1: Write the failing test**

Create `server/clients/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { activeExpiry, cookieName, cookieOptions, hashSessionToken, isPending, isUsable, newSessionToken, pendingExpiry, shouldTouch } from './session'

const now = new Date('2026-09-20T10:00:00Z')
const minutes = (count: number) => new Date(now.getTime() + count * 60_000)

describe('the cookie', () => {
    // The __Secure- prefix is only honoured over HTTPS, so development would silently lose the cookie
    it('takes the __Secure- prefix only in production', () => {
        expect(cookieName(true)).toBe('__Secure-horizons-client')
        expect(cookieName(false)).toBe('horizons-client')
    })

    it('is HttpOnly and Lax', () => {
        // Lax, not Strict: an invite link arrives from a mail client as a top-level navigation, and Strict
        // would drop the cookie on that first hop
        expect(cookieOptions(true)).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
        expect(cookieOptions(false).secure).toBe(false)
    })
})

describe('tokens', () => {
    it('is 32 random bytes as base64url, so it is URL and cookie safe', () => {
        const token = newSessionToken()
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('does not repeat itself', () => {
        expect(new Set(Array.from({ length: 500 }, () => newSessionToken())).size).toBe(500)
    })

    // Only the hash is stored, so reading the table doesn't let anyone resume a session
    it('hashes to stable hex that is not the token', () => {
        const token = newSessionToken()
        expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/)
        expect(hashSessionToken(token)).toBe(hashSessionToken(token))
        expect(hashSessionToken(token)).not.toContain(token)
    })
})

describe('lifetimes', () => {
    it('gives a half-finished sign-in ten minutes', () => {
        expect(pendingExpiry(now)).toEqual(minutes(10))
    })

    it('gives a finished session 24 hours of idle time', () => {
        expect(activeExpiry(now, now)).toEqual(minutes(24 * 60))
    })

    // 7 days absolute wins once the session is old, however recently it was used
    it('caps at 7 days from when the session started', () => {
        const createdAt = new Date('2026-09-14T10:00:00Z')
        expect(activeExpiry(createdAt, now)).toEqual(new Date('2026-09-21T10:00:00Z'))
    })

    it('writes lastUsedAt at most every five minutes, so a page view costs no write', () => {
        expect(shouldTouch(minutes(-1), now)).toBe(false)
        expect(shouldTouch(minutes(-6), now)).toBe(true)
    })
})

describe('usability', () => {
    const pending = { mfaAt: null, expiresAt: minutes(5) }
    const done = { mfaAt: minutes(-10), expiresAt: minutes(60) }

    // The heart of mandatory 2FA: a session without mfaAt is not usable for anything
    it('treats a session without mfaAt as pending, never usable', () => {
        expect(isUsable(pending, now)).toBe(false)
        expect(isPending(pending, now)).toBe(true)
    })

    it('treats a session with mfaAt as usable', () => {
        expect(isUsable(done, now)).toBe(true)
        expect(isPending(done, now)).toBe(false)
    })

    it('treats an expired session as neither', () => {
        const expired = { mfaAt: minutes(-100), expiresAt: minutes(-1) }
        expect(isUsable(expired, now)).toBe(false)
        expect(isPending(expired, now)).toBe(false)
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/session.test.ts
```

Expected: FAIL, cannot resolve `./session`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/session.ts`:

```ts
// What a client session is, as arithmetic and constants. No database and no next/* imports, so the rules can
// be read in one place and tested without either.

import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

// A sign-in that stops after the password. Long enough to find a phone, short enough to be worthless if left.
export const PENDING_SESSION_MS = 10 * 60 * 1000
export const IDLE_MS = 24 * 60 * 60 * 1000
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
export const TOUCH_AFTER_MS = 5 * 60 * 1000

// The __Secure- prefix requires HTTPS, so development would silently lose a cookie that carried it
export const cookieName = (secure: boolean) => (secure ? '__Secure-horizons-client' : 'horizons-client')

export const cookieOptions = (secure: boolean) => ({
    httpOnly: true,
    secure,
    // Lax, not Strict: invite and reset links arrive from a mail client as a top-level navigation, and Strict
    // would drop the cookie on that first hop.
    sameSite: 'lax' as const,
    path: '/',
})

export const newSessionToken = (random: (bytes: number) => Buffer = randomBytes) => random(32).toString('base64url')

// Only the hash is stored, so reading the table doesn't let anyone resume a session
export const hashSessionToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const pendingExpiry = (now: Date) => new Date(now.getTime() + PENDING_SESSION_MS)

// Idle or absolute, whichever runs out first
export const activeExpiry = (createdAt: Date, now: Date) =>
    new Date(Math.min(now.getTime() + IDLE_MS, createdAt.getTime() + ABSOLUTE_MS))

export const shouldTouch = (lastUsedAt: Date, now: Date) => now.getTime() - lastUsedAt.getTime() > TOUCH_AFTER_MS

type SessionState = { mfaAt: Date | null, expiresAt: Date }

export const isExpired = (session: SessionState, now: Date) => session.expiresAt.getTime() <= now.getTime()

// A session is usable only once the second factor is done. Only three code paths write mfaAt, and each is
// reached only after a verified TOTP code, a verified recovery code, or completed enrolment. That is what
// makes mandatory 2FA a property of the data rather than a check somebody can forget to write.
export const isUsable = (session: SessionState, now: Date) => !!session.mfaAt && !isExpired(session, now)

export const isPending = (session: SessionState, now: Date) => !session.mfaAt && !isExpired(session, now)
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/clients/session.ts server/clients/session.test.ts
git commit -F - <<'MSG'
Define client sessions, their cookie and their lifetimes

A session is usable only once mfaAt is set, which is what makes the
mandatory authenticator a property of the data rather than a check that
could be forgotten at a new call site.

SameSite is Lax rather than Strict because invite and reset links arrive
from a mail client as a top-level navigation, which Strict would drop.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 11: Reading the session, and the two guards

**Files:**
- Create: `server/clients/auth.ts`
- Test: covered by Task 12's pipeline tests and the browser pass in Task 22

**Interfaces:**
- Consumes: `getDb` from `server/db`, `clientRepo` from `./repo`, everything from `./session`.
- Produces:
  - `SIGN_IN_PATH`, `CODE_PATH`, `SETUP_PATH`, `PORTAL_HOME`
  - `readSession(): Promise<SessionWithClient | null>`
  - `currentClient(): Promise<{ client: ClientRecord, sessionId: string } | null>`
  - `requireClient(): Promise<{ client: ClientRecord, sessionId: string }>`
  - `requirePendingSession(): Promise<SessionWithClient>`
  - `setSessionCookie(token: string, expiresAt: Date): Promise<void>`
  - `clearSessionCookie(): Promise<void>`

**This module is deliberately thin.** All the decisions live in `session.ts`, which Task 10 tested exhaustively. What is left here is reading a cookie and calling the repo, which the browser pass exercises.

- [ ] **Step 1: Write the implementation**

Create `server/clients/auth.ts`:

```ts
// The guard every portal page and action calls first. Middleware only checks that a cookie exists, because
// Prisma doesn't run in the edge runtime, so this is the layer that actually decides. Same two-layer design
// the admin area uses, and for the same reason: middleware has been bypassed before (CVE-2025-29927).

import 'server-only'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { getDb } from '../db'
import { clientRepo, type ClientRecord, type SessionWithClient } from './repo'
import { activeExpiry, cookieName, cookieOptions, hashSessionToken, isPending, isUsable, shouldTouch } from './session'

export const SIGN_IN_PATH = '/portal/sign-in'
export const CODE_PATH = '/portal/sign-in/code'
export const SETUP_PATH = '/portal/setup'
export const PORTAL_HOME = '/portal'

const secure = process.env.NODE_ENV === 'production'

export async function readSession(): Promise<SessionWithClient | null> {
    const token = (await cookies()).get(cookieName(secure))?.value
    if (!token) return null
    return clientRepo(getDb()).sessionByHash(hashSessionToken(token))
}

export async function currentClient(): Promise<{ client: ClientRecord, sessionId: string } | null> {
    const session = await readSession()
    const now = new Date()
    if (!session || !isUsable(session, now)) return null
    // Suspending deletes sessions, but a request already in flight can still be carrying one
    if (session.client.suspendedAt) return null
    if (shouldTouch(session.lastUsedAt, now)) {
        await clientRepo(getDb()).touchSession(session.id, now, activeExpiry(session.createdAt, now))
    }
    return { client: session.client, sessionId: session.id }
}

export async function requireClient(): Promise<{ client: ClientRecord, sessionId: string }> {
    const current = await currentClient()
    if (current) return current
    // A half-finished sign-in goes back to the step it stopped at rather than to the beginning
    const session = await readSession()
    if (session && isPending(session, new Date()) && !session.client.suspendedAt) {
        redirect(session.client.totpConfirmedAt ? CODE_PATH : SETUP_PATH)
    }
    redirect(SIGN_IN_PATH)
}

// For the second-factor and enrolment pages, which need the half-session and must refuse a finished one
export async function requirePendingSession(): Promise<SessionWithClient> {
    const session = await readSession()
    if (!session || !isPending(session, new Date()) || session.client.suspendedAt) redirect(SIGN_IN_PATH)
    return session
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
    (await cookies()).set(cookieName(secure), token, { ...cookieOptions(secure), expires: expiresAt })
}

export async function clearSessionCookie(): Promise<void> {
    (await cookies()).delete(cookieName(secure))
}
```

- [ ] **Step 2: Check it compiles**

```bash
npx tsc --noEmit
```

Expected: PASS. If `redirect` does not narrow `session` to non-null, confirm it is imported from `next/navigation` (its return type is `never`, which is what does the narrowing).

- [ ] **Step 3: Commit**

```bash
git add server/clients/auth.ts
git commit -F - <<'MSG'
Add the portal session guard

Middleware can only check that a cookie exists, because Prisma does not
run in the edge runtime, so this is the layer that decides. Same two
layers the admin area uses, for the same CVE-2025-29927 reason.

A half-finished sign-in is sent back to the step it stopped at rather
than to the beginning, so losing a tab during enrolment is not a reason
to start over.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 12: The sign-in pipeline

**Files:**
- Create: `server/clients/signIn.ts`
- Test: `server/clients/signIn.test.ts`

**A resolved contradiction in the spec, worth knowing before you start.** The spec says every failure gives one vague message, and its limits table says a locked account is told it is locked. Those cannot both hold: telling someone their account is locked reveals that it exists. The resolution implemented here: **the lock is only ever revealed to someone who has already supplied the correct password.** Someone guessing gets the vague message, so nothing is enumerable, and a real client who is locked out is told why.

**Interfaces:**
- Consumes: `./limits`, `./password`, `./secrets`, `./totp`, `./ids`, `./session`, `ClientRecord` from `./repo`.
- Produces:
  - `GENERIC_ERROR`, `TOO_MANY_ERROR`, `LOCKED_ERROR`, `CODE_ERROR`, `REPLAYED_ERROR` (strings)
  - `type PasswordStepDeps`, `type CodeStepDeps` (below)
  - `passwordStep(input: { email: string, password: string, userAgent: string | null }, deps: PasswordStepDeps): Promise<PasswordStepResult>`
  - `codeStep(input: { session: SessionWithClient, code: string }, deps: CodeStepDeps): Promise<{ ok: true } | { ok: false, error: string }>`
  - `type PasswordStepResult = { ok: true, next: 'code' | 'setup', token: string, expiresAt: Date } | { ok: false, error: string }`

- [ ] **Step 1: Write the failing test**

Create `server/clients/signIn.test.ts`. The stand-ins are plain objects, in the style of `server/quotes/submit.test.ts`.

```ts
import { describe, expect, it, vi } from 'vitest'

import { CODE_ERROR, GENERIC_ERROR, LOCKED_ERROR, REPLAYED_ERROR, TOO_MANY_ERROR, codeStep, passwordStep } from './signIn'

const now = new Date('2026-09-20T10:00:00Z')

const client = (overrides: Record<string, unknown> = {}) => ({
    id: 'cl_ABCDEFGH',
    email: 'ann@example.com',
    passwordHash: 'stored-hash',
    totpSecret: 'encrypted',
    totpConfirmedAt: new Date('2026-09-01T00:00:00Z'),
    suspendedAt: null,
    failedSignIns: 0,
    lockedUntil: null,
    ...overrides,
})

const passwordDeps = (overrides: Record<string, unknown> = {}) => ({
    findByEmail: vi.fn(async () => client()),
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
    burnTime: vi.fn(async () => {}),
    rehash: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 'session1' })),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

const input = { email: 'ann@example.com', password: 'correct horse battery', userAgent: 'Firefox' }

describe('passwordStep', () => {
    it('creates a pending session and sends a set-up client to the code step', async () => {
        const deps = passwordDeps()
        const result = await passwordStep(input, deps)

        expect(result).toEqual({ ok: true, next: 'code', token: 'raw-token', expiresAt: new Date('2026-09-20T10:10:00Z') })
        // Stored hashed, never raw
        expect(deps.createSession).toHaveBeenCalledWith('cl_ABCDEFGH', 'hashed:raw-token', expect.any(Date), 'Firefox')
    })

    it('sends a client with no authenticator to enrolment instead', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ totpConfirmedAt: null })) })
        expect(await passwordStep(input, deps)).toMatchObject({ ok: true, next: 'setup' })
    })

    // The expensive path must sit behind the cheap one, or the form is a memory lever
    it('checks the IP limit before hashing anything', async () => {
        const order: string[] = []
        const deps = passwordDeps({
            countAttempts: vi.fn(async () => { order.push('count'); return 99 }),
            verifyPassword: vi.fn(async () => { order.push('hash'); return { ok: true, needsRehash: false } }),
            burnTime: vi.fn(async () => { order.push('hash') }),
        })

        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: TOO_MANY_ERROR })
        expect(order).toEqual(['count'])
    })

    // A missing account and a wrong password must be indistinguishable, in answer and in timing
    it('burns hashing time when the email is unknown, and gives the same message as a wrong password', async () => {
        const unknown = passwordDeps({ findByEmail: vi.fn(async () => null) })
        const wrong = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })

        expect(await passwordStep(input, unknown)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(await passwordStep(input, wrong)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(unknown.burnTime).toHaveBeenCalled()
    })

    it('gives the same message for an invited client who has not set a password', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ passwordHash: null })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(deps.burnTime).toHaveBeenCalled()
    })

    it('gives the same message for a suspended client, even with the right password', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ suspendedAt: now })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
        expect(deps.createSession).not.toHaveBeenCalled()
    })

    // Revealed only to someone who already has the password, so it enumerates nothing
    it('tells a locked client it is locked once the password is right', async () => {
        const deps = passwordDeps({ findByEmail: vi.fn(async () => client({ lockedUntil: new Date('2026-09-20T10:05:00Z') })) })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: LOCKED_ERROR })
    })

    it('keeps the vague message for a locked client when the password is wrong', async () => {
        const deps = passwordDeps({
            findByEmail: vi.fn(async () => client({ lockedUntil: new Date('2026-09-20T10:05:00Z') })),
            verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })),
        })
        expect(await passwordStep(input, deps)).toEqual({ ok: false, error: GENERIC_ERROR })
    })

    it('records the attempt and the failure when the password is wrong', async () => {
        const deps = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })
        await passwordStep(input, deps)
        expect(deps.recordAttempt).toHaveBeenCalledWith(expect.any(String))
        expect(deps.recordFailure).toHaveBeenCalledWith('cl_ABCDEFGH', { failedSignIns: 1, lockedUntil: null })
    })

    it('upgrades a hash stored at an old cost, without making the client do anything', async () => {
        const deps = passwordDeps({ verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: true })) })
        await passwordStep(input, deps)
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
    })

    // The password step must never finish a sign-in on its own
    it('never marks the second factor as done', async () => {
        const deps = passwordDeps()
        await passwordStep(input, deps)
        expect(deps).not.toHaveProperty('completeMfa')
    })
})

const session = { id: 'session1', createdAt: now, client: client() } as never

const codeDeps = (overrides: Record<string, unknown> = {}) => ({
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    unusedRecoveryCodes: vi.fn(async () => [{ id: 'code1', codeHash: 'hash1' }]),
    recoveryCodeMatches: vi.fn(() => false),
    useRecoveryCode: vi.fn(async () => {}),
    completeMfa: vi.fn(async () => {}),
    recordSuccess: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('codeStep', () => {
    it('accepts a valid code, finishes the session and records the step against replay', async () => {
        const deps = codeDeps()
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: true })
        expect(deps.recordTotpUse).toHaveBeenCalledWith('cl_ABCDEFGH', 37037036n)
        expect(deps.completeMfa).toHaveBeenCalled()
        expect(deps.recordSuccess).toHaveBeenCalledWith('cl_ABCDEFGH', now)
        expect(deps.prune).toHaveBeenCalled()
    })

    it('refuses a code whose step was already used, and does not finish the session', async () => {
        const deps = codeDeps({ recordTotpUse: vi.fn(async () => false) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: REPLAYED_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
    })

    it('accepts a recovery code when the authenticator code does not match, and spends it', async () => {
        const deps = codeDeps({ verifyTotp: vi.fn(() => null), recoveryCodeMatches: vi.fn(() => true) })
        expect(await codeStep({ session, code: 'ABCDE-FGHJK' }, deps)).toEqual({ ok: true })
        expect(deps.useRecoveryCode).toHaveBeenCalledWith('code1', now)
        expect(deps.completeMfa).toHaveBeenCalled()
    })

    it('refuses when neither reading matches, and counts the failure', async () => {
        const deps = codeDeps({ verifyTotp: vi.fn(() => null) })
        expect(await codeStep({ session, code: '000000' }, deps)).toEqual({ ok: false, error: CODE_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
        expect(deps.recordFailure).toHaveBeenCalled()
    })

    // A secret that will not decrypt means the key is wrong. Refuse, never fall through to "no second factor".
    it('refuses rather than letting anyone past when the secret cannot be decrypted', async () => {
        const deps = codeDeps({ decryptSecret: vi.fn(() => { throw new Error('bad key') }) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: CODE_ERROR })
        expect(deps.completeMfa).not.toHaveBeenCalled()
        expect(deps.log).toHaveBeenCalled()
    })

    it('refuses over the IP limit without touching the secret', async () => {
        const deps = codeDeps({ countAttempts: vi.fn(async () => 99) })
        expect(await codeStep({ session, code: '123456' }, deps)).toEqual({ ok: false, error: TOO_MANY_ERROR })
        expect(deps.decryptSecret).not.toHaveBeenCalled()
    })
})

// The test the whole design rests on
describe('the only ways to finish a sign-in', () => {
    it('completes the second factor only after a verified code or a spent recovery code', async () => {
        const good = codeDeps()
        await codeStep({ session, code: '123456' }, good)
        expect(good.completeMfa).toHaveBeenCalledTimes(1)

        const recovery = codeDeps({ verifyTotp: vi.fn(() => null), recoveryCodeMatches: vi.fn(() => true) })
        await codeStep({ session, code: 'ABCDE-FGHJK' }, recovery)
        expect(recovery.completeMfa).toHaveBeenCalledTimes(1)

        for (const deps of [
            codeDeps({ verifyTotp: vi.fn(() => null) }),
            codeDeps({ recordTotpUse: vi.fn(async () => false) }),
            codeDeps({ countAttempts: vi.fn(async () => 99) }),
            codeDeps({ decryptSecret: vi.fn(() => { throw new Error('bad key') }) }),
        ]) {
            await codeStep({ session, code: '123456' }, deps)
            expect(deps.completeMfa).not.toHaveBeenCalled()
        }
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/signIn.test.ts
```

Expected: FAIL, cannot resolve `./signIn`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/signIn.ts`:

```ts
// Signing a client in, in two steps. Dependencies are passed in so every rule below can be tested without a
// database, a clock or a relay, in the style of server/quotes/submit.ts.

import 'server-only'

import { normaliseRecoveryCode } from './ids'
import { afterFailure, ipWindowStart, isLocked, overIpLimit, type LockUpdate } from './limits'
import type { ClientRecord, SessionWithClient } from './repo'
import { activeExpiry, pendingExpiry } from './session'

// Deliberately vague, and deliberately the same for a wrong password, an unknown address, a suspended account
// and an account that has not finished setup. None of those may be distinguishable from outside.
export const GENERIC_ERROR = 'Those details are not right, or the account is not ready yet.'
export const TOO_MANY_ERROR = 'Too many attempts. Please try again in a few minutes.'
// Only ever shown to someone who already supplied the correct password, so it enumerates nothing
export const LOCKED_ERROR = 'This account is locked for a short while. Please try again later.'
export const CODE_ERROR = 'That code is not right. Check your authenticator app, or use a recovery code.'
export const REPLAYED_ERROR = 'That code has already been used. Wait for the next one.'

export type PasswordStepDeps = {
    findByEmail(email: string): Promise<ClientRecord | null>
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    recordFailure(id: string, update: LockUpdate): Promise<void>
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    burnTime(): Promise<void>
    rehash(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    createSession(clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<{ id: string }>
    newToken(): string
    hashToken(token: string): string
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export type PasswordStepResult =
    | { ok: true, next: 'code' | 'setup', token: string, expiresAt: Date }
    | { ok: false, error: string }

export async function passwordStep(
    input: { email: string, password: string, userAgent: string | null },
    deps: PasswordStepDeps,
): Promise<PasswordStepResult> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'

    // First, because hashing is the expensive path and this is the cheap one. The other order would make the
    // form a way to make the server allocate 134 MB per request.
    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { ok: false, error: TOO_MANY_ERROR }

    const client = await deps.findByEmail(input.email)

    // No account, or an account that never finished setup: burn the same work anyway, so the answer and the
    // timing are the same as a wrong password and the form can't be used to discover who the clients are.
    if (!client?.passwordHash) {
        await deps.burnTime()
        await deps.recordAttempt(ipHash)
        return { ok: false, error: GENERIC_ERROR }
    }

    const { ok, needsRehash } = await deps.verifyPassword(input.password, client.passwordHash)
    if (!ok) {
        await deps.recordAttempt(ipHash)
        await deps.recordFailure(client.id, afterFailure(client, now))
        return { ok: false, error: GENERIC_ERROR }
    }

    // Everything below here is only reachable with the correct password, so it can be specific without
    // telling a stranger anything.
    if (client.suspendedAt) return { ok: false, error: GENERIC_ERROR }
    if (isLocked(client, now)) return { ok: false, error: LOCKED_ERROR }

    // The cost parameters travel with the hash, so an upgrade costs the client nothing and happens silently
    if (needsRehash) {
        try {
            await deps.setPassword(client.id, await deps.rehash(input.password), now)
        } catch (error) {
            // A failed upgrade must never be a failed sign-in
            deps.log(`Rehashing the password for ${client.id} failed`, error)
        }
    }

    const token = deps.newToken()
    const expiresAt = pendingExpiry(now)
    // mfaAt stays null: this creates a session that can reach the second factor and nothing else
    await deps.createSession(client.id, deps.hashToken(token), expiresAt, input.userAgent)
    return { ok: true, next: client.totpConfirmedAt ? 'code' : 'setup', token, expiresAt }
}

export type CodeStepDeps = {
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    recordFailure(id: string, update: LockUpdate): Promise<void>
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    unusedRecoveryCodes(clientId: string): Promise<{ id: string, codeHash: string }[]>
    recoveryCodeMatches(normalised: string, storedHash: string): boolean
    useRecoveryCode(id: string, now: Date): Promise<void>
    completeMfa(sessionId: string, mfaAt: Date, expiresAt: Date): Promise<void>
    recordSuccess(id: string, now: Date): Promise<void>
    prune(clientId: string, now: Date): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export async function codeStep(
    input: { session: SessionWithClient, code: string },
    deps: CodeStepDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'
    const { session } = input
    const client = session.client

    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { ok: false, error: TOO_MANY_ERROR }

    const finish = async () => {
        await deps.completeMfa(session.id, now, activeExpiry(session.createdAt, now))
        await deps.recordSuccess(client.id, now)
        // Lazily, here, because a successful sign-in is the only moment those tables grow
        await deps.prune(client.id, now)
        return { ok: true } as const
    }

    const fail = async (error: string) => {
        await deps.recordAttempt(ipHash)
        await deps.recordFailure(client.id, afterFailure(client, now))
        return { ok: false, error } as const
    }

    if (client.totpSecret) {
        let secret: Buffer
        try {
            secret = deps.decryptSecret(client.totpSecret)
        } catch (error) {
            // The key is wrong or the row was tampered with. Refuse: never fall through to treating the client
            // as having no second factor.
            deps.log(`The stored TOTP secret for ${client.id} could not be read`, error)
            return { ok: false, error: CODE_ERROR }
        }

        const step = deps.verifyTotp(secret, input.code, now)
        if (step !== null) {
            // The unique key refuses a replay, so there is no window between checking and recording
            if (!await deps.recordTotpUse(client.id, step)) return { ok: false, error: REPLAYED_ERROR }
            return finish()
        }
    }

    // One box takes both, so fall back to reading it as a recovery code
    const normalised = normaliseRecoveryCode(input.code)
    if (normalised.length > 0) {
        for (const candidate of await deps.unusedRecoveryCodes(client.id)) {
            if (deps.recoveryCodeMatches(normalised, candidate.codeHash)) {
                await deps.useRecoveryCode(candidate.id, now)
                return finish()
            }
        }
    }

    return fail(CODE_ERROR)
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/signIn.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add server/clients/signIn.ts server/clients/signIn.test.ts
git commit -F - <<'MSG'
Add the two-step client sign-in

The IP limit is checked before any hashing, because scrypt at these
parameters allocates 134 MB and the other order would turn the form into
a memory lever. An unknown address burns the same work as a wrong
password, so the two cannot be told apart by answer or by timing.

The spec asked for one vague message everywhere and also for a locked
account to be told it is locked, which cannot both hold: naming the lock
reveals the account exists. The lock is now revealed only to someone who
has already supplied the correct password, so nothing is enumerable and
a real client still learns why they cannot get in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 13: Invite completion and authenticator enrolment

**Files:**
- Create: `server/clients/setup.ts`
- Test: `server/clients/setup.test.ts`

**Interfaces:**
- Consumes: `./ids`, `./totp`, `./session`, `ClientRecord` and `SessionWithClient` from `./repo`.
- Produces:
  - `INVITE_TTL_MS` (7 days), `RESET_TTL_MS` (1 hour), `RECOVERY_CODE_COUNT` (10)
  - `tokenProblem(token: TokenRecord | null, expected: ClientTokenPurpose, now: Date): string | null`, where `TokenRecord = { purpose, usedAt, expiresAt, client: { suspendedAt } }`
  - `completeInvite(input: { tokenHash: string, password: string, userAgent: string | null }, deps: CompleteInviteDeps): Promise<{ ok: true, token: string, expiresAt: Date } | { ok: false, error: string }>`
  - `beginEnrolment(client: ClientRecord, deps: BeginEnrolmentDeps): Promise<{ uri: string, typed: string }>`
  - `confirmEnrolment(input: { session: SessionWithClient, code: string }, deps: ConfirmEnrolmentDeps): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }>`
  - `acknowledgeRecoveryCodes(session: SessionWithClient, deps: AcknowledgeDeps): Promise<void>`
  - `LINK_ERROR` (string)

- [ ] **Step 1: Write the failing test**

Create `server/clients/setup.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { LINK_ERROR, acknowledgeRecoveryCodes, beginEnrolment, completeInvite, confirmEnrolment, tokenProblem } from './setup'

const now = new Date('2026-09-20T10:00:00Z')
const later = (ms: number) => new Date(now.getTime() + ms)

const client = (overrides: Record<string, unknown> = {}) => ({
    id: 'cl_ABCDEFGH', email: 'ann@example.com', totpSecret: null, totpConfirmedAt: null, suspendedAt: null, ...overrides,
})

describe('tokenProblem', () => {
    const good = { purpose: 'INVITE' as const, usedAt: null, expiresAt: later(1000), client: { suspendedAt: null } }

    it('accepts a live, unused token for an active client', () => {
        expect(tokenProblem(good, 'INVITE', now)).toBeNull()
    })

    // Without this, a reset link (which arrives by email and needs no second factor at the invite endpoint)
    // could be spent to change a password, which is what the spec forbids
    it('refuses a reset token offered to the invite flow', () => {
        expect(tokenProblem({ ...good, purpose: 'PASSWORD_RESET' as const }, 'INVITE', now)).toBe(LINK_ERROR)
        expect(tokenProblem(good, 'PASSWORD_RESET', now)).toBe(LINK_ERROR)
    })

    // One message for every case, so the page can't be used to probe which tokens exist
    it.each([
        ['missing', null],
        ['used', { ...good, usedAt: now }],
        ['expired', { ...good, expiresAt: later(-1000) }],
        ['for a suspended client', { ...good, client: { suspendedAt: now } }],
    ])('refuses a %s token with the same message', (unused, token) => {
        expect(tokenProblem(token as never, 'INVITE', now)).toBe(LINK_ERROR)
    })
})

const inviteDeps = (overrides: Record<string, unknown> = {}) => ({
    tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'INVITE' as const, usedAt: null, expiresAt: later(1000), client: client() })),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    useToken: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 'session1' })),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('completeInvite', () => {
    it('sets the password, spends the token and opens a session that still needs the second factor', async () => {
        const deps = inviteDeps()
        const result = await completeInvite({ tokenHash: 'h', password: 'correct horse battery', userAgent: null }, deps)

        expect(result).toMatchObject({ ok: true, token: 'raw-token' })
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
        expect(deps.useToken).toHaveBeenCalledWith('token1', now)
        // mfaAt is not set anywhere in this flow: enrolment is still ahead
        expect(deps.createSession).toHaveBeenCalledWith('cl_ABCDEFGH', 'hashed:raw-token', expect.any(Date), null)
    })

    it('refuses a spent token and changes nothing', async () => {
        const deps = inviteDeps({
            tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'INVITE' as const, usedAt: now, expiresAt: later(1000), client: client() })),
        })
        expect(await completeInvite({ tokenHash: 'h', password: 'correct horse battery', userAgent: null }, deps))
            .toEqual({ ok: false, error: LINK_ERROR })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })
})

describe('beginEnrolment', () => {
    it('stores the new secret encrypted but unconfirmed, and hands back the URI and the typed form', async () => {
        const storeSecret = vi.fn(async () => {})
        const result = await beginEnrolment(client() as never, {
            newSecret: () => Buffer.from('12345678901234567890'),
            encryptSecret: (plain: string) => `encrypted:${plain}`,
            storeSecret,
            now: () => now,
        })

        expect(result.uri).toContain('otpauth://totp/Horizons%3Aann%40example.com')
        expect(result.typed).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
        // Stored straight away so a page reload doesn't strand a half-scanned QR code. Harmless: sign-in needs
        // totpConfirmedAt, and a session needs mfaAt, neither of which this sets.
        expect(storeSecret).toHaveBeenCalled()
    })
})

const session = { id: 'session1', createdAt: now, client: client({ totpSecret: 'encrypted' }) } as never

const confirmDeps = (overrides: Record<string, unknown> = {}) => ({
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    confirmTotp: vi.fn(async () => {}),
    newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
    hashRecoveryCode: vi.fn((code: string) => `hashed:${code}`),
    replaceRecoveryCodes: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('confirmEnrolment', () => {
    it('confirms the authenticator and returns ten codes, once', async () => {
        const deps = confirmDeps()
        const result = await confirmEnrolment({ session, code: '123456' }, deps)

        expect(result).toMatchObject({ ok: true })
        expect((result as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10)
        expect(deps.confirmTotp).toHaveBeenCalledWith('cl_ABCDEFGH', now)
        expect(deps.replaceRecoveryCodes).toHaveBeenCalledWith('cl_ABCDEFGH', expect.arrayContaining(['hashed:ABCDE-FGHJK']))
    })

    it('refuses a wrong code and confirms nothing', async () => {
        const deps = confirmDeps({ verifyTotp: vi.fn(() => null) })
        expect(await confirmEnrolment({ session, code: '000000' }, deps)).toMatchObject({ ok: false })
        expect(deps.confirmTotp).not.toHaveBeenCalled()
        expect(deps.replaceRecoveryCodes).not.toHaveBeenCalled()
    })

    it('refuses when there is no secret to confirm against', async () => {
        const noSecret = { ...session, client: client() } as never
        const deps = confirmDeps()
        expect(await confirmEnrolment({ session: noSecret, code: '123456' }, deps)).toMatchObject({ ok: false })
    })
})

describe('acknowledgeRecoveryCodes', () => {
    // This is the third and last place mfaAt is written, and it is reachable only after confirmEnrolment
    it('is what finally makes the session usable', async () => {
        const completeMfa = vi.fn(async () => {})
        await acknowledgeRecoveryCodes(session, { completeMfa, recordSuccess: vi.fn(async () => {}), now: () => now })
        expect(completeMfa).toHaveBeenCalledWith('session1', now, expect.any(Date))
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/setup.test.ts
```

Expected: FAIL, cannot resolve `./setup`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/setup.ts`:

```ts
// Turning an invite into a working account: set a password, enrol an authenticator, save the recovery codes.
// Leaving halfway is safe by construction, because none of these steps on its own produces a usable session.

import 'server-only'

import type { ClientTokenPurpose } from '../generated/prisma/client'
import type { ClientRecord, SessionWithClient } from './repo'
import { activeExpiry, pendingExpiry } from './session'
import { formatSecretForTyping, otpauthUri } from './totp'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 60 * 60 * 1000
export const RECOVERY_CODE_COUNT = 10

// One message for expired, used, unknown and suspended. Distinguishing them would turn the page into a way to
// probe which tokens exist.
export const LINK_ERROR = 'That link is no longer valid. Ask Koda for a new one.'

type TokenRecord = { purpose: ClientTokenPurpose, usedAt: Date | null, expiresAt: Date, client: { suspendedAt: Date | null } }

export function tokenProblem(token: TokenRecord | null, expected: ClientTokenPurpose, now: Date): string | null {
    if (!token) return LINK_ERROR
    // Checked, because an invite is redeemed without a second factor and a reset is not. Without this, a reset
    // link could be spent at the invite endpoint, and a compromised mailbox alone would be enough to change a
    // client's password and lock the real one out.
    if (token.purpose !== expected) return LINK_ERROR
    if (token.usedAt) return LINK_ERROR
    if (token.expiresAt.getTime() <= now.getTime()) return LINK_ERROR
    if (token.client.suspendedAt) return LINK_ERROR
    return null
}

export type CompleteInviteDeps = {
    tokenByHash(tokenHash: string): Promise<({ id: string } & TokenRecord & { client: ClientRecord }) | null>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    useToken(id: string, now: Date): Promise<void>
    createSession(clientId: string, tokenHash: string, expiresAt: Date, userAgent: string | null): Promise<{ id: string }>
    newToken(): string
    hashToken(token: string): string
    now(): Date
    log(message: string, error?: unknown): void
}

export async function completeInvite(
    input: { tokenHash: string, password: string, userAgent: string | null },
    deps: CompleteInviteDeps,
): Promise<{ ok: true, token: string, expiresAt: Date } | { ok: false, error: string }> {
    const now = deps.now()
    const token = await deps.tokenByHash(input.tokenHash)
    const problem = tokenProblem(token, 'INVITE', now)
    if (problem || !token) return { ok: false, error: problem ?? LINK_ERROR }

    await deps.setPassword(token.client.id, await deps.hashPassword(input.password), now)
    await deps.useToken(token.id, now)

    // Still pending: mfaAt is not set here, so this session can reach enrolment and nothing else
    const sessionToken = deps.newToken()
    const expiresAt = pendingExpiry(now)
    await deps.createSession(token.client.id, deps.hashToken(sessionToken), expiresAt, input.userAgent)
    return { ok: true, token: sessionToken, expiresAt }
}

export type BeginEnrolmentDeps = {
    newSecret(): Buffer
    encryptSecret(plaintext: string): string
    storeSecret(id: string, encrypted: string): Promise<void>
    now(): Date
}

// Stores the secret straight away, unconfirmed, so reloading the page doesn't strand a half-scanned QR code.
// Harmless: sign-in needs totpConfirmedAt and a usable session needs mfaAt, and this sets neither.
export async function beginEnrolment(client: ClientRecord, deps: BeginEnrolmentDeps): Promise<{ uri: string, typed: string }> {
    const secret = deps.newSecret()
    await deps.storeSecret(client.id, deps.encryptSecret(secret.toString('base64')))
    return { uri: otpauthUri({ secret, email: client.email }), typed: formatSecretForTyping(secret) }
}

export type ConfirmEnrolmentDeps = {
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    confirmTotp(id: string, now: Date): Promise<void>
    newRecoveryCode(): string
    hashRecoveryCode(code: string): string
    replaceRecoveryCodes(clientId: string, codeHashes: string[]): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

const WRONG_CODE = 'That code is not right. Check the app and try the next one.'

export async function confirmEnrolment(
    input: { session: SessionWithClient, code: string },
    deps: ConfirmEnrolmentDeps,
): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }> {
    const now = deps.now()
    const client = input.session.client
    if (!client.totpSecret) return { ok: false, error: WRONG_CODE }

    let secret: Buffer
    try {
        secret = deps.decryptSecret(client.totpSecret)
    } catch (error) {
        deps.log(`The pending TOTP secret for ${client.id} could not be read`, error)
        return { ok: false, error: WRONG_CODE }
    }

    const step = deps.verifyTotp(secret, input.code, now)
    if (step === null) return { ok: false, error: WRONG_CODE }
    // The enrolling code is spent like any other, so it can't be replayed at the sign-in page
    if (!await deps.recordTotpUse(client.id, step)) return { ok: false, error: WRONG_CODE }

    await deps.confirmTotp(client.id, now)

    // Generated once and shown once. Only the keyed hashes are kept.
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => deps.newRecoveryCode())
    await deps.replaceRecoveryCodes(client.id, recoveryCodes.map(code => deps.hashRecoveryCode(code)))
    return { ok: true, recoveryCodes }
}

export type AcknowledgeDeps = {
    completeMfa(sessionId: string, mfaAt: Date, expiresAt: Date): Promise<void>
    recordSuccess(id: string, now: Date): Promise<void>
    now(): Date
}

// The third and last place mfaAt is written, and reachable only once confirmEnrolment has succeeded
export async function acknowledgeRecoveryCodes(session: SessionWithClient, deps: AcknowledgeDeps): Promise<void> {
    const now = deps.now()
    await deps.completeMfa(session.id, now, activeExpiry(session.createdAt, now))
    await deps.recordSuccess(session.client.id, now)
}

```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/setup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/clients/setup.ts server/clients/setup.test.ts
git commit -F - <<'MSG'
Add invite completion and authenticator enrolment

Leaving halfway is safe by construction: setting a password produces a
session that can reach enrolment and nothing else, and only saving the
recovery codes makes it usable.

The pending secret is stored unconfirmed so reloading does not strand a
half-scanned QR code, which is harmless because sign-in needs
totpConfirmedAt and a usable session needs mfaAt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 14: Forgot password and reset

**Files:**
- Create: `server/clients/reset.ts`
- Test: `server/clients/reset.test.ts`

**Interfaces:**
- Consumes: `./setup` (`tokenProblem`, `LINK_ERROR`, `RESET_TTL_MS`), `./limits`, `./ids`.
- Produces:
  - `RESET_SENT_MESSAGE` (string, shown whether or not the address exists)
  - `issueToken(deps: { newToken(): string, hashToken(token: string): string }): { token: string, tokenHash: string }`
  - `requestReset(input: { email: string }, deps: RequestResetDeps): Promise<{ message: string }>`
  - `completeReset(input: { tokenHash: string, password: string, code: string }, deps: CompleteResetDeps): Promise<{ ok: true } | { ok: false, error: string }>`

- [ ] **Step 1: Write the failing test**

Create `server/clients/reset.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { LINK_ERROR } from './setup'
import { RESET_SENT_MESSAGE, completeReset, requestReset } from './reset'

const now = new Date('2026-09-20T10:00:00Z')
const later = (ms: number) => new Date(now.getTime() + ms)

const client = (overrides: Record<string, unknown> = {}) => ({
    id: 'cl_ABCDEFGH', email: 'ann@example.com', totpSecret: 'encrypted',
    totpConfirmedAt: new Date('2026-09-01T00:00:00Z'), suspendedAt: null, failedSignIns: 0, lockedUntil: null, ...overrides,
})

const requestDeps = (overrides: Record<string, unknown> = {}) => ({
    findByEmail: vi.fn(async () => client()),
    countAttempts: vi.fn(async () => 0),
    recordAttempt: vi.fn(async () => {}),
    invalidateTokens: vi.fn(async () => {}),
    createToken: vi.fn(async () => {}),
    newToken: vi.fn(() => 'raw-token'),
    hashToken: vi.fn((token: string) => `hashed:${token}`),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendReset: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('requestReset', () => {
    it('sends a link and invalidates any earlier one', async () => {
        const deps = requestDeps()
        expect(await requestReset({ email: 'ann@example.com' }, deps)).toEqual({ message: RESET_SENT_MESSAGE })
        expect(deps.invalidateTokens).toHaveBeenCalledWith('cl_ABCDEFGH', 'PASSWORD_RESET', now)
        expect(deps.createToken).toHaveBeenCalledWith('cl_ABCDEFGH', 'PASSWORD_RESET', 'hashed:raw-token', later(60 * 60 * 1000))
    })

    // Identical answers, so the page cannot be used to find out who the clients are
    it.each([
        ['an unknown address', { findByEmail: vi.fn(async () => null) }],
        ['a suspended client', { findByEmail: vi.fn(async () => client({ suspendedAt: now })) }],
    ])('says the same thing for %s, and sends nothing', async (unused, overrides) => {
        const deps = requestDeps(overrides)
        expect(await requestReset({ email: 'ann@example.com' }, deps)).toEqual({ message: RESET_SENT_MESSAGE })
        expect(deps.createToken).not.toHaveBeenCalled()
        expect(deps.sendReset).not.toHaveBeenCalled()
    })

    // Sending inline would make a request for a real address measurably slower than one for an address that
    // does not exist, which would undo the point of the identical answer
    it('hands the email to after(), never awaiting the relay', async () => {
        const deps = requestDeps()
        await requestReset({ email: 'ann@example.com' }, deps)
        expect(deps.sendLater).toHaveBeenCalled()
    })

    it('counts every request against the IP limit, matched or not', async () => {
        const deps = requestDeps({ findByEmail: vi.fn(async () => null) })
        await requestReset({ email: 'nobody@example.com' }, deps)
        expect(deps.recordAttempt).toHaveBeenCalled()
    })

    it('refuses over the IP limit', async () => {
        const deps = requestDeps({ countAttempts: vi.fn(async () => 99) })
        await requestReset({ email: 'ann@example.com' }, deps)
        expect(deps.createToken).not.toHaveBeenCalled()
    })
})

const completeDeps = (overrides: Record<string, unknown> = {}) => ({
    tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000), client: client() })),
    decryptSecret: vi.fn(() => Buffer.from('12345678901234567890')),
    verifyTotp: vi.fn(() => 37037036n),
    recordTotpUse: vi.fn(async () => true),
    unusedRecoveryCodes: vi.fn(async () => []),
    recoveryCodeMatches: vi.fn(() => false),
    useRecoveryCode: vi.fn(async () => {}),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    useToken: vi.fn(async () => {}),
    deleteSessionsFor: vi.fn(async () => {}),
    clearLock: vi.fn(async () => {}),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendChanged: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

const input = { tokenHash: 'h', password: 'a brand new passphrase', code: '123456' }

describe('completeReset', () => {
    it('sets the password, spends the token and signs every session out', async () => {
        const deps = completeDeps()
        expect(await completeReset(input, deps)).toEqual({ ok: true })
        expect(deps.setPassword).toHaveBeenCalledWith('cl_ABCDEFGH', 'new-hash', now)
        expect(deps.useToken).toHaveBeenCalledWith('token1', now)
        // A reset is exactly the moment to end anything already signed in
        expect(deps.deleteSessionsFor).toHaveBeenCalledWith('cl_ABCDEFGH')
        expect(deps.sendChanged).toHaveBeenCalled()
    })

    // A compromised mailbox alone must not be enough to take the account
    it('refuses without a valid second factor, and changes nothing', async () => {
        const deps = completeDeps({ verifyTotp: vi.fn(() => null) })
        expect(await completeReset(input, deps)).toMatchObject({ ok: false })
        expect(deps.setPassword).not.toHaveBeenCalled()
    })

    // A client who never enrolled has no second factor to give, and is forced through enrolment afterwards anyway
    it('accepts the token alone when the client has no authenticator yet', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({
                id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(1000),
                client: client({ totpSecret: null, totpConfirmedAt: null }),
            })),
        })
        expect(await completeReset({ ...input, code: '' }, deps)).toEqual({ ok: true })
        expect(deps.setPassword).toHaveBeenCalled()
    })

    it('refuses an expired link with the same message as a missing one', async () => {
        const deps = completeDeps({
            tokenByHash: vi.fn(async () => ({ id: 'token1', purpose: 'PASSWORD_RESET' as const, usedAt: null, expiresAt: later(-1), client: client() })),
        })
        expect(await completeReset(input, deps)).toEqual({ ok: false, error: LINK_ERROR })
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/reset.test.ts
```

Expected: FAIL, cannot resolve `./reset`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/reset.ts`:

```ts
// Forgetting and resetting a password. The request side reveals nothing about who exists; the completion side
// still demands a second factor, so a compromised mailbox on its own is not enough to take an account.

import 'server-only'

import type { ClientTokenPurpose } from '../generated/prisma/client'
import { normaliseRecoveryCode } from './ids'
import { ipWindowStart, overIpLimit } from './limits'
import type { ClientRecord } from './repo'
import { LINK_ERROR, RESET_TTL_MS, tokenProblem } from './setup'

// Said whether or not the address matched anything
export const RESET_SENT_MESSAGE = 'If that address has an account, a reset link is on its way. It is valid for one hour.'

const CODE_REQUIRED = 'Enter the code from your authenticator app, or a recovery code.'

export const issueToken = (deps: { newToken(): string, hashToken(token: string): string }) => {
    const token = deps.newToken()
    return { token, tokenHash: deps.hashToken(token) }
}

export type RequestResetDeps = {
    findByEmail(email: string): Promise<ClientRecord | null>
    countAttempts(ipHash: string, since: Date): Promise<number>
    recordAttempt(ipHash: string): Promise<void>
    invalidateTokens(clientId: string, purpose: 'PASSWORD_RESET', now: Date): Promise<void>
    createToken(clientId: string, purpose: 'PASSWORD_RESET', tokenHash: string, expiresAt: Date): Promise<void>
    newToken(): string
    hashToken(token: string): string
    sendLater(task: () => Promise<void>): void
    sendReset(client: ClientRecord, token: string): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
    ipHash?: string
}

export async function requestReset(input: { email: string }, deps: RequestResetDeps): Promise<{ message: string }> {
    const now = deps.now()
    const ipHash = deps.ipHash ?? 'unknown'

    // Counted whether or not it matched: a request that finds nothing is not a failure the person can see, and
    // must still be bounded, or this becomes a way to send mail at someone else's expense
    await deps.recordAttempt(ipHash)
    if (overIpLimit(await deps.countAttempts(ipHash, ipWindowStart(now)))) return { message: RESET_SENT_MESSAGE }

    const client = await deps.findByEmail(input.email)
    if (client && !client.suspendedAt) {
        await deps.invalidateTokens(client.id, 'PASSWORD_RESET', now)
        const { token, tokenHash } = issueToken(deps)
        await deps.createToken(client.id, 'PASSWORD_RESET', tokenHash, new Date(now.getTime() + RESET_TTL_MS))
        // Handed to after(): sending inline would make a request for a real address measurably slower than one
        // for an address that doesn't exist, which would undo the point of the identical answer
        deps.sendLater(async () => {
            try {
                await deps.sendReset(client, token)
            } catch (error) {
                deps.log(`Sending the reset email for ${client.id} failed`, error)
            }
        })
    }

    return { message: RESET_SENT_MESSAGE }
}

export type CompleteResetDeps = {
    tokenByHash(tokenHash: string): Promise<({ id: string, purpose: ClientTokenPurpose, usedAt: Date | null, expiresAt: Date, client: ClientRecord }) | null>
    decryptSecret(stored: string): Buffer
    verifyTotp(secret: Buffer, code: string, now: Date): bigint | null
    recordTotpUse(clientId: string, step: bigint): Promise<boolean>
    unusedRecoveryCodes(clientId: string): Promise<{ id: string, codeHash: string }[]>
    recoveryCodeMatches(normalised: string, storedHash: string): boolean
    useRecoveryCode(id: string, now: Date): Promise<void>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    useToken(id: string, now: Date): Promise<void>
    deleteSessionsFor(clientId: string): Promise<void>
    clearLock(id: string): Promise<void>
    sendLater(task: () => Promise<void>): void
    sendChanged(client: ClientRecord): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

export async function completeReset(
    input: { tokenHash: string, password: string, code: string },
    deps: CompleteResetDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const now = deps.now()
    const token = await deps.tokenByHash(input.tokenHash)
    const problem = tokenProblem(token, 'PASSWORD_RESET', now)
    if (problem || !token) return { ok: false, error: problem ?? LINK_ERROR }

    const client = token.client

    // A client with an authenticator must use it: an email compromise alone must not be enough. A client who
    // has never enrolled has nothing to give, and is forced through enrolment before the session is usable.
    if (client.totpConfirmedAt && client.totpSecret) {
        const accepted = await acceptSecondFactor(client, input.code, deps, now)
        if (!accepted) return { ok: false, error: CODE_REQUIRED }
    }

    await deps.setPassword(client.id, await deps.hashPassword(input.password), now)
    await deps.useToken(token.id, now)
    // A reset is exactly the moment to end anything already signed in
    await deps.deleteSessionsFor(client.id)
    await deps.clearLock(client.id)

    deps.sendLater(async () => {
        try {
            await deps.sendChanged(client)
        } catch (error) {
            deps.log(`Sending the password-changed notice for ${client.id} failed`, error)
        }
    })

    return { ok: true }
}

async function acceptSecondFactor(client: ClientRecord, code: string, deps: CompleteResetDeps, now: Date): Promise<boolean> {
    if (client.totpSecret) {
        try {
            const step = deps.verifyTotp(deps.decryptSecret(client.totpSecret), code, now)
            if (step !== null) return deps.recordTotpUse(client.id, step)
        } catch (error) {
            deps.log(`The stored TOTP secret for ${client.id} could not be read`, error)
            return false
        }
    }
    const normalised = normaliseRecoveryCode(code)
    if (!normalised) return false
    for (const candidate of await deps.unusedRecoveryCodes(client.id)) {
        if (deps.recoveryCodeMatches(normalised, candidate.codeHash)) {
            await deps.useRecoveryCode(candidate.id, now)
            return true
        }
    }
    return false
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/reset.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/clients/reset.ts server/clients/reset.test.ts
git commit -F - <<'MSG'
Add forgot password and reset

The request answers identically whether or not the address exists, and
the email goes through after() rather than inline, because sending
inline would make a real address measurably slower to answer and undo
the point of the identical reply.

Completing a reset still demands a second factor, so a compromised
mailbox on its own cannot take an account. A client who has never
enrolled has nothing to give and is forced through enrolment afterwards.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 15: The client's own account actions

**Files:**
- Create: `server/clients/account.ts`
- Test: `server/clients/account.test.ts`

**Interfaces:**
- Consumes: `./repo`, `./ids`.
- Produces:
  - `changePassword(input: { client, sessionId, current: string, next: string }, deps: ChangePasswordDeps): Promise<{ ok: true } | { ok: false, error: string }>`
  - `regenerateRecoveryCodes(input: { client, password: string }, deps: RegenerateDeps): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }>`
  - `describeDevice(userAgent: string | null): string`
  - `WRONG_PASSWORD` (string)

- [ ] **Step 1: Write the failing test**

Create `server/clients/account.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { WRONG_PASSWORD, changePassword, describeDevice, regenerateRecoveryCodes } from './account'

const now = new Date('2026-09-20T10:00:00Z')
const client = { id: 'cl_ABCDEFGH', email: 'ann@example.com', passwordHash: 'stored' } as never

const changeDeps = (overrides: Record<string, unknown> = {}) => ({
    verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
    hashPassword: vi.fn(async () => 'new-hash'),
    setPassword: vi.fn(async () => {}),
    deleteSessionsFor: vi.fn(async () => {}),
    sendLater: vi.fn((task: () => Promise<void>) => { void task() }),
    sendChanged: vi.fn(async () => {}),
    now: () => now,
    log: vi.fn(),
    ...overrides,
})

describe('changePassword', () => {
    // Every other session goes, and the one doing the changing stays, so nobody signs themselves out
    it('keeps the current session and drops the others', async () => {
        const deps = changeDeps()
        expect(await changePassword({ client, sessionId: 'session1', current: 'old one', next: 'a new passphrase' }, deps))
            .toEqual({ ok: true })
        expect(deps.deleteSessionsFor).toHaveBeenCalledWith('cl_ABCDEFGH', 'session1')
        expect(deps.sendChanged).toHaveBeenCalled()
    })

    it('refuses when the current password is wrong, and changes nothing', async () => {
        const deps = changeDeps({ verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })) })
        expect(await changePassword({ client, sessionId: 'session1', current: 'wrong', next: 'a new passphrase' }, deps))
            .toEqual({ ok: false, error: WRONG_PASSWORD })
        expect(deps.setPassword).not.toHaveBeenCalled()
        expect(deps.deleteSessionsFor).not.toHaveBeenCalled()
    })
})

describe('regenerateRecoveryCodes', () => {
    it('replaces the whole set after the password is confirmed', async () => {
        const deps = {
            verifyPassword: vi.fn(async () => ({ ok: true, needsRehash: false })),
            newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
            hashRecoveryCode: vi.fn((code: string) => `hashed:${code}`),
            replaceRecoveryCodes: vi.fn(async () => {}),
        }
        const result = await regenerateRecoveryCodes({ client, password: 'right' }, deps)
        expect((result as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10)
        expect(deps.replaceRecoveryCodes).toHaveBeenCalled()
    })

    it('refuses without the password', async () => {
        const deps = {
            verifyPassword: vi.fn(async () => ({ ok: false, needsRehash: false })),
            newRecoveryCode: vi.fn(() => 'ABCDE-FGHJK'),
            hashRecoveryCode: vi.fn((code: string) => code),
            replaceRecoveryCodes: vi.fn(async () => {}),
        }
        expect(await regenerateRecoveryCodes({ client, password: 'wrong' }, deps)).toEqual({ ok: false, error: WRONG_PASSWORD })
        expect(deps.replaceRecoveryCodes).not.toHaveBeenCalled()
    })
})

describe('describeDevice', () => {
    it.each([
        ['Mozilla/5.0 (Windows NT 10.0) Firefox/130.0', 'Firefox on Windows'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
        ['Mozilla/5.0 (Macintosh) Chrome/128.0 Safari/537.36', 'Chrome on macOS'],
    ])('reads %j as %j', (userAgent, expected) => {
        expect(describeDevice(userAgent)).toBe(expected)
    })

    it('falls back rather than showing a raw user agent string', () => {
        expect(describeDevice(null)).toBe('Unknown device')
        expect(describeDevice('something else entirely')).toBe('Unknown device')
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/account.test.ts
```

Expected: FAIL, cannot resolve `./account`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/account.ts`:

```ts
// What a client can do to their own account.

import 'server-only'

import type { ClientRecord } from './repo'
import { RECOVERY_CODE_COUNT } from './setup'

export const WRONG_PASSWORD = 'That password is not right.'

export type ChangePasswordDeps = {
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    hashPassword(password: string): Promise<string>
    setPassword(id: string, passwordHash: string, now: Date): Promise<void>
    deleteSessionsFor(clientId: string, exceptId?: string): Promise<void>
    sendLater(task: () => Promise<void>): void
    sendChanged(client: ClientRecord): Promise<void>
    now(): Date
    log(message: string, error?: unknown): void
}

export async function changePassword(
    input: { client: ClientRecord, sessionId: string, current: string, next: string },
    deps: ChangePasswordDeps,
): Promise<{ ok: true } | { ok: false, error: string }> {
    const { client } = input
    if (!client.passwordHash) return { ok: false, error: WRONG_PASSWORD }
    const { ok } = await deps.verifyPassword(input.current, client.passwordHash)
    if (!ok) return { ok: false, error: WRONG_PASSWORD }

    const now = deps.now()
    await deps.setPassword(client.id, await deps.hashPassword(input.next), now)
    // Everywhere else signs out, and the session doing the changing stays, so nobody signs themselves out
    await deps.deleteSessionsFor(client.id, input.sessionId)

    deps.sendLater(async () => {
        try {
            await deps.sendChanged(client)
        } catch (error) {
            deps.log(`Sending the password-changed notice for ${client.id} failed`, error)
        }
    })

    return { ok: true }
}

export type RegenerateDeps = {
    verifyPassword(password: string, stored: string): Promise<{ ok: boolean, needsRehash: boolean }>
    newRecoveryCode(): string
    hashRecoveryCode(code: string): string
    replaceRecoveryCodes(clientId: string, codeHashes: string[]): Promise<void>
}

export async function regenerateRecoveryCodes(
    input: { client: ClientRecord, password: string },
    deps: RegenerateDeps,
): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: string }> {
    const { client } = input
    if (!client.passwordHash) return { ok: false, error: WRONG_PASSWORD }
    const { ok } = await deps.verifyPassword(input.password, client.passwordHash)
    if (!ok) return { ok: false, error: WRONG_PASSWORD }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => deps.newRecoveryCode())
    // Replacing invalidates the old set, which is the whole point of offering it
    await deps.replaceRecoveryCodes(client.id, recoveryCodes.map(code => deps.hashRecoveryCode(code)))
    return { ok: true, recoveryCodes }
}

// Enough for a client to recognise their own sessions. Deliberately not a parsed user agent library and
// deliberately never the raw string, which is noise to everyone who is not a developer.
export function describeDevice(userAgent: string | null): string {
    if (!userAgent) return 'Unknown device'
    const browser = /Edg\//.test(userAgent) ? 'Edge'
        : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari'
        : null
    const platform = /iPhone/.test(userAgent) ? 'iPhone'
        : /iPad/.test(userAgent) ? 'iPad'
        : /Android/.test(userAgent) ? 'Android'
        : /Windows/.test(userAgent) ? 'Windows'
        : /Macintosh|Mac OS X/.test(userAgent) ? 'macOS'
        : /Linux/.test(userAgent) ? 'Linux'
        : null
    if (!browser || !platform) return 'Unknown device'
    return `${browser} on ${platform}`
}

```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/account.test.ts
```

Expected: PASS. If the iPhone case fails, check the browser tests run before the platform tests: an iPhone's user agent contains both `Safari/` and `Version/`, and Chrome's contains `Safari/` too, which is why Chrome is tested before Safari.

- [ ] **Step 5: Commit**

```bash
git add server/clients/account.ts server/clients/account.test.ts
git commit -F - <<'MSG'
Let a client change their password and refresh their recovery codes

Changing a password signs out everywhere except the session doing the
changing, so nobody signs themselves out by tidying up.

Sessions are described as "Firefox on Windows" rather than by their raw
user agent, which is noise to everyone who is not a developer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 16: The client emails

**Files:**
- Create: `server/clients/emails.ts`
- Test: `server/clients/emails.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `server/quotes/emails`, `ClientMailConfig` from `server/env`.
- Produces: `inviteEmail`, `resetEmail`, `passwordChangedEmail`, `twoFactorResetEmail`, `emailChangedEmail`, each `(client, options) => Email`, reusing the `Email` type from `server/quotes/emails`.

- [ ] **Step 1: Write the failing test**

Create `server/clients/emails.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { emailChangedEmail, inviteEmail, passwordChangedEmail, resetEmail, twoFactorResetEmail } from './emails'

const options = { from: 'Horizons <quotes@dev.horizons.gg>', replyTo: 'info@dev.horizons.gg', siteUrl: 'https://www.horizons.gg' }
const client = { name: 'Ann Example', email: 'ann@example.com' }

describe('inviteEmail', () => {
    const email = inviteEmail(client, 'raw-token', options)

    it('carries the link, the expiry and the warning about an authenticator app', () => {
        expect(email.text).toContain('https://www.horizons.gg/portal/invite/raw-token')
        expect(email.text).toContain('7 days')
        expect(email.text.toLowerCase()).toContain('authenticator')
    })

    it('goes to the client and replies to the support address', () => {
        expect(email.to).toBe('ann@example.com')
        expect(email.replyTo).toBe('info@dev.horizons.gg')
    })
})

describe('resetEmail', () => {
    const email = resetEmail(client, 'raw-token', options)

    it('carries the link and its one hour expiry', () => {
        expect(email.text).toContain('https://www.horizons.gg/portal/reset/raw-token')
        expect(email.text).toContain('one hour')
    })

    it('tells them what to do if they did not ask', () => {
        expect(email.text.toLowerCase()).toContain("didn't ask")
    })
})

describe('the notices', () => {
    // No link at all, so a notice about a security change can never itself be the phishing vector
    it.each([
        ['password changed', passwordChangedEmail(client, options)],
        ['two factor reset', twoFactorResetEmail(client, options)],
    ])('%s carries no link', (unused, email) => {
        expect(email.text).not.toContain('http')
        expect(email.html).not.toContain('href')
    })

    it('tells the client their sign-in address changed, and can be aimed at the old one', () => {
        const email = emailChangedEmail(client, { ...options, to: 'old@example.com' })
        expect(email.to).toBe('old@example.com')
        expect(email.text).toContain('ann@example.com')
    })
})

describe('escaping', () => {
    it('escapes the name in the HTML version', () => {
        const email = inviteEmail({ name: 'Ann <script>', email: 'ann@example.com' }, 'raw-token', options)
        expect(email.html).toContain('Ann &lt;script&gt;')
        expect(email.html).not.toContain('<script>')
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run server/clients/emails.test.ts
```

Expected: FAIL, cannot resolve `./emails`.

- [ ] **Step 3: Write the implementation**

Create `server/clients/emails.ts`:

```ts
// The emails a client account produces. Every one about a security change exists so that a change made from
// the admin side cannot be silent.

import 'server-only'

import { escapeHtml, type Email } from '../quotes/emails'

type Who = { name: string, email: string }
type Options = { from: string, replyTo: string, siteUrl: string }

// Unlike the quote emails, the name here is text Koda typed in the admin area rather than text a stranger
// typed into a public form, so the greeting can use it without the quote form's precautions.
const build = (to: string, subject: string, lines: string[], options: Options): Email => ({
    from: options.from,
    to,
    replyTo: options.replyTo,
    subject,
    text: lines.join('\n\n'),
    html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join(''),
})

// The link goes in as text and is escaped like everything else; no anchor, so the plain and HTML versions show
// the same address and nothing is hidden behind link text
export function inviteEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, 'Your Horizons account is ready', [
        `Hi ${client.name},`,
        'Your client account is ready. Open this link to set your password:',
        `${options.siteUrl}/portal/invite/${token}`,
        'The link is valid for 7 days. You will also need an authenticator app on your phone, such as Google Authenticator, Authy or 1Password, because every client account is protected by a second factor.',
        'Koda',
    ], options)
}

export function resetEmail(client: Who, token: string, options: Options): Email {
    return build(client.email, 'Reset your Horizons password', [
        `Hi ${client.name},`,
        'Open this link to set a new password:',
        `${options.siteUrl}/portal/reset/${token}`,
        'The link is valid for one hour. You will be asked for a code from your authenticator app as well.',
        "If you didn't ask for this, you can ignore this email and nothing will change.",
        'Koda',
    ], options)
}

export function passwordChangedEmail(client: Who, options: Options): Email {
    return build(client.email, 'Your Horizons password was changed', [
        `Hi ${client.name},`,
        'Your password has just been changed, and anything signed in elsewhere has been signed out.',
        "If that wasn't you, reply to this email straight away.",
        'Koda',
    ], options)
}

export function twoFactorResetEmail(client: Who, options: Options): Email {
    return build(client.email, 'Your Horizons two-factor setup was reset', [
        `Hi ${client.name},`,
        'The authenticator on your account has been reset, along with your recovery codes. Next time you sign in you will be asked to set up a new authenticator app.',
        "If you didn't ask for this, reply to this email straight away.",
        'Koda',
    ], options)
}

// Sent to both addresses, so a change of sign-in identity is visible from the old one too
export function emailChangedEmail(client: Who, options: Options & { to: string }): Email {
    return build(options.to, 'Your Horizons sign-in address has changed', [
        `Hi ${client.name},`,
        `The address you sign in with is now ${client.email}.`,
        "If you didn't ask for this, reply to this email straight away.",
        'Koda',
    ], options)
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npx vitest run server/clients/emails.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/clients/emails.ts server/clients/emails.test.ts
git commit -F - <<'MSG'
Add the client account emails

Every notice about a security change goes out so that a change made from
the admin side cannot be silent, and the notices carry no link at all,
so a message about a security event is never itself a phishing vector.

The greeting uses the client's name, unlike the quote confirmation: this
name is one Koda typed in the admin area, not one a stranger typed into
a public form.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 17: Wiring, middleware, and keeping the wallpaper build working

**Files:**
- Create: `server/clients/wiring.ts`
- Modify: `middleware.ts`, `scripts/wallpaper.mjs`, `app/robots.ts`
- Create: `app/(portal)/layout.tsx`, `app/(portal)/theme.tsx`
- Test: `server/clients/wiring.test.ts` (one test, on the part with a real rule in it)

**Interfaces:**
- Consumes: everything from Tasks 9 to 16, plus `getDb`, `clientMailConfig`, `ipHashKey`, `createMailer`, `clientIp`, `hashIp`.
- Produces: `log`, `repo()`, `requestIpHash()`, `requestUserAgent()`, `passwordStepDeps()`, `codeStepDeps()`, `completeInviteDeps()`, `beginEnrolmentDeps()`, `confirmEnrolmentDeps()`, `acknowledgeDeps()`, `requestResetDeps()`, `completeResetDeps()`, `changePasswordDeps()`, `regenerateDeps()`, `sendClientEmail(build)`, `newClientWithInvite(details)`.

- [ ] **Step 1: Write `server/clients/wiring.ts`**

```ts
// Connects the client account modules to the real database, relay, clock and request. The only file that does,
// so everything else can be tested with stand-ins. Same role as server/quotes/wiring.ts.

import 'server-only'

import { headers } from 'next/headers'
import { after } from 'next/server'

import { getDb } from '../db'
import { clientMailConfig, clientSecretKey, ipHashKey } from '../env'
import { createMailer } from '../mailer'
import type { Email } from '../quotes/emails'
import { clientIp, hashIp } from '../ratelimit'
import { changePassword as runChangePassword, regenerateRecoveryCodes as runRegenerate } from './account'
import { CLIENT_ID_PATTERN, newClientId, newRecoveryCode } from './ids'
import { hashPassword, verifyPassword, burnPasswordTime } from './password'
import { clientRepo, type ClientRecord } from './repo'
import { decryptSecret, encryptSecret, hashRecoveryCode, recoveryCodeMatches } from './secrets'
import type { ClientDetails } from './schema'
import { hashSessionToken, newSessionToken } from './session'
import { INVITE_TTL_MS } from './setup'
import { verifyTotp, newTotpSecret } from './totp'

export function log(message: string, error?: unknown) {
    console.error(`[clients] ${message}`, error ?? '')
}

export const repo = () => clientRepo(getDb())

// Called at the point of use rather than read once at startup, so a missing key stops only the flows that
// actually need it, the way server/quotes/wiring.ts reads the mail settings
const key = () => clientSecretKey()

export async function requestIpHash(): Promise<string> {
    return hashIp(clientIp(await headers()), ipHashKey())
}

// Truncated: it is only ever shown back to the client so they can recognise their own sessions
export async function requestUserAgent(): Promise<string | null> {
    return (await headers()).get('user-agent')?.slice(0, 200) ?? null
}

export async function sendClientEmail(build: (options: { from: string, replyTo: string, siteUrl: string }) => Email): Promise<void> {
    const config = clientMailConfig()
    await createMailer(config)(build({ from: config.from, replyTo: config.replyTo, siteUrl: config.siteUrl }))
}

const now = () => new Date()
const sendLater = (task: () => Promise<void>) => after(task)

export const passwordStepDeps = (ipHash: string) => ({
    findByEmail: repo().byEmail,
    countAttempts: repo().countAttempts,
    recordAttempt: repo().recordAttempt,
    recordFailure: repo().recordFailure,
    verifyPassword,
    burnTime: () => burnPasswordTime(),
    rehash: (password: string) => hashPassword(password),
    setPassword: repo().setPassword,
    createSession: repo().createSession,
    newToken: () => newSessionToken(),
    hashToken: hashSessionToken,
    now, log, ipHash,
})

export const codeStepDeps = (ipHash: string) => ({
    countAttempts: repo().countAttempts,
    recordAttempt: repo().recordAttempt,
    recordFailure: repo().recordFailure,
    decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
    verifyTotp,
    recordTotpUse: repo().recordTotpUse,
    unusedRecoveryCodes: repo().unusedRecoveryCodes,
    recoveryCodeMatches: (normalised: string, storedHash: string) => recoveryCodeMatches(normalised, storedHash, key()),
    useRecoveryCode: repo().useRecoveryCode,
    completeMfa: repo().completeMfa,
    recordSuccess: repo().recordSuccess,
    prune: repo().prune,
    now, log, ipHash,
})

export const completeInviteDeps = () => ({
    tokenByHash: repo().tokenByHash,
    hashPassword,
    setPassword: repo().setPassword,
    useToken: repo().useToken,
    createSession: repo().createSession,
    newToken: () => newSessionToken(),
    hashToken: hashSessionToken,
    now, log,
})

export const beginEnrolmentDeps = () => ({
    newSecret: () => newTotpSecret(),
    // Stored base64 inside the ciphertext, so the encrypted form is always text
    encryptSecret: (plaintext: string) => encryptSecret(plaintext, key()),
    storeSecret: (id: string, encrypted: string) => repo().setTotpPending(id, encrypted),
    now,
})

export const confirmEnrolmentDeps = () => ({
    decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
    verifyTotp,
    recordTotpUse: repo().recordTotpUse,
    confirmTotp: repo().confirmTotp,
    newRecoveryCode: () => newRecoveryCode(),
    hashRecoveryCode: (code: string) => hashRecoveryCode(code.replace(/-/g, ''), key()),
    replaceRecoveryCodes: repo().replaceRecoveryCodes,
    now, log,
})

export const acknowledgeDeps = () => ({ completeMfa: repo().completeMfa, recordSuccess: repo().recordSuccess, now })

export const requestResetDeps = (ipHash: string) => ({
    findByEmail: repo().byEmail,
    countAttempts: repo().countAttempts,
    recordAttempt: repo().recordAttempt,
    invalidateTokens: repo().invalidateTokens,
    createToken: repo().createToken,
    newToken: () => newSessionToken(),
    hashToken: hashSessionToken,
    sendLater,
    sendReset: async (client: ClientRecord, token: string) => {
        const { resetEmail } = await import('./emails')
        await sendClientEmail(options => resetEmail(client, token, options))
    },
    now, log, ipHash,
})

export const completeResetDeps = () => ({
    tokenByHash: repo().tokenByHash,
    decryptSecret: (stored: string) => Buffer.from(decryptSecret(stored, key()), 'base64'),
    verifyTotp,
    recordTotpUse: repo().recordTotpUse,
    unusedRecoveryCodes: repo().unusedRecoveryCodes,
    recoveryCodeMatches: (normalised: string, storedHash: string) => recoveryCodeMatches(normalised, storedHash, key()),
    useRecoveryCode: repo().useRecoveryCode,
    hashPassword,
    setPassword: repo().setPassword,
    useToken: repo().useToken,
    deleteSessionsFor: (clientId: string) => repo().deleteSessionsFor(clientId),
    clearLock: repo().clearLock,
    sendLater,
    sendChanged: async (client: ClientRecord) => {
        const { passwordChangedEmail } = await import('./emails')
        await sendClientEmail(options => passwordChangedEmail(client, options))
    },
    now, log,
})

export const changePasswordDeps = () => ({
    verifyPassword,
    hashPassword,
    setPassword: repo().setPassword,
    deleteSessionsFor: repo().deleteSessionsFor,
    sendLater,
    sendChanged: async (client: ClientRecord) => {
        const { passwordChangedEmail } = await import('./emails')
        await sendClientEmail(options => passwordChangedEmail(client, options))
    },
    now, log,
})

export const regenerateDeps = () => ({
    verifyPassword,
    newRecoveryCode: () => newRecoveryCode(),
    hashRecoveryCode: (code: string) => hashRecoveryCode(code.replace(/-/g, ''), key()),
    replaceRecoveryCodes: repo().replaceRecoveryCodes,
})

export { runChangePassword, runRegenerate }

// Retries on the unique key rather than hoping 40 bits never collides
export async function newClientWithInvite(details: ClientDetails): Promise<{ client: ClientRecord, token: string }> {
    const token = newSessionToken()
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = newClientId()
        if (!CLIENT_ID_PATTERN.test(id)) continue
        try {
            const client = await repo().createWithInvite(details, id, { tokenHash: hashSessionToken(token), expiresAt })
            return { client, token }
        } catch (error) {
            // A duplicate email is the caller's problem and must not be retried; only an id clash is
            if (!String(error).includes('Client_pkey')) throw error
        }
    }
    throw new Error('Could not allocate a client id')
}
```

The `sendReset` and `sendChanged` dependencies above use a dynamic `import('./emails')` so that a page which only signs someone in never pulls the email module into its bundle. A plain top-level import is also fine if that turns out to be simpler to read; nothing else depends on the choice.

- [ ] **Step 2: Write the one wiring test**

Create `server/clients/wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CLIENT_ID_PATTERN } from './ids'

// The one rule in wiring.ts that isn't just plumbing: the id it allocates has to satisfy both our pattern and
// hostd's, because it is typed into projects.yaml by hand.
describe('the ids wiring allocates', () => {
    it('satisfies hostd/src/shared/formats.ts', () => {
        expect(CLIENT_ID_PATTERN.source).toContain('cl_')
        const sample = 'cl_0123ABCD'
        expect(CLIENT_ID_PATTERN.test(sample)).toBe(true)
        expect(/^[A-Za-z0-9_-]{1,64}$/.test(sample)).toBe(true)
    })
})
```

- [ ] **Step 3: Update `middleware.ts`**

```ts
// Two matchers, two jobs. /admin is Auth.js's, exactly as before. /portal only checks that a session cookie is
// present, because Prisma doesn't run in the edge runtime, so requireClient() is the layer that decides.

import NextAuth from 'next-auth'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'

import { authConfig } from './server/auth/config'

const { auth: adminMiddleware } = NextAuth(authConfig)

const PORTAL_SIGN_IN = '/portal/sign-in'
// Reachable without a session: the two email links, the sign-in pages and the forgot form
const OPEN_PORTAL_PATHS = [PORTAL_SIGN_IN, '/portal/forgot', '/portal/invite', '/portal/reset']

const cookieName = process.env.NODE_ENV === 'production' ? '__Secure-horizons-client' : 'horizons-client'

export default function middleware(request: NextRequest, event: NextFetchEvent) {
    const { pathname } = request.nextUrl
    // Branch before delegating, so a /portal request never reaches the Auth.js handler and server/auth/config.ts
    // stays untouched. Both arguments are forwarded, because Next calls middleware with (request, event) and
    // that is the shape Auth.js's handler expects when it is invoked rather than wrapped.
    if (!pathname.startsWith('/portal')) {
        return (adminMiddleware as unknown as (request: NextRequest, event: NextFetchEvent) => Response)(request, event)
    }
    if (OPEN_PORTAL_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))) return NextResponse.next()
    if (request.cookies.get(cookieName)) return NextResponse.next()
    return NextResponse.redirect(new URL(PORTAL_SIGN_IN, request.url))
}

export const config = { matcher: ['/admin/:path*', '/portal/:path*'] }
```

- [ ] **Step 4: Keep the wallpaper build working**

In `scripts/wallpaper.mjs`, add the new route group to `SERVER_SIDE`:

```js
const SERVER_SIDE = [join('app', '(quote)'), join('app', '(admin)'), join('app', '(portal)'), join('app', 'api')]
```

In `app/robots.ts`, add `/portal` beside the existing `/admin` disallow.

- [ ] **Step 5: Add the portal layout and theme**

`app/(portal)/theme.tsx` is `app/(admin)/admin/theme.tsx` with the component renamed to `PortalTheme`. Copy it rather than sharing it: the admin area and the client area will diverge, and a shared theme would make every future admin tweak a client-facing change.

`app/(portal)/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'

import PortalTheme from './theme'

export const metadata: Metadata = {
    title: { default: 'Client portal', template: '%s · Horizons' },
    robots: { index: false, follow: false },
}

// Every portal page shows one client's own data and must never be served from a cache
export const dynamic = 'force-dynamic'

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <AppRouterCacheProvider>
            <PortalTheme>{children}</PortalTheme>
        </AppRouterCacheProvider>
    )
}
```

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run wallpaper
```

Expected: all pass. The wallpaper build is the one that proves the new route group is excluded from the static export.

- [ ] **Step 7: Commit**

```bash
git add server/clients/wiring.ts server/clients/wiring.test.ts server/clients/repo.ts middleware.ts scripts/wallpaper.mjs app/robots.ts "app/(portal)"
git commit -F - <<'MSG'
Wire the client modules to the database, relay and request

The middleware now does two jobs: /admin stays Auth.js's exactly as it
was, and /portal only checks that a cookie is present, because Prisma
does not run in the edge runtime. requireClient() is what decides.

The portal theme is copied rather than shared with the admin area, so a
future admin tweak is not silently a client-facing change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 18: Sign-in, second factor and enrolment pages

**Files:**
- Create: `app/(portal)/portal/actions.ts`, `app/(portal)/portal/forms.tsx`
- Create: `app/(portal)/portal/sign-in/page.tsx`, `app/(portal)/portal/sign-in/code/page.tsx`, `app/(portal)/portal/setup/page.tsx`

**Interfaces:**
- Consumes: `server/clients/auth`, `server/clients/wiring`, `server/clients/signIn`, `server/clients/setup`, `server/clients/schema`.
- Produces the server actions `signInAction`, `codeAction`, `confirmEnrolmentAction`, `acknowledgeCodesAction`, `signOutAction`, each returning `PortalResult = { ok: true } | { ok: false, error: string }`.

- [ ] **Step 1: Write the actions**

`app/(portal)/portal/actions.ts`:

```ts
'use server'

// Everything the portal changes. The pre-auth actions validate their own token or half-session first; the rest
// call requireClient() first, exactly as the admin actions call requireAdmin().

import { redirect } from 'next/navigation'

import { CODE_PATH, PORTAL_HOME, SETUP_PATH, SIGN_IN_PATH, clearSessionCookie, readSession, requireClient, requirePendingSession, setSessionCookie } from '@/server/clients/auth'
import { EnvError } from '@/server/env'
import { codeSchema, emailSchema, passwordSchema } from '@/server/clients/schema'
import { codeStep, passwordStep } from '@/server/clients/signIn'
import { acknowledgeRecoveryCodes, confirmEnrolment } from '@/server/clients/setup'
import { acknowledgeDeps, codeStepDeps, confirmEnrolmentDeps, log, passwordStepDeps, repo, requestIpHash, requestUserAgent } from '@/server/clients/wiring'

export type PortalResult = { ok: true } | { ok: false, error: string }
export type CodesResult = { ok: true, recoveryCodes: string[] } | { ok: false, error: string }

const INVALID: PortalResult = { ok: false, error: 'That request was not valid.' }
const BROKEN: PortalResult = { ok: false, error: 'Something went wrong. Please try again.' }

// EnvError names the missing variable and never its value, so it is safe to show
const failure = (where: string, error: unknown): PortalResult => {
    if (error instanceof EnvError) return { ok: false, error: `${error.message}. Please let Koda know.` }
    log(`${where} failed`, error)
    return BROKEN
}

export async function signInAction(email: string, password: string): Promise<PortalResult> {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success || typeof password !== 'string' || !password) return INVALID
    try {
        const result = await passwordStep(
            { email: parsed.data, password, userAgent: await requestUserAgent() },
            passwordStepDeps(await requestIpHash()),
        )
        if (!result.ok) return result
        await setSessionCookie(result.token, result.expiresAt)
        redirect(result.next === 'code' ? CODE_PATH : SETUP_PATH)
    } catch (error) {
        // redirect() works by throwing, so it must not be swallowed here
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Client sign-in', error)
    }
}

export async function codeAction(code: string): Promise<PortalResult> {
    const parsed = codeSchema.safeParse(code)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    const session = await requirePendingSession()
    try {
        const result = await codeStep({ session, code: parsed.data }, codeStepDeps(await requestIpHash()))
        if (!result.ok) return result
        redirect(PORTAL_HOME)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Client second factor', error)
    }
}

export async function confirmEnrolmentAction(code: string): Promise<CodesResult> {
    const parsed = codeSchema.safeParse(code)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    const session = await requirePendingSession()
    try {
        return await confirmEnrolment({ session, code: parsed.data }, confirmEnrolmentDeps())
    } catch (error) {
        const result = failure('Authenticator enrolment', error)
        return result.ok ? { ok: false, error: BROKEN.error } : result
    }
}

export async function acknowledgeCodesAction(): Promise<PortalResult> {
    const session = await requirePendingSession()
    // Only reachable once the authenticator is confirmed, which is what makes this a safe place to finish
    if (!session.client.totpConfirmedAt) return INVALID
    try {
        await acknowledgeRecoveryCodes(session, acknowledgeDeps())
        redirect(PORTAL_HOME)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Finishing enrolment', error)
    }
}

export async function signOutAction(): Promise<void> {
    const session = await readSession()
    if (session) await repo().deleteSession(session.id)
    await clearSessionCookie()
    redirect(SIGN_IN_PATH)
}
```

- [ ] **Step 2: Write the shared form components**

`app/(portal)/portal/forms.tsx`, a `'use client'` module holding a `Panel` wrapper (centred MUI `Paper` on the navy background, matching the admin sign-in page) and a `useAction` hook identical in shape to the one in `app/(admin)/admin/quotes/[id]/controls.tsx`. Reuse that file's `useAction` verbatim, renaming `ActionResult` to `PortalResult`, and its `Problem` component.

Then the three form components, each a small client component calling one action:

```tsx
export function SignInForm() {
    const { pending, error, run } = useAction()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => signInAction(email, password)) }}>
            <TextField label="Email" type="email" fullWidth autoComplete="username" value={email}
                onChange={event => setEmail(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="Password" type="password" fullWidth autoComplete="current-password" value={password}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={pending || !email || !password}>Sign in</Button>
            <Problem error={error} />
            <Box sx={{ mt: 2, textAlign: 'center' }}>
                <Link href="/portal/forgot" style={{ color: 'inherit', fontSize: '0.875rem' }}>Forgotten your password?</Link>
            </Box>
        </form>
    )
}
```

`CodeForm` is the same shape with one field labelled "Code from your authenticator app", `autoComplete="one-time-code"`, `inputMode="numeric"`, and helper text saying a recovery code works here too. `EnrolmentForm` takes `uri` and `typed` as props, shows the QR image, the typed secret, one code field, and on success renders the returned recovery codes with a copy button, a download button and an "I have saved these" button that calls `acknowledgeCodesAction`.

- [ ] **Step 3: Write the three pages**

Each is a server component. `sign-in/page.tsx` redirects to `/portal` when `currentClient()` already returns someone, then renders `<Panel title="Client sign-in"><SignInForm /></Panel>`.

`sign-in/code/page.tsx` calls `requirePendingSession()`, redirects to `SETUP_PATH` when `totpConfirmedAt` is null, then renders `<Panel title="One more step"><CodeForm /></Panel>`.

`setup/page.tsx` calls `requirePendingSession()`, redirects to `CODE_PATH` when `totpConfirmedAt` is already set, then:

```tsx
import QRCode from 'qrcode'

import { beginEnrolment } from '@/server/clients/setup'
import { beginEnrolmentDeps } from '@/server/clients/wiring'

export default async function SetupPage() {
    const session = await requirePendingSession()
    if (session.client.totpConfirmedAt) redirect(CODE_PATH)
    const { uri, typed } = await beginEnrolment(session.client, beginEnrolmentDeps())
    // Rendered on the server into a data URI, so no third-party script runs on the page showing the secret
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
    return <Panel title="Set up your authenticator"><EnrolmentForm qr={qr} typed={typed} /></Panel>
}
```

- [ ] **Step 4: Verify in the browser**

```bash
npm run services
```

Then start the dev server through the preview tooling and walk the flow. You cannot sign in yet (no client exists until Task 21), so for now check that `/portal` redirects to `/portal/sign-in`, that the sign-in page renders, and that a wrong email and password gives the vague message rather than an error page.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)"
git commit -F - <<'MSG'
Add the portal sign-in, second factor and enrolment pages

The QR code is rendered on the server into a data URI, so no third-party
script runs on the page that displays a client's secret.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 19: Invite, forgot and reset pages

**Files:**
- Create: `app/(portal)/portal/invite/[token]/page.tsx`, `app/(portal)/portal/forgot/page.tsx`, `app/(portal)/portal/reset/[token]/page.tsx`
- Modify: `app/(portal)/portal/actions.ts`, `app/(portal)/portal/forms.tsx`

**Interfaces:**
- Produces the actions `completeInviteAction(token, password)`, `requestResetAction(email)`, `completeResetAction(token, password, code)`.

- [ ] **Step 1: Add the three actions**

Append to `app/(portal)/portal/actions.ts`, following the same shape as Task 18's. These need imports Task 18 did not add, so extend the import block at the top of that file with:

```ts
import { hashSessionToken } from '@/server/clients/session'
import { completeInvite } from '@/server/clients/setup'
import { RESET_SENT_MESSAGE, completeReset, requestReset } from '@/server/clients/reset'
import { completeInviteDeps, completeResetDeps, requestResetDeps } from '@/server/clients/wiring'
```

Then the actions themselves:

```ts
export async function completeInviteAction(token: string, password: string): Promise<PortalResult> {
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof token !== 'string' || !token) return INVALID
    try {
        const result = await completeInvite(
            { tokenHash: hashSessionToken(token), password: parsed.data, userAgent: await requestUserAgent() },
            completeInviteDeps(),
        )
        if (!result.ok) return result
        await setSessionCookie(result.token, result.expiresAt)
        // Straight into enrolment: the account does nothing until an authenticator is set up
        redirect(SETUP_PATH)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Completing an invite', error)
    }
}

export async function requestResetAction(email: string): Promise<{ message: string }> {
    const parsed = emailSchema.safeParse(email)
    // The same answer for an invalid address as for a valid one that matches nothing
    if (!parsed.success) return { message: RESET_SENT_MESSAGE }
    try {
        return await requestReset({ email: parsed.data }, requestResetDeps(await requestIpHash()))
    } catch (error) {
        log('Requesting a password reset failed', error)
        return { message: RESET_SENT_MESSAGE }
    }
}

export async function completeResetAction(token: string, password: string, code: string): Promise<PortalResult> {
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof token !== 'string' || !token || typeof code !== 'string') return INVALID
    try {
        const result = await completeReset({ tokenHash: hashSessionToken(token), password: parsed.data, code }, completeResetDeps())
        if (!result.ok) return result
        redirect(`${SIGN_IN_PATH}?reset=1`)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Completing a password reset', error)
    }
}
```

- [ ] **Step 2: Write the pages**

`invite/[token]/page.tsx` looks the token up by its hash and calls `tokenProblem` before rendering anything, so an expired link never shows a password form:

```tsx
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params
    const record = await repo().tokenByHash(hashSessionToken(token))
    // Checked here as well as in the action: an expired link should never show a form at all
    const problem = tokenProblem(record, 'INVITE', new Date())
    if (problem) return <Panel title="This link has expired"><Alert severity="warning">{problem}</Alert></Panel>
    return <Panel title="Set your password"><InviteForm token={token} /></Panel>
}
```

`forgot/page.tsx` renders `<ForgotForm />`, which on submit replaces itself with the returned message, whatever that message is.

`reset/[token]/page.tsx` mirrors the invite page, checking `purpose === 'PASSWORD_RESET'`, and passes `needsCode={!!record.client.totpConfirmedAt}` to `ResetForm` so a client with no authenticator is not asked for a code they cannot produce.

The sign-in page reads `?reset=1` and shows "Your password has been changed. Sign in with the new one."

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test
```

- [ ] **Step 4: Commit**

```bash
git add "app/(portal)"
git commit -F - <<'MSG'
Add the invite, forgot password and reset pages

An expired or spent link is recognised before a form is rendered, so
nobody types a new password into a page that was never going to accept
it. A client who has not enrolled yet is not asked for a code they have
no way to produce.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 20: The portal home and account pages

**Files:**
- Create: `app/(portal)/portal/page.tsx`, `app/(portal)/portal/account/page.tsx`, `app/(portal)/portal/header.tsx`
- Modify: `app/(portal)/portal/actions.ts`, `app/(portal)/portal/forms.tsx`

- [ ] **Step 1: Add the account actions**

```ts
export async function changePasswordAction(current: string, next: string): Promise<PortalResult> {
    const { client, sessionId } = await requireClient()
    const parsed = passwordSchema.safeParse(next)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof current !== 'string' || !current) return INVALID
    try {
        const result = await runChangePassword({ client, sessionId, current, next: parsed.data }, changePasswordDeps())
        if (result.ok) revalidatePath('/portal/account')
        return result
    } catch (error) {
        return failure('Changing a client password', error)
    }
}

export async function regenerateCodesAction(password: string): Promise<CodesResult> {
    const { client } = await requireClient()
    if (typeof password !== 'string' || !password) return { ok: false, error: INVALID.error }
    try {
        const result = await runRegenerate({ client, password }, regenerateDeps())
        if (result.ok) revalidatePath('/portal/account')
        return result
    } catch (error) {
        const failed = failure('Regenerating recovery codes', error)
        return failed.ok ? { ok: false, error: BROKEN.error } : failed
    }
}

export async function signOutElsewhereAction(): Promise<PortalResult> {
    const { client, sessionId } = await requireClient()
    try {
        await repo().deleteSessionsFor(client.id, sessionId)
        revalidatePath('/portal/account')
        return { ok: true }
    } catch (error) {
        return failure('Signing out other sessions', error)
    }
}
```

- [ ] **Step 2: Write the home page**

```tsx
export default async function PortalHome() {
    const { client } = await requireClient()
    const sites = await repo().listSites(client.id)

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <PortalHeader name={client.name} />
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
                {client.company ?? client.name}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 4 }}>
                This is where your sites will appear. Controls are on the way.
            </Typography>
            {sites.length === 0
                ? <Alert severity="info">No sites are linked to your account yet. Koda will add them here.</Alert>
                : (
                    <Stack spacing={2}>
                        {sites.map(site => (
                            <Paper key={site.id} sx={{ p: 3 }}>
                                <Typography variant="h6" component="h2">{site.name}</Typography>
                                <Typography variant="body2" color="text.secondary">Controls are coming soon.</Typography>
                            </Paper>
                        ))}
                    </Stack>
                )}
        </Container>
    )
}
```

Deliberately plain. Another session is designing the dashboard, and this must not prejudge it.

`header.tsx` is a small server component with the Horizons wordmark, the client's name, a link to `/portal/account` and a sign-out form calling `signOutAction`.

- [ ] **Step 3: Write the account page**

Three `Paper` sections: **Password** (`ChangePasswordForm`), **Where you are signed in** (the session list from `repo().listSessions()`, each row `describeDevice(session.userAgent)` plus `formatWhen(session.lastUsedAt)`, the current one marked "This device", and a "Sign out everywhere else" button shown only when there is more than one), and **Recovery codes** (`countUnusedRecoveryCodes` as "n of 10 unused", plus `RegenerateCodesForm`).

Reuse `formatWhen` from `app/(admin)/admin/format.ts` by importing it; it is a plain function with no admin dependency.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)"
git commit -F - <<'MSG'
Add the portal home and account pages

The home page is deliberately plain: another session is designing the
dashboard, and this should not prejudge it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 21: The admin clients area

**Files:**
- Create: `app/(admin)/admin/clients/page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `actions.ts`, `controls.tsx`, `state.ts`
- Modify: `app/(admin)/admin/header.tsx`
- Test: `app/(admin)/admin/clients/state.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` from `server/auth`, `server/clients/wiring`, `server/clients/repo`, `server/clients/schema`.
- Produces the actions `createClientAction`, `updateClientAction`, `resendInviteAction`, `sendResetAction`, `resetTwoFactorAction`, `setSuspendedAction`, `clearLockAction`, `deleteClientAction`, `addSiteAction`, `removeSiteAction`, and `clientState(client, now): ClientState` from `state.ts`.

- [ ] **Step 1: Write the failing test for the derived state**

The state shown in the list is derived rather than stored, so it is the one piece here worth a unit test. Create `app/(admin)/admin/clients/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { clientState } from './state'

const now = new Date('2026-09-20T10:00:00Z')
const base = { passwordHash: null, totpConfirmedAt: null, suspendedAt: null, lockedUntil: null }

describe('clientState', () => {
    it('reads invited when there is no password yet', () => {
        expect(clientState(base, now)).toBe('Invited')
    })

    it('reads setup incomplete when the password is set but the authenticator is not', () => {
        expect(clientState({ ...base, passwordHash: 'x' }, now)).toBe('Setup incomplete')
    })

    it('reads active once both are done', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now }, now)).toBe('Active')
    })

    // Suspension is the answer whatever else is true, because it is the one that stops everything
    it('reads suspended ahead of anything else', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, suspendedAt: now, lockedUntil: new Date('2026-09-20T10:05:00Z') }, now))
            .toBe('Suspended')
    })

    it('reads locked only while the lock is in the future', () => {
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, lockedUntil: new Date('2026-09-20T10:05:00Z') }, now)).toBe('Locked')
        expect(clientState({ ...base, passwordHash: 'x', totpConfirmedAt: now, lockedUntil: new Date('2026-09-20T09:55:00Z') }, now)).toBe('Active')
    })
})
```

Add `app/**/*.test.ts` is already in `vitest.config.ts`'s `include`, so no config change is needed.

- [ ] **Step 2: Write `state.ts`**

```ts
// The state shown in the admin area, derived rather than stored. There is no status column on the Client
// table on purpose: a stored status could say ACTIVE while the row has no password hash.

export type ClientState = 'Invited' | 'Setup incomplete' | 'Suspended' | 'Locked' | 'Active'

type Fields = { passwordHash: string | null, totpConfirmedAt: Date | null, suspendedAt: Date | null, lockedUntil: Date | null }

export function clientState(client: Fields, now: Date): ClientState {
    // First, because it is the one that stops everything regardless of the rest
    if (client.suspendedAt) return 'Suspended'
    if (!client.passwordHash) return 'Invited'
    if (!client.totpConfirmedAt) return 'Setup incomplete'
    if (client.lockedUntil && client.lockedUntil.getTime() > now.getTime()) return 'Locked'
    return 'Active'
}

export const STATE_COLOURS: Record<ClientState, 'default' | 'info' | 'warning' | 'error' | 'success'> = {
    Invited: 'info',
    'Setup incomplete': 'warning',
    Suspended: 'error',
    Locked: 'warning',
    Active: 'success',
}
```

- [ ] **Step 3: Run the test and watch it pass**

```bash
npx vitest run "app/(admin)/admin/clients/state.test.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 4: Write the actions**

`app/(admin)/admin/clients/actions.ts`, following `app/(admin)/admin/actions.ts` exactly in shape: `requireAdmin()` first, validate, then act, then `revalidatePath`.

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin } from '@/server/auth'
import { EnvError } from '@/server/env'
import { emailChangedEmail, inviteEmail, resetEmail, twoFactorResetEmail } from '@/server/clients/emails'
import { clientDetailsSchema, siteSchema } from '@/server/clients/schema'
import { hashSessionToken, newSessionToken } from '@/server/clients/session'
import { INVITE_TTL_MS, RESET_TTL_MS } from '@/server/clients/setup'
import { log, newClientWithInvite, repo, sendClientEmail } from '@/server/clients/wiring'

export type AdminResult = { ok: true } | { ok: false, error: string, clientId?: string }

const id = z.string().min(1).max(64)
const INVALID = { ok: false, error: 'That request was not valid.' } as const

const refresh = (clientId?: string) => {
    revalidatePath('/admin/clients')
    if (clientId) revalidatePath(`/admin/clients/${clientId}`)
}

// EnvError names the missing variable, never its value
const emailFailure = (what: string, error: unknown) => {
    if (error instanceof EnvError) return `${what} was saved, but the email did not send: ${error.message}`
    log(`${what}: sending the email failed`, error)
    return `${what} was saved, but the email did not send. The server log has the reason.`
}

export async function createClientAction(input: unknown, fromQuoteId?: string): Promise<AdminResult> {
    await requireAdmin()
    const parsed = clientDetailsSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }

    const existing = await repo().byEmail(parsed.data.email)
    // Offering to link is better than creating a second account on the same address
    if (existing) return { ok: false, error: 'A client already uses that email address.', clientId: existing.id }

    let created
    try {
        created = await newClientWithInvite(parsed.data)
    } catch (error) {
        log('Creating a client failed', error)
        return { ok: false, error: 'That did not work. Please try again.' }
    }

    if (fromQuoteId && id.safeParse(fromQuoteId).success) {
        try {
            await repo().linkQuote(fromQuoteId, created.client.id)
            revalidatePath(`/admin/quotes/${fromQuoteId}`)
        } catch (error) {
            // The client exists and matters more than the link, so this is reported, not rolled back
            log(`Linking quote ${fromQuoteId} to ${created.client.id} failed`, error)
        }
    }

    // Sent inline, not through after(): the admin is standing there and should be told if the relay refused
    try {
        await sendClientEmail(options => inviteEmail(created.client, created.token, options))
    } catch (error) {
        refresh(created.client.id)
        return { ok: false, error: emailFailure('The client', error), clientId: created.client.id }
    }

    refresh(created.client.id)
    redirect(`/admin/clients/${created.client.id}`)
}
```

The remaining actions follow the same pattern and are each a few lines:

| Action | Body |
| --- | --- |
| `updateClientAction(clientId, input)` | Validate; read the old record; `repo().updateDetails`; if the email changed, send `emailChangedEmail` to the old address **and** the new one |
| `resendInviteAction(clientId)` | `repo().invalidateTokens(clientId, 'INVITE', now)`, then a fresh token with `INVITE_TTL_MS` and `inviteEmail` |
| `sendResetAction(clientId)` | `repo().invalidateTokens(clientId, 'PASSWORD_RESET', now)`, a fresh token with `RESET_TTL_MS`, then `resetEmail` |
| `resetTwoFactorAction(clientId)` | `repo().clearTotp(clientId)` (which also drops the codes and every session), then `twoFactorResetEmail` |
| `setSuspendedAction(clientId, suspended)` | `repo().setSuspended(clientId, suspended ? new Date() : null)` |
| `clearLockAction(clientId)` | `repo().clearLock(clientId)` |
| `deleteClientAction(clientId)` | `repo().remove(clientId)`, then `revalidatePath('/admin/clients')` and `redirect('/admin/clients')`, with the `redirect` outside the `try` because it works by throwing |
| `addSiteAction(clientId, input)` | Validate with `siteSchema`; `repo().createSite`; a duplicate `projectId` reports "that project id is already linked to a client" |
| `removeSiteAction(clientId, siteId)` | `repo().removeSite(clientId, siteId)`, which is scoped to the client |

Every one of them starts with `await requireAdmin()`.

- [ ] **Step 5: Write the pages**

**`clients/page.tsx`**: `requireAdmin()`, `repo().list()`, then an MUI table: name, company, email, a state `Chip` from `clientState`, site count, last sign-in via `formatWhen`. A "New client" button linking to `clients/new`. An empty state when there are none.

**`clients/new/page.tsx`**: `requireAdmin()`, reads `searchParams.fromQuote`. When present, loads that quote and prefills name, company and email, with a line saying which quote it came from. Renders `ClientForm`.

**`clients/[id]/page.tsx`**: `requireAdmin()`, `repo().byId(id)` or `notFound()`. Shows the details with an edit form, the derived state chip, the id in a monospace span with a copy button and the caption "Use this as `client:` in hostd's projects.yaml", the linked quotes, the sites list with an add form and a remove button each, the recovery code count, the session list, and the controls: Resend invite (only while `passwordHash` is null), Send password reset, Reset 2FA, Suspend or Unsuspend, Clear lock (only while locked), Delete behind a confirmation dialog.

**`controls.tsx`** is a `'use client'` module reusing the `useAction` hook and `Problem` component shape from `app/(admin)/admin/quotes/[id]/controls.tsx`. The destructive buttons (Reset 2FA, Delete) each sit behind an MUI `Dialog`, like the existing quote delete.

- [ ] **Step 6: Add the header navigation**

In `app/(admin)/admin/header.tsx`, put two links between the title and the sign-out form:

```tsx
<Stack direction="row" spacing={2} sx={{ ml: 'auto', mr: 2 }}>
    <Link href="/admin" style={{ color: 'inherit' }}>Quotes</Link>
    <Link href="/admin/clients" style={{ color: 'inherit' }}>Clients</Link>
</Stack>
```

- [ ] **Step 7: Verify**

```bash
npm test && npx tsc --noEmit && npm run lint
```

- [ ] **Step 8: Commit**

```bash
git add "app/(admin)"
git commit -F - <<'MSG'
Add the admin clients area

The state chip is derived from the fields rather than read from a status
column, so the list can never show a client as active while the row has
no password hash.

The client id is shown with a copy button, because it is what gets typed
into hostd's projects.yaml by hand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 22: Quote conversion, documentation and the full verification pass

**Files:**
- Modify: `app/(admin)/admin/quotes/[id]/page.tsx`, `app/(admin)/admin/quotes/[id]/controls.tsx`, `server/quotes/repo.ts`
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Show the linked client on a quote**

In `server/quotes/repo.ts`, extend the `get` query to include the client:

```ts
        get: (id: string) => db.quote.findUnique({
            where: { id },
            include: { notes: { orderBy: { createdAt: 'desc' } }, client: { select: { id: true, name: true, company: true } } },
        }),
```

- [ ] **Step 2: Add the conversion button**

In `app/(admin)/admin/quotes/[id]/page.tsx`, beside the status chip:

```tsx
{quote.client
    ? (
        <Button component={Link} href={`/admin/clients/${quote.client.id}`} variant="outlined" size="small">
            Client: {quote.client.company ?? quote.client.name}
        </Button>
    )
    : quote.status === 'WON' && (
        <Button component={Link} href={`/admin/clients/new?fromQuote=${quote.id}`} variant="contained" size="small">
            Create client from this quote
        </Button>
    )}
```

It links to a prefilled form rather than creating anything, so the details can be seen and corrected first. The form is where the duplicate-email check offers to link an existing client instead.

- [ ] **Step 3: Update `.env.example`**

Append:

```bash
# Client accounts. CLIENT_SECRET_KEY encrypts every client's authenticator secret and keys their recovery
# codes. It is NOT AUTH_SECRET, and it must not be rotated casually: changing it means every client has to
# set up their authenticator again. Generate it with: openssl rand -base64 32
CLIENT_SECRET_KEY=
CLIENT_REPLY_TO=info@dev.horizons.gg
```

- [ ] **Step 4: Update `README.md`**

Add a "Client accounts" section covering: how to create a client and what the invite does, that the authenticator step cannot be skipped, what to do when a client is locked out (reset 2FA, then send a password reset), the warning about `CLIENT_SECRET_KEY`, and that a client's id is what goes in `hostd/projects.yaml` as `client:`. Add the two new variables to the environment table if the README has one.

- [ ] **Step 5: The full verification pass**

Run every one of these and read the output. Do not claim success on any of them without seeing it.

```bash
npm test
```

```bash
npx tsc --noEmit
```

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run wallpaper
```

- [ ] **Step 6: The browser pass**

With `npm run services` running and Mailpit open at `http://localhost:8025`, walk the whole thing end to end. Every one of these must be checked, not assumed:

1. Sign in to `/admin` with Google. **This must work exactly as before.** If anything about the admin sign-in has changed, stop: that is a regression against a hard rule.
2. Create a client. Read the invite email in Mailpit. Open the link.
3. Set a password shorter than 12 characters and confirm it is refused, then set a real one.
4. Confirm the enrolment step cannot be skipped: try navigating straight to `/portal` and confirm it sends you back.
5. Scan the QR code with a real authenticator app. Enter a wrong code, then the right one.
6. Save the recovery codes, confirm, and land on `/portal`.
7. Sign out. Sign back in: password, then a code. Try the **same code twice** and confirm the second attempt is refused as already used.
8. Sign in with a recovery code instead. Confirm it does not work a second time.
9. Get the password wrong five times and confirm the lockout arrives and the message is vague until the password is right.
10. Use forgot password. Confirm the message is identical for a real address and an invented one. Complete the reset, which must demand a code.
11. Open `/portal/account`: change the password, check the sessions list, sign out everywhere else, regenerate the recovery codes.
12. In the admin area: suspend the client while their tab is open, then click in that tab and confirm they are bounced immediately.
13. Reset 2FA and confirm the client is sent back through enrolment, and that the notice email arrived.
14. Mark a quote Won, convert it, and confirm the quote and the client are linked in both directions.
15. Delete the client and confirm the quote survives with no client attached.
16. Load the landing page and confirm it is untouched.

- [ ] **Step 7: Commit and open the pull request**

```bash
git add -A
git commit -F - <<'MSG'
Convert a won quote into a client, and document the setup

The button opens a prefilled form rather than creating the client
outright, so the details can be corrected first and a duplicate email is
caught before anything is written.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

```bash
git push -u origin claude/client-accounts
```

Then open the pull request against `Master`, describing what was built, the two new environment variables Koda has to set before deploying, and the resolved contradiction from Task 12. End the description with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Before pushing any follow-up commit**, check the pull request is still open, because Koda merges quickly:

```bash
gh pr view <number> --json state
```

If it reads `MERGED`, branch again from `origin/Master` and open a new pull request rather than pushing to the merged branch.

---

## Notes for whoever executes this

**What must not change.** `server/auth/config.ts`, `server/auth/allow.ts` and `server/auth/index.ts` are off limits. If a task seems to need a change there, the design is wrong and it is worth stopping to say so. The admin's Google sign-in working unchanged is a hard requirement, and step 6.1 of Task 22 is where it is proved.

**The test that matters most.** Task 12's "the only ways to finish a sign-in" test, and Task 10's `isUsable`. Between them they are what makes mandatory 2FA structural. If a later change makes either awkward, that is a signal about the change, not about the test.

**Secrets.** Never commit `.env`. Never paste a key into a commit message, a test fixture or a comment. `CLIENT_SECRET_KEY` is generated by Koda with `openssl rand -base64 32` and set on the server by Koda.

**If a task turns out to be wrong.** The spec is `docs/superpowers/specs/2026-09-20-client-accounts-design.md` and it travels with this plan. Where the plan and the spec disagree, say so rather than quietly picking one; Task 12 documents one such contradiction and how it was resolved.
