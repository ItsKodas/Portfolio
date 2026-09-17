# Self-hosted mail stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a forward-only mail stack that receives mail for `dev.horizons.gg` and forwards it to an existing inbox, auto-configuring its own DNS through Cloudflare and asserting its own health on a dynamic residential IP.

**Architecture:** Two containers in `mail/docker-compose.yml`, deployed independently of the site. `mailserver` is stock `docker-mailserver` and owns all SMTP. `mailops` is a small custom operator that never touches mail: it computes a desired DNS record set from one domain parameter, reconciles it against Cloudflare on a loop, maintains a TLS certificate via ACME DNS-01, and runs health probes.

**Tech Stack:** Docker Compose, `docker-mailserver`, Node 22, TypeScript, `tsx`, the built-in `node --test` runner, `lego` for ACME.

**Spec:** [docs/superpowers/specs/2026-09-18-mail-stack-design.md](../specs/2026-09-18-mail-stack-design.md)

## Global Constraints

- **No em dashes** (U+2014, `&mdash;`) anywhere: code comments are the only exception. Use a comma, colon, full stop or parentheses. This is a project-wide rule from `CLAUDE.md` and applies to every file, commit message and document produced by this plan.
- **Mail domain is `dev.horizons.gg`.** Hostname is derived as `mail.dev.horizons.gg`. Never hardcode either; both derive from `MAIL_DOMAIN`.
- **The site is not modified.** No changes to `app/`, `package.json`, `next.config.ts` or `docker-compose.yml` at the repo root. The single exception is adding `.env*` to `.dockerignore`, in Task 9.
- **`mailops` has its own `package.json`** under `mail/mailops/`. It does not share dependencies with the site.
- **Every Cloudflare write carries the comment `managed-by:mailops`,** and the client refuses to update or delete a record lacking it.
- **Only port 25 is published.** No 587, 143, 993, 80 or 443.
- **Node 22**, ESM modules (`"type": "module"`), TypeScript run directly through `tsx` with no build step.
- **Tests use `node:test` and `node:assert/strict`.** No Jest, no Vitest.

### Addition to the spec

The spec's volume list omits a shared log volume, but its health section requires `mailops` to read Postfix logs for inbound connection staleness. This plan adds a `mail-logs` volume, written by `mailserver` and mounted read-only into `mailops`. Everything else follows the spec as written.

### File structure

```
mail/
  docker-compose.yml          Task 9
  .env.example                Task 9
  RUNBOOK.md                  Task 9
  mailops/
    Dockerfile                Task 9
    package.json              Task 1
    tsconfig.json             Task 1
    src/
      config.ts               Task 1   env parsing, validation, derivation
      config.test.ts
      desired.ts              Task 2   pure: desired DNS record set
      desired.test.ts
      cloudflare.ts           Task 3   Cloudflare client, managed-by guard
      cloudflare.test.ts
      reconcile.ts            Task 4   desired vs actual, idempotent
      reconcile.test.ts
      adapters.ts             Task 5   public IP, DKIM key, alias map
      adapters.test.ts
      probes.ts               Task 6   SMTP banner, Spamhaus, log staleness
      probes.test.ts
      health.ts               Task 7   boot gate, assertions, status file
      health.test.ts
      certs.ts                Task 8   renewal window, lego invocation
      certs.test.ts
      index.ts                Task 7   boot gate then reconcile loop
```

---

### Task 1: Scaffold and configuration

Creates the `mailops` package and the module that turns environment variables into a validated, derived config object. Everything downstream consumes `Config`, so this task locks in the names other tasks use.

**Files:**
- Create: `mail/mailops/package.json`
- Create: `mail/mailops/tsconfig.json`
- Create: `mail/mailops/src/config.ts`
- Test: `mail/mailops/src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Config`, `type RelayConfig`, `class ConfigError`, `function loadConfig(env: Record<string, string | undefined>): Config`.

- [ ] **Step 1: Create the package manifest**

Create `mail/mailops/package.json`:

```json
{
  "name": "mailops",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test src/*.test.ts",
    "start": "node --import tsx src/index.ts"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

Create `mail/mailops/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"],
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd mail/mailops && npm install`
Expected: `node_modules` created, no errors.

- [ ] **Step 4: Write the failing test**

Create `mail/mailops/src/config.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from './config.ts'

const base = {
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
}

// node:assert's throws() returns undefined, so the error has to be caught by hand to inspect it.
function failuresOf(env: Record<string, string | undefined>): string[] {
    try {
        loadConfig(env)
    } catch (error) {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`)
        return error.failures
    }
    assert.fail('expected loadConfig to throw ConfigError')
}

describe('loadConfig', () => {
    it('derives the mail hostname from the domain', () => {
        assert.equal(loadConfig(base).mailHostname, 'mail.dev.horizons.gg')
    })

    it('defaults the delivery targets to forward', () => {
        assert.deepEqual(loadConfig(base).deliveryTargets, ['forward'])
    })

    it('defaults the DKIM selector to mail', () => {
        assert.equal(loadConfig(base).dkimSelector, 'mail')
    })

    it('reports a missing MAIL_DOMAIN by name', () => {
        assert.deepEqual(failuresOf({ ...base, MAIL_DOMAIN: undefined }), ['MAIL_DOMAIN is required'])
    })

    it('rejects a malformed domain', () => {
        assert.deepEqual(failuresOf({ ...base, MAIL_DOMAIN: 'not a domain' }), ['MAIL_DOMAIN is not a valid domain name'])
    })

    it('collects every failure rather than stopping at the first', () => {
        assert.equal(failuresOf({}).length, 5)
    })

    it('leaves relay null when RELAY_HOST is empty', () => {
        assert.equal(loadConfig({ ...base, RELAY_HOST: '' }).relay, null)
    })

    it('populates relay when RELAY_HOST is set', () => {
        const config = loadConfig({
            ...base,
            RELAY_HOST: 'smtp.relay.test',
            RELAY_PORT: '587',
            RELAY_USER: 'user',
            RELAY_PASSWORD: 'pass',
            RELAY_SPF_INCLUDE: '_spf.relay.test',
        })
        assert.deepEqual(config.relay, {
            host: 'smtp.relay.test',
            port: 587,
            user: 'user',
            password: 'pass',
            spfInclude: '_spf.relay.test',
        })
    })

    it('rejects a relay without an SPF include, because SPF would silently break', () => {
        const failures = failuresOf({
            ...base,
            RELAY_HOST: 'smtp.relay.test',
            RELAY_USER: 'user',
            RELAY_PASSWORD: 'pass',
        })
        assert.ok(failures.includes('RELAY_SPF_INCLUDE is required when RELAY_HOST is set'))
    })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./config.ts`.

- [ ] **Step 6: Write the implementation**

Create `mail/mailops/src/config.ts`:

```ts
// Turns the environment into a validated, fully derived config. Every other module takes Config and never
// reads process.env itself, so there is exactly one place where a missing variable can be discovered.

export type RelayConfig = {
    host: string
    port: number
    user: string
    password: string
    spfInclude: string
}

export type Config = {
    mailDomain: string
    mailHostname: string
    forwardTo: string
    cfApiToken: string
    cfZoneId: string
    dmarcRua: string
    deliveryTargets: string[]
    dkimSelector: string
    relay: RelayConfig | null
}

export class ConfigError extends Error {
    constructor(readonly failures: string[]) {
        super(`Invalid configuration:\n  ${failures.join('\n  ')}`)
        this.name = 'ConfigError'
    }
}

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

type Env = Record<string, string | undefined>

function required(env: Env, key: string, failures: string[]): string {
    const value = env[key]?.trim()
    if (!value) {
        failures.push(`${key} is required`)
        return ''
    }
    return value
}

export function loadConfig(env: Env): Config {
    const failures: string[] = []

    const mailDomain = required(env, 'MAIL_DOMAIN', failures)
    if (mailDomain && !DOMAIN.test(mailDomain)) failures.push('MAIL_DOMAIN is not a valid domain name')

    const forwardTo = required(env, 'FORWARD_TO', failures)
    const cfApiToken = required(env, 'CF_API_TOKEN', failures)
    const cfZoneId = required(env, 'CF_ZONE_ID', failures)
    const dmarcRua = required(env, 'DMARC_RUA', failures)

    const relayHost = env.RELAY_HOST?.trim() ?? ''
    let relay: RelayConfig | null = null
    if (relayHost) {
        const spfInclude = env.RELAY_SPF_INCLUDE?.trim() ?? ''
        // Without this, flipping the relay on would leave SPF authorising only our own address, and every
        // relayed message would soft-fail. Refuse to start rather than half-configure it.
        if (!spfInclude) failures.push('RELAY_SPF_INCLUDE is required when RELAY_HOST is set')
        relay = {
            host: relayHost,
            port: Number(env.RELAY_PORT?.trim() || '587'),
            user: env.RELAY_USER?.trim() ?? '',
            password: env.RELAY_PASSWORD?.trim() ?? '',
            spfInclude,
        }
    }

    if (failures.length > 0) throw new ConfigError(failures)

    return {
        mailDomain,
        mailHostname: `mail.${mailDomain}`,
        forwardTo,
        cfApiToken,
        cfZoneId,
        dmarcRua,
        deliveryTargets: (env.DELIVERY_TARGETS?.trim() || 'forward').split(',').map(t => t.trim()),
        dkimSelector: env.DKIM_SELECTOR?.trim() || 'mail',
        relay,
    }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add mail/mailops/package.json mail/mailops/tsconfig.json mail/mailops/package-lock.json mail/mailops/src/config.ts mail/mailops/src/config.test.ts
git commit -m "Add the mailops package and its configuration module"
```

---

### Task 2: Desired DNS state

Pure computation: given config, the current IP and the DKIM key, produce the record set that should exist. No network. This is the module that decides what correct looks like, so it carries the heaviest test coverage.

**Files:**
- Create: `mail/mailops/src/desired.ts`
- Test: `mail/mailops/src/desired.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`.
- Produces: `type DesiredRecord = { type: 'A' | 'MX' | 'TXT', name: string, content: string, ttl: number, proxied?: boolean, priority?: number }`, `function spfContent(config: Config): string`, `function desiredRecords(config: Config, ip: string, dkimPublicKey: string | null): DesiredRecord[]`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/desired.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { spfContent, desiredRecords } from './desired.ts'

const base = {
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
}

const direct = loadConfig(base)
const relayed = loadConfig({
    ...base,
    RELAY_HOST: 'smtp.relay.test',
    RELAY_USER: 'u',
    RELAY_PASSWORD: 'p',
    RELAY_SPF_INCLUDE: '_spf.relay.test',
})

const find = (records: ReturnType<typeof desiredRecords>, name: string, type: string) =>
    records.find(r => r.name === name && r.type === type)

describe('spfContent', () => {
    it('authorises only the mail host when sending direct', () => {
        assert.equal(spfContent(direct), 'v=spf1 a:mail.dev.horizons.gg ~all')
    })

    it('adds the relay include when a relay is configured', () => {
        assert.equal(spfContent(relayed), 'v=spf1 a:mail.dev.horizons.gg include:_spf.relay.test ~all')
    })

    it('ends in a soft fail while the setup is unproven', () => {
        assert.ok(spfContent(direct).endsWith('~all'))
    })
})

describe('desiredRecords', () => {
    it('points the A record at the current IP, unproxied, with a short TTL', () => {
        const a = find(desiredRecords(direct, '1.2.3.4', null), 'mail.dev.horizons.gg', 'A')
        assert.deepEqual(a, {
            type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false,
        })
    })

    it('points MX at the mail host with priority 10', () => {
        const mx = find(desiredRecords(direct, '1.2.3.4', null), 'dev.horizons.gg', 'MX')
        assert.equal(mx?.content, 'mail.dev.horizons.gg')
        assert.equal(mx?.priority, 10)
    })

    it('starts DMARC at p=none with the configured reporting address', () => {
        const dmarc = find(desiredRecords(direct, '1.2.3.4', null), '_dmarc.dev.horizons.gg', 'TXT')
        assert.equal(dmarc?.content, 'v=DMARC1; p=none; rua=mailto:me@example.com')
    })

    it('omits the DKIM record until the key exists, keeping the other four', () => {
        const records = desiredRecords(direct, '1.2.3.4', null)
        assert.equal(find(records, 'mail._domainkey.dev.horizons.gg', 'TXT'), undefined)
        assert.equal(records.length, 4)
    })

    it('publishes the DKIM record once the key appears', () => {
        const key = 'v=DKIM1; h=sha256; k=rsa; p=ABC123'
        const dkim = find(desiredRecords(direct, '1.2.3.4', key), 'mail._domainkey.dev.horizons.gg', 'TXT')
        assert.equal(dkim?.content, key)
    })

    it('never marks any record proxied, because Cloudflare cannot proxy SMTP', () => {
        for (const record of desiredRecords(direct, '1.2.3.4', 'v=DKIM1; p=X')) {
            assert.notEqual(record.proxied, true)
        }
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./desired.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/desired.ts`:

```ts
// What the zone should look like, computed from config plus two things that change at runtime: the public
// IP and whether the DKIM key exists yet. Pure, so the interesting logic is testable without a network.

import type { Config } from './config.ts'

export type DesiredRecord = {
    type: 'A' | 'MX' | 'TXT'
    name: string
    content: string
    ttl: number
    proxied?: boolean
    priority?: number
}

// SPF is derived rather than fixed so that flipping the relay switch cannot leave it stale. It ends in a
// soft fail (~all) deliberately: on an unproven IP a visible DMARC report beats a silent hard rejection.
export function spfContent(config: Config): string {
    const parts = ['v=spf1', `a:${config.mailHostname}`]
    if (config.relay) parts.push(`include:${config.relay.spfInclude}`)
    parts.push('~all')
    return parts.join(' ')
}

export function desiredRecords(config: Config, ip: string, dkimPublicKey: string | null): DesiredRecord[] {
    const records: DesiredRecord[] = [
        // proxied: false is mandatory. Cloudflare's proxy is HTTP only and a proxied host breaks SMTP silently.
        { type: 'A', name: config.mailHostname, content: ip, ttl: 60, proxied: false },
        { type: 'MX', name: config.mailDomain, content: config.mailHostname, ttl: 300, priority: 10 },
        { type: 'TXT', name: config.mailDomain, content: spfContent(config), ttl: 300 },
    ]

    if (dkimPublicKey) {
        records.push({
            type: 'TXT',
            name: `${config.dkimSelector}._domainkey.${config.mailDomain}`,
            content: dkimPublicKey,
            ttl: 300,
        })
    }

    records.push({
        type: 'TXT',
        name: `_dmarc.${config.mailDomain}`,
        content: `v=DMARC1; p=none; rua=mailto:${config.dmarcRua}`,
        ttl: 300,
    })

    return records
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 22 tests total.

- [ ] **Step 5: Commit**

```bash
git add mail/mailops/src/desired.ts mail/mailops/src/desired.test.ts
git commit -m "Compute the desired DNS record set from the mail domain"
```

---

### Task 3: Cloudflare client and the managed-by guard

The API client, and the safety property the whole design rests on. The token can edit the live site's records, so the client refuses to modify anything it did not create.

**Files:**
- Create: `mail/mailops/src/cloudflare.ts`
- Test: `mail/mailops/src/cloudflare.test.ts`

**Interfaces:**
- Consumes: `DesiredRecord` from `./desired.ts`.
- Produces: `const MANAGED_COMMENT = 'managed-by:mailops'`, `type CloudflareRecord`, `class UnmanagedRecordError`, `function isManaged(record: CloudflareRecord): boolean`, `function matches(existing: CloudflareRecord, desired: DesiredRecord): boolean`, `interface DnsApi { list, create, update }`, `function createCloudflareApi(token: string, zoneId: string, fetchImpl?: typeof fetch): DnsApi`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/cloudflare.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    MANAGED_COMMENT, isManaged, matches, createCloudflareApi, UnmanagedRecordError,
    type CloudflareRecord,
} from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'

const managed: CloudflareRecord = {
    id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4',
    ttl: 60, proxied: false, comment: MANAGED_COMMENT,
}

const desired: DesiredRecord = {
    type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false,
}

describe('isManaged', () => {
    it('accepts a record carrying our comment', () => {
        assert.equal(isManaged(managed), true)
    })

    it('rejects a record with no comment', () => {
        assert.equal(isManaged({ ...managed, comment: undefined }), false)
    })

    it('rejects a record with someone else comment', () => {
        assert.equal(isManaged({ ...managed, comment: 'the website' }), false)
    })
})

describe('matches', () => {
    it('is true when content, ttl and proxied all agree', () => {
        assert.equal(matches(managed, desired), true)
    })

    it('is false when the IP has changed', () => {
        assert.equal(matches({ ...managed, content: '9.9.9.9' }, desired), false)
    })

    it('is false when proxied has drifted on', () => {
        assert.equal(matches({ ...managed, proxied: true }, desired), false)
    })

    it('compares MX priority', () => {
        const mx: DesiredRecord = { type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10 }
        const existing: CloudflareRecord = { id: '2', type: 'MX', name: mx.name, content: mx.content, ttl: 300, priority: 20, comment: MANAGED_COMMENT }
        assert.equal(matches(existing, mx), false)
        assert.equal(matches({ ...existing, priority: 10 }, mx), true)
    })
})

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
    const calls: { url: string, init?: RequestInit }[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        calls.push({ url: href, init })
        return new Response(JSON.stringify({ success: true, errors: [], result: handler(href, init) }), {
            status: 200, headers: { 'content-type': 'application/json' },
        })
    }) as unknown as typeof fetch
    return { impl, calls }
}

describe('createCloudflareApi', () => {
    it('stamps every created record with the managed comment', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        await createCloudflareApi('token', 'zone', impl).create(desired)
        const body = JSON.parse(String(calls[0]?.init?.body))
        assert.equal(body.comment, MANAGED_COMMENT)
        assert.equal(body.proxied, false)
    })

    it('refuses to update a record it did not create', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        const api = createCloudflareApi('token', 'zone', impl)
        await assert.rejects(
            () => api.update({ ...managed, comment: undefined }, { ...desired, content: '9.9.9.9' }),
            UnmanagedRecordError,
        )
        assert.equal(calls.length, 0, 'no request should be sent')
    })

    it('updates a record it does own', async () => {
        const { impl, calls } = stubFetch(() => ({}))
        await createCloudflareApi('token', 'zone', impl).update(managed, { ...desired, content: '9.9.9.9' })
        assert.equal(calls.length, 1)
        assert.match(String(calls[0]?.url), /dns_records\/1$/)
    })

    it('sends the token as a bearer credential', async () => {
        const { impl, calls } = stubFetch(() => [])
        await createCloudflareApi('token', 'zone', impl).list('mail.dev.horizons.gg', 'A')
        const headers = calls[0]?.init?.headers as Record<string, string>
        assert.equal(headers.Authorization, 'Bearer token')
    })

    it('throws when Cloudflare reports failure', async () => {
        const impl = (async () => new Response(
            JSON.stringify({ success: false, errors: [{ message: 'bad token' }], result: null }),
            { status: 403, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch
        await assert.rejects(() => createCloudflareApi('token', 'zone', impl).list('x', 'A'), /bad token/)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./cloudflare.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/cloudflare.ts`:

```ts
// The Cloudflare DNS client. The token can edit every record in the zone, including the ones serving the
// live site, so the guard lives here at the edge rather than in the caller: update and delete refuse any
// record that does not carry our comment, and no request is sent when they refuse.

import type { DesiredRecord } from './desired.ts'

export const MANAGED_COMMENT = 'managed-by:mailops'

export type CloudflareRecord = {
    id: string
    type: string
    name: string
    content: string
    ttl: number
    proxied?: boolean
    priority?: number
    comment?: string
}

export class UnmanagedRecordError extends Error {
    constructor(record: CloudflareRecord) {
        super(`Refusing to modify ${record.type} ${record.name}: it is not stamped ${MANAGED_COMMENT}`)
        this.name = 'UnmanagedRecordError'
    }
}

export function isManaged(record: CloudflareRecord): boolean {
    return record.comment === MANAGED_COMMENT
}

export function matches(existing: CloudflareRecord, desired: DesiredRecord): boolean {
    return existing.content === desired.content
        && existing.ttl === desired.ttl
        && (existing.proxied ?? false) === (desired.proxied ?? false)
        && (existing.priority ?? null) === (desired.priority ?? null)
}

export interface DnsApi {
    list(name: string, type: string): Promise<CloudflareRecord[]>
    create(desired: DesiredRecord): Promise<void>
    update(existing: CloudflareRecord, desired: DesiredRecord): Promise<void>
}

function body(desired: DesiredRecord) {
    return JSON.stringify({
        type: desired.type,
        name: desired.name,
        content: desired.content,
        ttl: desired.ttl,
        ...(desired.proxied !== undefined && { proxied: desired.proxied }),
        ...(desired.priority !== undefined && { priority: desired.priority }),
        comment: MANAGED_COMMENT,
    })
}

export function createCloudflareApi(token: string, zoneId: string, fetchImpl: typeof fetch = fetch): DnsApi {
    const root = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    async function call(url: string, init?: RequestInit): Promise<unknown> {
        const response = await fetchImpl(url, { ...init, headers })
        const payload = await response.json() as { success: boolean, errors?: { message: string }[], result: unknown }
        if (!payload.success) {
            throw new Error(`Cloudflare API error: ${payload.errors?.map(e => e.message).join('; ') || response.status}`)
        }
        return payload.result
    }

    return {
        async list(name, type) {
            const query = new URLSearchParams({ name, type })
            return await call(`${root}?${query}`) as CloudflareRecord[]
        },
        async create(desired) {
            await call(root, { method: 'POST', body: body(desired) })
        },
        async update(existing, desired) {
            // Checked before the request is built, so a refusal cannot race a partially formed write.
            if (!isManaged(existing)) throw new UnmanagedRecordError(existing)
            await call(`${root}/${existing.id}`, { method: 'PATCH', body: body(desired) })
        },
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 34 tests total.

- [ ] **Step 5: Commit**

```bash
git add mail/mailops/src/cloudflare.ts mail/mailops/src/cloudflare.test.ts
git commit -m "Add the Cloudflare client, which refuses records it does not own"
```

---

### Task 4: The reconciler

Compares desired against actual and writes only the difference. Idempotent, and surfaces conflicts rather than resolving them.

**Files:**
- Create: `mail/mailops/src/reconcile.ts`
- Test: `mail/mailops/src/reconcile.test.ts`

**Interfaces:**
- Consumes: `DnsApi`, `CloudflareRecord`, `isManaged`, `matches` from `./cloudflare.ts`; `DesiredRecord` from `./desired.ts`.
- Produces: `type ReconcileResult = { created: string[], updated: string[], unchanged: string[], conflicts: string[] }`, `function reconcile(api: DnsApi, desired: DesiredRecord[]): Promise<ReconcileResult>`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/reconcile.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGED_COMMENT, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'
import { reconcile } from './reconcile.ts'

const desired: DesiredRecord[] = [
    { type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false },
    { type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10 },
]

function fakeApi(existing: CloudflareRecord[]) {
    const writes: string[] = []
    const api: DnsApi = {
        async list(name, type) {
            return existing.filter(r => r.name === name && r.type === type)
        },
        async create(record) { writes.push(`create ${record.type} ${record.name}`) },
        async update(record) { writes.push(`update ${record.type} ${record.name}`) },
    }
    return { api, writes }
}

describe('reconcile', () => {
    it('creates every record on an empty zone', async () => {
        const { api, writes } = fakeApi([])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.created, ['A mail.dev.horizons.gg', 'MX dev.horizons.gg'])
        assert.equal(writes.length, 2)
    })

    it('writes nothing on a second run', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false, comment: MANAGED_COMMENT },
            { id: '2', type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10, comment: MANAGED_COMMENT },
        ])
        const result = await reconcile(api, desired)
        assert.equal(writes.length, 0)
        assert.equal(result.unchanged.length, 2)
    })

    it('updates only the record that drifted when the IP changes', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '9.9.9.9', ttl: 60, proxied: false, comment: MANAGED_COMMENT },
            { id: '2', type: 'MX', name: 'dev.horizons.gg', content: 'mail.dev.horizons.gg', ttl: 300, priority: 10, comment: MANAGED_COMMENT },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.updated, ['A mail.dev.horizons.gg'])
        assert.equal(writes.length, 1)
    })

    it('reports a conflict and writes nothing when an unstamped record is in the way', async () => {
        const { api, writes } = fakeApi([
            { id: '1', type: 'A', name: 'mail.dev.horizons.gg', content: '9.9.9.9', ttl: 300 },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.conflicts, ['A mail.dev.horizons.gg'])
        assert.equal(result.created.length, 1, 'the MX is still created')
        assert.ok(!writes.includes('update A mail.dev.horizons.gg'))
    })

    it('ignores an unstamped record of a different type at the same name', async () => {
        const { api } = fakeApi([
            { id: '1', type: 'TXT', name: 'mail.dev.horizons.gg', content: 'unrelated', ttl: 300 },
        ])
        const result = await reconcile(api, desired)
        assert.deepEqual(result.conflicts, [])
        assert.equal(result.created.length, 2)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./reconcile.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/reconcile.ts`:

```ts
// Desired versus actual, writing only the difference. Runs every cycle, so the code path that sets the zone
// up initially is the same one that repairs it after an unattended IP change at 3am.

import { isManaged, matches, type CloudflareRecord, type DnsApi } from './cloudflare.ts'
import type { DesiredRecord } from './desired.ts'

export type ReconcileResult = {
    created: string[]
    updated: string[]
    unchanged: string[]
    conflicts: string[]
}

const label = (record: { type: string, name: string }) => `${record.type} ${record.name}`

export async function reconcile(api: DnsApi, desired: DesiredRecord[]): Promise<ReconcileResult> {
    const result: ReconcileResult = { created: [], updated: [], unchanged: [], conflicts: [] }

    for (const want of desired) {
        const existing: CloudflareRecord[] = await api.list(want.name, want.type)
        const ours = existing.find(isManaged)

        if (ours) {
            if (matches(ours, want)) result.unchanged.push(label(want))
            else {
                await api.update(ours, want)
                result.updated.push(label(want))
            }
            continue
        }

        // Something is already at this name and type that we did not create. Adopting it would mean editing
        // a record a human put there deliberately, so surface it and leave it completely alone.
        if (existing.length > 0) {
            result.conflicts.push(label(want))
            continue
        }

        await api.create(want)
        result.created.push(label(want))
    }

    return result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 39 tests total.

- [ ] **Step 5: Commit**

```bash
git add mail/mailops/src/reconcile.ts mail/mailops/src/reconcile.test.ts
git commit -m "Reconcile the desired records against the zone, writing only differences"
```

---

### Task 5: Adapters for the IP, the DKIM key and the alias map

Three small bridges to the outside world. Each keeps its parsing pure and its IO in a one-line wrapper, so the logic is testable without a network or a filesystem.

**Files:**
- Create: `mail/mailops/src/adapters.ts`
- Test: `mail/mailops/src/adapters.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`.
- Produces: `function parseTrace(body: string): string`, `function fetchPublicIp(fetchImpl?: typeof fetch): Promise<string>`, `function parseDkimRecord(bind: string): string | null`, `function readDkimKey(configDir: string, config: Config): Promise<string | null>`, `function aliasMap(config: Config): string`, `function writeAliasMap(configDir: string, config: Config): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/adapters.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { parseTrace, parseDkimRecord, aliasMap } from './adapters.ts'

const config = loadConfig({
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
})

describe('parseTrace', () => {
    it('pulls the address out of a Cloudflare trace body', () => {
        assert.equal(parseTrace('fl=1f2\nh=cloudflare.com\nip=124.177.8.46\nts=1\n'), '124.177.8.46')
    })

    it('throws when no address is present', () => {
        assert.throws(() => parseTrace('h=cloudflare.com\n'), /could not determine public IP/i)
    })
})

describe('parseDkimRecord', () => {
    it('joins the quoted chunks of a BIND formatted key', () => {
        const bind = [
            'mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "',
            '   "p=MIIBIjANBgkq" )  ; ----- DKIM key mail for dev.horizons.gg',
        ].join('\n')
        assert.equal(parseDkimRecord(bind), 'v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq')
    })

    it('returns null for an empty file, which is how a key not yet generated looks', () => {
        assert.equal(parseDkimRecord(''), null)
    })

    it('returns null when the file has no quoted content', () => {
        assert.equal(parseDkimRecord('; a comment only'), null)
    })
})

describe('aliasMap', () => {
    it('maps the contact address to the forwarding target', () => {
        assert.ok(aliasMap(config).startsWith('contact@dev.horizons.gg me@example.com\n'))
    })

    it('adds a catch-all so nothing addressed to the domain is refused', () => {
        assert.equal(aliasMap(config), 'contact@dev.horizons.gg me@example.com\n@dev.horizons.gg me@example.com\n')
    })

    it('produces nothing for a target that is not implemented yet', () => {
        assert.equal(aliasMap({ ...config, deliveryTargets: ['ingest'] }), '')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./adapters.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/adapters.ts`:

```ts
// Bridges to the world outside the process: the current public address, the DKIM key that docker-mailserver
// generates on its own schedule, and the alias map we own. Parsing is pure; the IO around it is one line.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'

const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'

export function parseTrace(body: string): string {
    const match = body.match(/^ip=(.+)$/m)
    if (!match?.[1]) throw new Error('Could not determine public IP from the trace response')
    return match[1].trim()
}

// Cloudflare's own endpoint, so the address we publish and the service we publish it to agree, and no third
// party sits in the loop.
export async function fetchPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
    const response = await fetchImpl(TRACE_URL)
    return parseTrace(await response.text())
}

// OpenDKIM writes a BIND fragment with the key split across quoted chunks. Rejoin them into the single
// string a TXT record needs.
export function parseDkimRecord(bind: string): string | null {
    const chunks = bind.match(/"([^"]*)"/g)
    if (!chunks || chunks.length === 0) return null
    const joined = chunks.map(c => c.slice(1, -1)).join('')
    return joined.trim() === '' ? null : joined
}

// Returns null while the key does not exist yet. docker-mailserver generates it on first start, so the first
// few cycles legitimately find nothing and simply publish the rest of the records.
export async function readDkimKey(configDir: string, config: Config): Promise<string | null> {
    const path = join(configDir, 'opendkim', 'keys', config.mailDomain, `${config.dkimSelector}.txt`)
    try {
        return parseDkimRecord(await readFile(path, 'utf8'))
    } catch {
        return null
    }
}

// The delivery seam. Only 'forward' is implemented in this phase; 'ingest' is recognised and deliberately
// produces nothing, so adding it later is additive rather than a rewrite.
export function aliasMap(config: Config): string {
    if (!config.deliveryTargets.includes('forward')) return ''
    return [
        `contact@${config.mailDomain} ${config.forwardTo}`,
        `@${config.mailDomain} ${config.forwardTo}`,
    ].join('\n') + '\n'
}

export async function writeAliasMap(configDir: string, config: Config): Promise<void> {
    const path = join(configDir, 'postfix-virtual.cf')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, aliasMap(config), 'utf8')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 47 tests total.

- [ ] **Step 5: Commit**

```bash
git add mail/mailops/src/adapters.ts mail/mailops/src/adapters.test.ts
git commit -m "Read the public IP and DKIM key, and generate the alias map"
```

---

### Task 6: Health probes

The three checks that tell us whether the environment is still what we assumed. Each parses pure, so the interesting cases are tested without network calls.

**Files:**
- Create: `mail/mailops/src/probes.ts`
- Test: `mail/mailops/src/probes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type SmtpProbe = { ok: boolean, banner?: string, error?: string }`, `function probeOutboundSmtp(host: string, port?: number, timeoutMs?: number): Promise<SmtpProbe>`, `type SpamhausResult = { listed: boolean, inconclusive: boolean, codes: string[], meanings: string[] }`, `function interpretSpamhaus(codes: string[]): SpamhausResult`, `function checkSpamhaus(ip: string, resolve?: (name: string) => Promise<string[]>): Promise<SpamhausResult>`, `function lastInboundConnection(log: string): Date | null`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/probes.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { interpretSpamhaus, checkSpamhaus, lastInboundConnection } from './probes.ts'

describe('interpretSpamhaus', () => {
    it('reads a PBL listing as listed', () => {
        const result = interpretSpamhaus(['127.0.0.10'])
        assert.equal(result.listed, true)
        assert.equal(result.inconclusive, false)
        assert.deepEqual(result.meanings, ['PBL: ISP-declared non-mail range'])
    })

    it('reads an XBL listing, which is the one an inherited IP brings', () => {
        assert.deepEqual(interpretSpamhaus(['127.0.0.4']).meanings, ['XBL: exploited or compromised host'])
    })

    it('treats the public-resolver refusal as inconclusive, not as a listing', () => {
        const result = interpretSpamhaus(['127.255.255.254'])
        assert.equal(result.listed, false)
        assert.equal(result.inconclusive, true)
    })

    it('reports nothing listed for an empty answer', () => {
        assert.deepEqual(interpretSpamhaus([]), { listed: false, inconclusive: false, codes: [], meanings: [] })
    })
})

describe('checkSpamhaus', () => {
    it('queries the reversed address', async () => {
        const seen: string[] = []
        await checkSpamhaus('124.177.8.46', async name => { seen.push(name); return [] })
        assert.deepEqual(seen, ['46.8.177.124.zen.spamhaus.org'])
    })

    it('treats NXDOMAIN as not listed', async () => {
        const result = await checkSpamhaus('1.2.3.4', async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) })
        assert.equal(result.listed, false)
        assert.equal(result.inconclusive, false)
    })

    it('treats any other resolver error as inconclusive', async () => {
        const result = await checkSpamhaus('1.2.3.4', async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) })
        assert.equal(result.inconclusive, true)
    })
})

describe('lastInboundConnection', () => {
    it('finds the most recent inbound connection', () => {
        const log = [
            'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from mail-sor.google.com[209.85.220.41]',
            'Sep 18 11:30:02 mail postfix/smtpd[2]: connect from mx.example.com[1.2.3.4]',
        ].join('\n')
        const found = lastInboundConnection(log)
        assert.equal(found?.getMonth(), 8)
        assert.equal(found?.getDate(), 18)
        assert.equal(found?.getHours(), 11)
    })

    it('ignores connections from localhost, which are our own health checks', () => {
        const log = 'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from localhost[127.0.0.1]'
        assert.equal(lastInboundConnection(log), null)
    })

    it('returns null for a log with no connections yet', () => {
        assert.equal(lastInboundConnection('Sep 18 09:00:01 mail postfix/master[1]: daemon started'), null)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./probes.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/probes.ts`:

```ts
// The checks that tell us whether the environment still matches what the design assumed. Written against an
// address we do not control, so all three are expected to change answer without warning.

import net from 'node:net'
import { Resolver } from 'node:dns/promises'

export type SmtpProbe = { ok: boolean, banner?: string, error?: string }

// Connect to a real MX and read its greeting. A blocked port 25 shows up as a connect timeout rather than a
// refusal, so the timeout is the meaningful signal here.
export function probeOutboundSmtp(host: string, port = 25, timeoutMs = 8000): Promise<SmtpProbe> {
    return new Promise(resolve => {
        const socket = net.connect({ host, port })
        const done = (result: SmtpProbe) => {
            socket.removeAllListeners()
            socket.destroy()
            resolve(result)
        }
        socket.setTimeout(timeoutMs)
        socket.once('timeout', () => done({ ok: false, error: `no banner from ${host}:${port} within ${timeoutMs}ms` }))
        socket.once('error', error => done({ ok: false, error: (error as Error).message }))
        socket.once('data', chunk => {
            const banner = chunk.toString('ascii').trim()
            done({ ok: banner.startsWith('220'), banner })
        })
    })
}

export type SpamhausResult = { listed: boolean, inconclusive: boolean, codes: string[], meanings: string[] }

const SPAMHAUS_CODES: Record<string, string> = {
    '127.0.0.2': 'SBL: spam source',
    '127.0.0.3': 'SBL CSS: snowshoe spam',
    '127.0.0.4': 'XBL: exploited or compromised host',
    '127.0.0.9': 'SBL DROP',
    '127.0.0.10': 'PBL: ISP-declared non-mail range',
    '127.0.0.11': 'PBL: Spamhaus-declared non-mail range',
}

// 127.255.255.254 means the query was refused because it came through a public resolver, not that the address
// is listed. Reporting that as a listing would be a false alarm every cycle on a default resolver setup.
const REFUSED = '127.255.255.254'

export function interpretSpamhaus(codes: string[]): SpamhausResult {
    if (codes.includes(REFUSED)) {
        return { listed: false, inconclusive: true, codes, meanings: ['query refused: use a non-public DNS resolver'] }
    }
    const meanings = codes.map(code => SPAMHAUS_CODES[code] ?? `unrecognised code ${code}`)
    return { listed: codes.length > 0, inconclusive: false, codes, meanings }
}

const defaultResolve = (name: string) => new Resolver().resolve4(name)

export async function checkSpamhaus(ip: string, resolve = defaultResolve): Promise<SpamhausResult> {
    const query = `${ip.split('.').reverse().join('.')}.zen.spamhaus.org`
    try {
        return interpretSpamhaus(await resolve(query))
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // NXDOMAIN is the normal "not listed" answer. Anything else means we did not get an answer at all.
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
            return { listed: false, inconclusive: false, codes: [], meanings: [] }
        }
        return { listed: false, inconclusive: true, codes: [], meanings: [`lookup failed: ${code ?? 'unknown'}`] }
    }
}

const CONNECT = /^(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2}).*postfix\/smtpd.*connect from (?!localhost)/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Evidence that inbound 25 actually reaches us. We cannot test that ourselves from inside the network, since
// NAT loopback would report success regardless, so real deliveries are the honest signal.
export function lastInboundConnection(log: string): Date | null {
    let latest: Date | null = null
    for (const line of log.split('\n')) {
        const match = CONNECT.exec(line)
        if (!match) continue
        const month = MONTHS.indexOf(match[1]!)
        if (month < 0) continue
        const when = new Date(new Date().getFullYear(), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
        if (!latest || when > latest) latest = when
    }
    return latest
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, 60 tests total.

- [ ] **Step 5: Commit**

```bash
git add mail/mailops/src/probes.ts mail/mailops/src/probes.test.ts
git commit -m "Add the outbound SMTP, Spamhaus and inbound staleness probes"
```

---

### Task 7: Boot gate, status and the main loop

Wires everything together under the rule from the spec: hard-fail only on configuration errors knowable before accepting mail, and degrade loudly on everything else.

**Files:**
- Create: `mail/mailops/src/health.ts`
- Create: `mail/mailops/src/index.ts`
- Test: `mail/mailops/src/health.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`; `SmtpProbe`, `SpamhausResult` from `./probes.ts`; `ReconcileResult` from `./reconcile.ts`.
- Produces: `class BootGateError`, `type BootChecks = { outbound: SmtpProbe, publicIp: string | null, cloudflareOk: boolean }`, `function evaluateBootGate(checks: BootChecks): string[]`, `type Warning = { check: string, detail: string }`, `type StatusInput = { reconcile: ReconcileResult, spamhaus: SpamhausResult, lastInbound: Date | null, now: Date, inboundStaleAfterHours?: number }`, `function collectWarnings(input: StatusInput): Warning[]`, `function writeStatus(path: string, warnings: Warning[], now: Date): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/health.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBootGate, collectWarnings } from './health.ts'

const healthy = {
    outbound: { ok: true, banner: '220 mx.google.com ESMTP' },
    publicIp: '124.177.8.46',
    cloudflareOk: true,
}

describe('evaluateBootGate', () => {
    it('passes when everything the stack needs before accepting mail is present', () => {
        assert.deepEqual(evaluateBootGate(healthy), [])
    })

    it('fails, by name, when outbound 25 is blocked', () => {
        const failures = evaluateBootGate({ ...healthy, outbound: { ok: false, error: 'timeout' } })
        assert.deepEqual(failures, ['outbound port 25 is unreachable: timeout'])
    })

    it('fails when the public IP cannot be determined', () => {
        assert.deepEqual(evaluateBootGate({ ...healthy, publicIp: null }), ['public IP could not be determined'])
    })

    it('fails when Cloudflare rejects the credentials', () => {
        assert.deepEqual(evaluateBootGate({ ...healthy, cloudflareOk: false }), ['Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID'])
    })
})

const quiet = {
    reconcile: { created: [], updated: [], unchanged: ['A mail.dev.horizons.gg'], conflicts: [] },
    spamhaus: { listed: false, inconclusive: false, codes: [], meanings: [] },
    lastInbound: new Date('2026-09-18T10:00:00Z'),
    now: new Date('2026-09-18T12:00:00Z'),
}

describe('collectWarnings', () => {
    it('is silent when everything is as it should be', () => {
        assert.deepEqual(collectWarnings(quiet), [])
    })

    it('warns about a DNS conflict, which means a record is not being maintained', () => {
        const warnings = collectWarnings({ ...quiet, reconcile: { ...quiet.reconcile, conflicts: ['A mail.dev.horizons.gg'] } })
        assert.equal(warnings[0]?.check, 'dns-conflict')
    })

    it('warns about a Spamhaus listing, which is how an inherited IP announces itself', () => {
        const warnings = collectWarnings({
            ...quiet,
            spamhaus: { listed: true, inconclusive: false, codes: ['127.0.0.4'], meanings: ['XBL: exploited or compromised host'] },
        })
        assert.equal(warnings[0]?.check, 'spamhaus')
        assert.match(warnings[0]!.detail, /XBL/)
    })

    it('does not warn on an inconclusive Spamhaus answer', () => {
        const warnings = collectWarnings({
            ...quiet,
            spamhaus: { listed: false, inconclusive: true, codes: [], meanings: ['query refused'] },
        })
        assert.deepEqual(warnings.filter(w => w.check === 'spamhaus'), [])
    })

    it('warns when no inbound mail has arrived for longer than the staleness window', () => {
        const warnings = collectWarnings({ ...quiet, now: new Date('2026-09-20T12:00:00Z') })
        assert.equal(warnings[0]?.check, 'inbound-stale')
    })

    it('does not warn when inbound mail has never arrived, because a new stack has no history', () => {
        assert.deepEqual(collectWarnings({ ...quiet, lastInbound: null }), [])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./health.ts`.

- [ ] **Step 3: Write the health module**

Create `mail/mailops/src/health.ts`:

```ts
// Two tiers, split on one rule: never fail closed on a condition whose failure mode is lost mail. Config
// errors knowable before we accept anything stop the process. Everything environmental warns and keeps running,
// because a stack that kills itself over a closed port receives nothing while the port is closed.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SmtpProbe, SpamhausResult } from './probes.ts'
import type { ReconcileResult } from './reconcile.ts'

export class BootGateError extends Error {
    constructor(readonly failures: string[]) {
        super(`Refusing to start:\n  ${failures.join('\n  ')}`)
        this.name = 'BootGateError'
    }
}

export type BootChecks = {
    outbound: SmtpProbe
    publicIp: string | null
    cloudflareOk: boolean
}

export function evaluateBootGate(checks: BootChecks): string[] {
    const failures: string[] = []
    if (!checks.outbound.ok) failures.push(`outbound port 25 is unreachable: ${checks.outbound.error ?? 'no banner'}`)
    if (!checks.publicIp) failures.push('public IP could not be determined')
    if (!checks.cloudflareOk) failures.push('Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID')
    return failures
}

export type Warning = { check: string, detail: string }

export type StatusInput = {
    reconcile: ReconcileResult
    spamhaus: SpamhausResult
    lastInbound: Date | null
    now: Date
    inboundStaleAfterHours?: number
}

export function collectWarnings(input: StatusInput): Warning[] {
    const warnings: Warning[] = []
    const staleAfter = input.inboundStaleAfterHours ?? 48

    if (input.reconcile.conflicts.length > 0) {
        warnings.push({
            check: 'dns-conflict',
            detail: `records not maintained because something unmanaged is in the way: ${input.reconcile.conflicts.join(', ')}`,
        })
    }

    // Inconclusive is not a listing. Warning on it would fire every cycle behind a public resolver.
    if (input.spamhaus.listed) {
        warnings.push({ check: 'spamhaus', detail: input.spamhaus.meanings.join('; ') })
    }

    // Only meaningful once we have received at least once. A fresh stack has no history and is not unhealthy.
    if (input.lastInbound) {
        const hours = (input.now.getTime() - input.lastInbound.getTime()) / 3_600_000
        if (hours > staleAfter) {
            warnings.push({ check: 'inbound-stale', detail: `no inbound connection for ${Math.floor(hours)}h` })
        }
    }

    return warnings
}

export async function writeStatus(path: string, warnings: Warning[], now: Date): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ok: warnings.length === 0, checkedAt: now.toISOString(), warnings }, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, whole suite green. The suite grows by the tests this task adds; the running total is not fixed, because earlier fix rounds added tests of their own.

- [ ] **Step 5: Write the entry point**

Create `mail/mailops/src/index.ts`:

```ts
// Boot gate once, then reconcile forever. The loop is deliberately the same code path as the initial setup.

import { readFile } from 'node:fs/promises'
import { loadConfig } from './config.ts'
import { desiredRecords } from './desired.ts'
import { createCloudflareApi } from './cloudflare.ts'
import { reconcile } from './reconcile.ts'
import { fetchPublicIp, readDkimKey, writeAliasMap } from './adapters.ts'
import { probeOutboundSmtp, checkSpamhaus, lastInboundConnection } from './probes.ts'
import { evaluateBootGate, collectWarnings, writeStatus, BootGateError } from './health.ts'
import { ensureCertificate } from './certs.ts'

const CONFIG_DIR = process.env.MAIL_CONFIG_DIR ?? '/mail-config'
const LOG_FILE = process.env.MAIL_LOG_FILE ?? '/mail-logs/mail.log'
const STATUS_FILE = process.env.MAILOPS_STATUS_FILE ?? '/health/status.json'
const CERT_DIR = process.env.MAIL_CERT_DIR ?? '/mail-certs'
const INTERVAL_MS = Number(process.env.MAILOPS_INTERVAL_MS ?? 60_000)
const OUTBOUND_PROBE_HOST = process.env.MAILOPS_PROBE_HOST ?? 'gmail-smtp-in.l.google.com'

const log = (message: string) => console.log(`[mailops] ${new Date().toISOString()} ${message}`)

async function main() {
    const config = loadConfig(process.env)
    log(`domain=${config.mailDomain} hostname=${config.mailHostname} relay=${config.relay ? config.relay.host : 'direct'}`)

    const api = createCloudflareApi(config.cfApiToken, config.cfZoneId)

    const outbound = await probeOutboundSmtp(OUTBOUND_PROBE_HOST)
    let publicIp: string | null = null
    try { publicIp = await fetchPublicIp() } catch { publicIp = null }
    let cloudflareOk = true
    try { await api.list(config.mailHostname, 'A') } catch { cloudflareOk = false }

    const failures = evaluateBootGate({ outbound, publicIp, cloudflareOk })
    if (failures.length > 0) throw new BootGateError(failures)
    log(`boot gate passed, banner: ${outbound.banner}`)

    await writeAliasMap(CONFIG_DIR, config)

    let lastIp: string | null = null
    for (;;) {
        try {
            const ip = await fetchPublicIp()
            const dkim = await readDkimKey(CONFIG_DIR, config)
            const result = await reconcile(api, desiredRecords(config, ip, dkim))

            if (result.created.length || result.updated.length) {
                log(`created=[${result.created}] updated=[${result.updated}]`)
            }

            // Only on change: a rotated address can arrive carrying a previous occupant's XBL listing, and that
            // is something to find out from a log line rather than from mail quietly failing.
            const spamhaus = ip === lastIp
                ? { listed: false, inconclusive: true, codes: [], meanings: [] }
                : await checkSpamhaus(ip)
            if (ip !== lastIp) {
                log(`public IP is ${ip}, spamhaus: ${spamhaus.listed ? spamhaus.meanings.join('; ') : 'not listed'}`)
                lastIp = ip
            }

            await ensureCertificate(config, CERT_DIR, new Date())

            const logText = await readFile(LOG_FILE, 'utf8').catch(() => '')
            const warnings = collectWarnings({
                reconcile: result, spamhaus, lastInbound: lastInboundConnection(logText), now: new Date(),
            })
            for (const warning of warnings) log(`WARN ${warning.check}: ${warning.detail}`)
            await writeStatus(STATUS_FILE, warnings, new Date())
        } catch (error) {
            // A failed cycle must never stop the loop. Mail keeps flowing while DNS or certificates are broken.
            log(`ERROR cycle failed: ${(error as Error).message}`)
        }
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
    }
}

main().catch(error => {
    console.error(error instanceof BootGateError ? error.message : error)
    process.exit(1)
})
```

- [ ] **Step 6: Verify the entry point type-checks**

Run: `cd mail/mailops && npx tsc --noEmit`
Expected: one error only, `Cannot find module './certs.ts'`, which Task 8 creates.

- [ ] **Step 7: Commit**

```bash
git add mail/mailops/src/health.ts mail/mailops/src/health.test.ts mail/mailops/src/index.ts
git commit -m "Add the boot gate, health warnings and the reconcile loop"
```

---

### Task 8: Certificates via ACME DNS-01

DNS-01 specifically, because it needs no inbound HTTP and does not break when the public IP rotates. The challenge handling is delegated to `lego`, which has a first-class Cloudflare provider; only the renewal decision is ours.

**Files:**
- Create: `mail/mailops/src/certs.ts`
- Test: `mail/mailops/src/certs.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`.
- Produces: `function needsRenewal(notAfter: Date | null, now: Date, windowDays?: number): boolean`, `function legoArgs(config: Config, certDir: string): string[]`, `function ensureCertificate(config: Config, certDir: string, now: Date): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `mail/mailops/src/certs.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { needsRenewal, legoArgs } from './certs.ts'

const config = loadConfig({
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
})

const now = new Date('2026-09-18T00:00:00Z')

describe('needsRenewal', () => {
    it('renews when there is no certificate at all', () => {
        assert.equal(needsRenewal(null, now), true)
    })

    it('renews inside the window', () => {
        assert.equal(needsRenewal(new Date('2026-10-10T00:00:00Z'), now), true)
    })

    it('leaves a certificate alone outside the window', () => {
        assert.equal(needsRenewal(new Date('2026-12-01T00:00:00Z'), now), false)
    })

    it('renews an already expired certificate', () => {
        assert.equal(needsRenewal(new Date('2026-08-01T00:00:00Z'), now), true)
    })
})

describe('legoArgs', () => {
    it('requests the mail hostname through the Cloudflare DNS challenge', () => {
        const args = legoArgs(config, '/mail-certs')
        assert.ok(args.includes('--dns'))
        assert.ok(args.includes('cloudflare'))
        assert.ok(args.includes('--domains'))
        assert.ok(args.includes('mail.dev.horizons.gg'))
    })

    it('uses the DMARC reporting address as the ACME account contact', () => {
        assert.ok(legoArgs(config, '/mail-certs').includes('me@example.com'))
    })

    it('writes into the certificate directory', () => {
        assert.ok(legoArgs(config, '/mail-certs').includes('/mail-certs'))
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mail/mailops && npm test`
Expected: FAIL, cannot resolve `./certs.ts`.

- [ ] **Step 3: Write the implementation**

Create `mail/mailops/src/certs.ts`:

```ts
// DNS-01 rather than HTTP-01, deliberately: no inbound HTTP to expose, and renewal does not break when the
// public IP rotates. The challenge dance itself is lego's job. Delegating it keeps custom code off the path
// where custom code is least welcome.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { Config } from './config.ts'

const run = promisify(execFile)
const RENEWAL_WINDOW_DAYS = 30

export function needsRenewal(notAfter: Date | null, now: Date, windowDays = RENEWAL_WINDOW_DAYS): boolean {
    if (!notAfter) return true
    const daysLeft = (notAfter.getTime() - now.getTime()) / 86_400_000
    return daysLeft < windowDays
}

export function legoArgs(config: Config, certDir: string): string[] {
    return [
        '--accept-tos',
        '--email', config.dmarcRua,
        '--dns', 'cloudflare',
        '--domains', config.mailHostname,
        '--path', certDir,
        'run',
    ]
}

async function currentNotAfter(config: Config, certDir: string): Promise<Date | null> {
    try {
        const pem = await readFile(join(certDir, 'certificates', `${config.mailHostname}.crt`), 'utf8')
        return new Date(new X509Certificate(pem).validTo)
    } catch {
        return null
    }
}

export async function ensureCertificate(config: Config, certDir: string, now: Date): Promise<void> {
    const notAfter = await currentNotAfter(config, certDir)
    if (!needsRenewal(notAfter, now)) return

    const args = notAfter
        ? legoArgs(config, certDir).map(arg => arg === 'run' ? 'renew' : arg)
        : legoArgs(config, certDir)

    // lego reads the Cloudflare credential from CF_DNS_API_TOKEN, so the same scoped token serves both the
    // record reconciliation and the certificate challenge.
    await run('lego', args, { env: { ...process.env, CF_DNS_API_TOKEN: config.cfApiToken } })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mail/mailops && npm test`
Expected: PASS, whole suite green. The suite grows by the tests this task adds; the running total is not fixed, because earlier fix rounds added tests of their own.

- [ ] **Step 5: Verify the whole package type-checks**

Run: `cd mail/mailops && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add mail/mailops/src/certs.ts mail/mailops/src/certs.test.ts
git commit -m "Obtain and renew the mail certificate over ACME DNS-01"
```

---

### Task 9: Deployment, and the go-live runbook

The compose file, the image, the example environment, and the ordered procedure for turning it on safely. The open relay verification is in the runbook because it has to happen before the port stays open, not after.

**Files:**
- Create: `mail/mailops/Dockerfile`
- Create: `mail/docker-compose.yml`
- Create: `mail/.env.example`
- Create: `mail/RUNBOOK.md`
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: everything from Tasks 1 to 8.
- Produces: no code interfaces. A deployable stack.

- [ ] **Step 1: Write the mailops image**

Create `mail/mailops/Dockerfile`:

```dockerfile
FROM golang:1.23-alpine AS lego
RUN go install github.com/go-acme/lego/v4/cmd/lego@v4.19.2

FROM node:22-alpine
WORKDIR /app
COPY --from=lego /go/bin/lego /usr/local/bin/lego
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
CMD ["npm", "start"]
```

- [ ] **Step 2: Write the compose file**

Create `mail/docker-compose.yml`:

```yaml
# The mail stack, deployed independently of the site. Only port 25 is published: no 587 because the only
# future sender reaches us over this network, no 993 because there are no mailboxes, and no 80 or 443
# because certificates come from a DNS challenge.

services:
  mailserver:
    image: mailserver/docker-mailserver:15.0
    container_name: horizons-mailserver
    hostname: mail.${MAIL_DOMAIN:?set MAIL_DOMAIN in mail/.env}
    env_file: .env
    environment:
      OVERRIDE_HOSTNAME: mail.${MAIL_DOMAIN}
      ENABLE_SRS: 1
      SRS_SENDER_CLASSES: envelope_sender
      ENABLE_RSPAMD: 1
      ENABLE_OPENDKIM: 1
      ENABLE_FAIL2BAN: 1
      ENABLE_IMAP: 0
      ENABLE_POP3: 0
      SSL_TYPE: manual
      SSL_CERT_PATH: /mail-certs/certificates/mail.${MAIL_DOMAIN}.crt
      SSL_KEY_PATH: /mail-certs/certificates/mail.${MAIL_DOMAIN}.key
      LOG_LEVEL: info
    ports:
      - "25:25"
    volumes:
      - mail-data:/var/mail
      - mail-state:/var/mail-state
      - mail-config:/tmp/docker-mailserver
      - mail-logs:/var/log/mail
      - mail-certs:/mail-certs:ro
    cap_add:
      - NET_ADMIN
    restart: unless-stopped

  mailops:
    build: ./mailops
    container_name: horizons-mailops
    env_file: .env
    environment:
      MAIL_CONFIG_DIR: /mail-config
      MAIL_LOG_FILE: /mail-logs/mail.log
      MAIL_CERT_DIR: /mail-certs
      MAILOPS_STATUS_FILE: /health/status.json
    volumes:
      - mail-config:/mail-config
      - mail-logs:/mail-logs:ro
      - mail-certs:/mail-certs
      - mail-health:/health
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(JSON.parse(require('fs').readFileSync('/health/status.json','utf8')).ok?0:1)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 120s
    restart: unless-stopped

volumes:
  mail-data:
  mail-state:
  mail-config:
  mail-logs:
  mail-certs:
  mail-health:
```

- [ ] **Step 3: Write the example environment**

Create `mail/.env.example`:

```
# Copy to mail/.env and fill in. mail/.env is gitignored and must never be committed.

MAIL_DOMAIN=dev.horizons.gg
FORWARD_TO=you@example.com
DMARC_RUA=you@example.com
DELIVERY_TARGETS=forward

# Scope this token to Zone:DNS:Edit on horizons.gg only. Nothing else.
CF_API_TOKEN=
CF_ZONE_ID=

# Leave RELAY_HOST empty to deliver direct. Setting it switches outbound to an authenticated relay and
# adds the include to SPF automatically. RELAY_SPF_INCLUDE is required whenever RELAY_HOST is set.
RELAY_HOST=
RELAY_PORT=587
RELAY_USER=
RELAY_PASSWORD=
RELAY_SPF_INCLUDE=
```

- [ ] **Step 4: Close the dockerignore gap**

The site's `.dockerignore` lists only `.next/` and `node_modules/`. Docker does not read `.gitignore`, so a stray env file would be copied into the site image by `COPY . .`.

Run:

```bash
printf '.env*\nmail/\ndocs/\n' >> .dockerignore
```

- [ ] **Step 5: Verify the compose file parses**

Run: `cd mail && cp .env.example .env && docker compose config --quiet && echo OK`
Expected: `OK`, no output from `config`.

- [ ] **Step 6: Write the runbook**

Create `mail/RUNBOOK.md`:

```markdown
# Mail stack runbook

## Before first start

1. Create a Cloudflare API token scoped to **Zone:DNS:Edit on `horizons.gg` only**. Nothing else.
2. Copy `mail/.env.example` to `mail/.env` and fill in `CF_API_TOKEN`, `CF_ZONE_ID`, `FORWARD_TO` and `DMARC_RUA`.
3. Do **not** forward port 25 on the modem yet.

## First start

```bash
cd mail && docker compose up -d && docker compose logs -f mailops
```

Expect `boot gate passed` within a minute. If it exits instead, the log names the failed check. The gate
fails on configuration problems only: a bad token, an unreachable outbound 25, or an undeterminable IP.

Then confirm the zone. `mail.dev.horizons.gg` A, `dev.horizons.gg` MX and TXT, and `_dmarc.dev.horizons.gg`
TXT should exist in Cloudflare, each commented `managed-by:mailops`, and the A record must be grey-clouded.
The DKIM record appears a cycle or two later, once docker-mailserver has generated the key.

## Open relay verification, before the port stays open

This is the step that protects you from the expensive mistake. Do it immediately, not later.

1. Forward port 25 to the host on the modem.
2. Run an external relay test at once, through MXToolbox's SMTP diagnostic or mail-tester.
3. Confirm it reports **no open relay**.

If the test reports an open relay, close port 25 on the modem before doing anything else, then investigate.
An open relay on a residential address is found within hours and the consequences outlive the mistake.

## Inbound end to end

Send a message from an external account to `contact@dev.horizons.gg`, then confirm:

- it arrives at `FORWARD_TO`
- the envelope sender was SRS-rewritten, visible as `SRS0=` in the received headers

## Measure deliverability, do not assume it

Send a message to the address mail-tester.com gives you and read the score. It reports reverse DNS, SPF,
DKIM, DMARC alignment and blocklist status together.

Reverse DNS is expected to score badly. The address is Telstra's `cpe-...` name, it does not
forward-confirm, and it cannot be changed on a residential plan. That is a known, accepted weakness.

If delivery to real recipients disappoints, switch to a relay: set `RELAY_HOST`, `RELAY_PORT`, `RELAY_USER`,
`RELAY_PASSWORD` and `RELAY_SPF_INCLUDE` in `mail/.env`, then `docker compose up -d`. SPF updates itself on
the next reconcile cycle. No rebuild, no redesign.

## Day to day

- Health: `docker compose ps` shows `mailops` healthy or unhealthy, and `/health/status.json` holds the detail.
- Warnings: `docker compose logs mailops | grep WARN`.
- A `dns-conflict` warning means something unmanaged sits at a name we want. Nothing is overwritten. Remove
  the conflicting record by hand, or rename ours.
- A `spamhaus` warning after an IP change means the new address arrived with inherited reputation damage.
  Switching to a relay is the remedy.
- An `inbound-stale` warning means nothing has connected for 48 hours. Usually the modem's port forward.
```

- [ ] **Step 7: Run the full test suite one final time**

Run: `cd mail/mailops && npm test && npx tsc --noEmit`
Expected: PASS, whole suite green, and no type errors.

- [ ] **Step 8: Commit**

```bash
git add mail/docker-compose.yml mail/.env.example mail/RUNBOOK.md mail/mailops/Dockerfile .dockerignore
git commit -m "Add the mail stack compose file, image and go-live runbook"
```

---

## Verification against the spec

Every spec section maps to a task:

| Spec section | Task |
| --- | --- |
| Containers, ports, volumes | 9 |
| Mail flow, SRS | 9 (compose `ENABLE_SRS`) |
| Managed records, computed SPF | 2 |
| Permissive start (`~all`, `p=none`) | 2 |
| `managed-by` guard | 3 |
| DKIM handshake | 5 |
| Certificates, ACME DNS-01 | 8 |
| Reconciliation loop | 4, 7 |
| Delivery seam | 5 (`aliasMap`) |
| Hard gate at boot | 7 |
| Degrade and shout | 7 |
| Inbound 25 staleness | 6 |
| Configuration surface | 1, 9 |
| `.dockerignore` gap | 9 |
| Open relay verification | 9 (runbook) |
| Deliverability measurement | 9 (runbook) |

Not implemented, by design, and recorded in the spec as later phases: the `ingest` delivery target and its
database, the contact form, and tightening SPF to `-all` with DMARC at `p=quarantine`.
