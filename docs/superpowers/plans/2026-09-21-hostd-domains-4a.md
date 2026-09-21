# hostd Domains Phase 4a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hostd control of the Apache vhost each client site is served from: render it from a fixed template, get it onto the host through a systemd rail that refuses to reload a broken config, prove each hostname reaches the right site, adopt the five hand-written vhosts that exist today in one reload each, and show all of it on the portal's Domains tab.

**Architecture:** The agent renders and writes vhost files but cannot reload Apache, because Apache runs on the host and the agent has `network_mode: none`. It therefore writes a request file into a bind-mounted handshake directory, and a systemd path unit on the host runs `apache2ctl configtest`, reloads only if the test passes, and writes a result carrying the request's sequence number. `api` does the verifying, because verification needs the internet and the agent has none, and `api` therefore owns domain state in its own `/state`. Every side effect (the filesystem, the clock, the rail, `fetch`) is an injected adapter, so the whole suite runs with no Apache, no systemd, no network and no disk.

**Tech Stack:** Node 22 ESM with tsx, TypeScript, `node --test` for hostd, Vitest for the portal, `yaml`, Apache 2.4 with `mod_headers`, `mod_proxy_http` and `mod_ssl`, systemd path and oneshot units.

**Spec:** `docs/superpowers/specs/2026-09-21-hostd-domains-design.md`. Read it before starting any task, along with the **Domains** section of `docs/superpowers/specs/2026-09-20-hostd-design.md` (which it supersedes, and which carries the reasoning) and the **Certificates** and **Maintenance page** sections of `docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md`.

## Global Constraints

- **No em dashes** (U+2014, `&mdash;`) in any non-comment text: docs, runbook, UI copy, commit messages, PR descriptions. Code comments are exempt.
- **Code style:** 4-space indentation, no semicolons, single quotes, comments that say why rather than what. Files sit beside their tests (`x.ts`, `x.test.ts`).
- **hostd tests:** `node --test` via tsx, `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`. No mocking library: fake the I/O boundary with plain object literals and a local `setup()` factory. Build registries by calling the real `parseRegistry()` on inline YAML.
- **Portal tests:** Vitest. `app/**/*.test.ts` and `server/**/*.test.ts` run in the `unit` project (node), `app/**/*.test.tsx` in the `dom` project (jsdom).
- **The agent repeats every check itself.** Nothing `api` decided lets the agent skip `checkStructure`, the capability check, or its own reading of the registry.
- **Paths never come from the portal.** Every path the filesystem or the rail sees is derived from the registry entry the structural check returned, or from the agent's own configuration. A hostname that reaches a file path does so only after `normaliseHostname` has accepted it.
- **The host unit validates nothing.** Everything it is handed was already validated by the agent. It performs, tests, reloads, reports.
- **A failed configtest never leaves a bad file behind.** The agent restores the previous contents and triggers again to confirm the config is clean.
- **Nothing in 4a issues a certificate.** Every vhost written in this phase presents the shared Origin certificate.
- **Commits** end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run hostd work from `hostd/`: `npm test`, `npm run typecheck`. Run portal work from the repo root: `npm test`.

## What the design says, and what this plan does about it

Seven things the design leaves for the plan, each decided here once rather than guessed at per task.

1. **Where the Origin certificate paths come from.** The design says the template substitutes "the certificate paths" without saying from where. They are agent configuration, not registry data: `HOSTD_ORIGIN_CERT` and `HOSTD_ORIGIN_KEY`, read at boot, with the agent refusing to start if either is set and missing on disk. A client-supplied value must never reach an `SSLCertificateFile` directive, and registry data is partly client-influenced through provisioning.

2. **`certificate: letsencrypt` in 4a.** The registry already accepts it and 4b is what implements it. An environment in that mode gets its vhost written with the Origin certificate exactly as `cloudflare-origin` does, and `/health` carries one warning naming the environments waiting on 4b. Refusing to write the vhost instead would mean an environment whose mode was set ahead of time simply has no vhost, which is worse than a working site and a warning.

3. **Verification is https only in 4a.** The http-first path exists in the design for `letsencrypt` domains, which cannot be certified until 4b. Since every 4a vhost presents the Origin certificate, every 4a verification is the https check. `verifyHostname` still takes the scheme as an argument so 4b adds a caller rather than a rewrite.

4. **Apache config parsing has a hard limit, and adopt refuses rather than guesses.** `parseServerNames` reads `ServerName` and `ServerAlias` and nothing else. A file containing `Include`, `IncludeOptional` or `Use` (mod_macro) is reported as unsupported and **cannot be adopted**, because the hostnames it serves may be defined somewhere this never looked. The preview says so and the operator moves that one by hand. Silently adopting a file we half-understood is the failure mode this exists to avoid.

5. **The maintenance page's directory must exist before a vhost references it.** Its contents belong to the provisioning design, not this one. The runbook's host setup creates `/var/www/hostd-maintenance/` with a minimal `index.html`, and the task that writes the runbook says the page itself is the provisioning work's to finish.

6. **The verification token lives in `api`'s state, not the agent's.** The agent is handed a token to render and returns nothing about it, which keeps the agent stateless for domains and means a rewrite cannot silently change a token `api` is still checking against. `api` generates it with `randomBytes(16).toString('hex')`.

7. **`api` restarts lose in-memory timers.** The scheduler is therefore not a set of timers but a single interval that asks the store which records are due, computing that from `checkedAt` and `attempts` on disk. A restart mid-schedule resumes rather than starting the 72 hours again.

Deliberately **not** built here, and listed in the PR: certbot and everything Let's Encrypt (4b), changing an environment's primary hostname (the design's **Decisions**, fixed by hand-editing the registry), wildcard certificates, and the maintenance page's own markup.

## File Structure

| Path | Responsibility |
| --- | --- |
| `hostd/src/shared/hostnames.ts` (new) | Hostname normalisation, the reserved rule, and the `allowed` carve-out with its two hard refusals |
| `hostd/src/shared/registry.ts` (modify) | `aliases` per environment, `allowed` at the top level, and both inside the existing uniqueness checks |
| `hostd/src/shared/apache.ts` (new) | The rail's request and result shapes, and the strict parse of a result |
| `hostd/src/shared/protocol.ts` (modify) | The `domains` verb's grammar and replies |
| `hostd/src/agent/vhost.ts` (new) | Rendering one environment's vhost from the fixed template |
| `hostd/src/agent/sites-enabled.ts` (new) | Reading `ServerName` and `ServerAlias` out of hand-written vhosts, and refusing files it cannot fully read |
| `hostd/src/agent/apache-rail.ts` (new) | The handshake: sequence numbers, the write, the poll, the timeout, the lock |
| `hostd/src/agent/domains.ts` (new) | The domains verb: write, remove, preview an adoption, adopt |
| `hostd/src/agent/testing/fake-rail.mjs` (new) | A host unit that runs in tests: same handshake, a configtest that can be told to fail |
| `hostd/src/api/domain-state.ts` (new) | Domain records on disk in `api`'s state, loaded at boot, written atomically |
| `hostd/src/api/verify.ts` (new) | One verification request, and the translation of its failure into the client's three sentences |
| `hostd/src/api/verifier.ts` (new) | Which records are due, and the loop that checks them |
| `hostd/src/api/policy.ts` (modify) | `domains` and `domains-read` |
| `hostd/src/api/routes.ts` (modify) | The six endpoints, and the domain warnings in `/health` |
| `hostd/host/hostd-apache.sh` (new) | The host unit's script: perform, configtest, reload, report |
| `hostd/host/hostd-apache.path`, `.service` (new) | The systemd units that run it |
| `hostd/host/apache-include.conf` (new) | The `IncludeOptional` snippet the operator adds to Apache |
| `server/hostd/domains.ts` (new) | The portal's calls to the six endpoints |
| `app/(portal)/portal/sites/[id]/domains.ts` (new) | The panel's reasoning: words, tones, and what a client is shown |
| `app/(portal)/portal/sites/[id]/domainsPanel.tsx` (new) | The panel itself |
| `app/(portal)/portal/sites/[id]/domainControls.tsx` (new) | The operator's actions, as a client component |
| `app/(portal)/portal/sites/[id]/page.tsx` (modify) | The tab stops being admin-only and gets its panel |

---

### Task 1: Hostname rules and the `allowed` carve-out

**Files:**
- Create: `hostd/src/shared/hostnames.ts`, `hostd/src/shared/hostnames.test.ts`

**Interfaces:**
- Consumes: `HOSTNAME` from `src/shared/formats.ts`
- Produces:
  - `export function normaliseHostname(raw: unknown): string | null`
  - `export function atOrBelow(host: string, parent: string): boolean`
  - `export function isReserved(host: string, reserved: string[], allowed: string[]): boolean`
  - `export function allowedEntryProblem(host: string): string | null`
  - `export const NEVER_ALLOWED_EXACT: string[]`, `export const NEVER_ALLOWED_SUBTREE: string[]`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/shared/hostnames.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseHostname, atOrBelow, isReserved, allowedEntryProblem } from './hostnames.ts'

describe('normaliseHostname', () => {
    it('lowercases and keeps a plain hostname', () => {
        assert.equal(normaliseHostname('WWW.Example.COM'), 'www.example.com')
    })

    it('converts a unicode name to punycode', () => {
        assert.equal(normaliseHostname('café.example.com'), 'xn--caf-dma.example.com')
    })

    it('strips a trailing dot, because the root label is not part of a ServerName', () => {
        assert.equal(normaliseHostname('example.com.'), 'example.com')
    })

    it('refuses a single label, a scheme, a port, a path and an empty string', () => {
        for (const bad of ['localhost', 'https://example.com', 'example.com:443', 'example.com/x', '']) {
            assert.equal(normaliseHostname(bad), null, bad)
        }
    })

    it('refuses anything that is not a string', () => {
        for (const bad of [null, undefined, 42, {}, ['example.com']]) assert.equal(normaliseHostname(bad), null)
    })
})

describe('atOrBelow', () => {
    it('matches the name itself and anything under it', () => {
        assert.equal(atOrBelow('horizons.gg', 'horizons.gg'), true)
        assert.equal(atOrBelow('a.b.horizons.gg', 'horizons.gg'), true)
    })

    it('does not match a name that merely ends with the same letters', () => {
        assert.equal(atOrBelow('nothorizons.gg', 'horizons.gg'), false)
    })
})

describe('isReserved', () => {
    it('refuses a reserved name and everything under it', () => {
        assert.equal(isReserved('horizons.gg', ['horizons.gg'], []), true)
        assert.equal(isReserved('mail.horizons.gg', ['horizons.gg'], []), true)
    })

    it('exempts an exact allowed entry and nothing else under it', () => {
        const reserved = ['horizons.gg']
        const allowed = ['test.hostd.horizons.gg']
        assert.equal(isReserved('test.hostd.horizons.gg', reserved, allowed), false)
        // The carve-out is the one name, never the subtree below it.
        assert.equal(isReserved('deeper.test.hostd.horizons.gg', reserved, allowed), true)
    })
})

describe('allowedEntryProblem', () => {
    it('accepts an ordinary test hostname', () => {
        assert.equal(allowedEntryProblem('test.hostd.horizons.gg'), null)
    })

    it('refuses the apex, whatever else the file says', () => {
        assert.match(allowedEntryProblem('horizons.gg') ?? '', /never be exempted/)
    })

    it('refuses the mail subtree, at any depth', () => {
        assert.match(allowedEntryProblem('dev.horizons.gg') ?? '', /never be exempted/)
        assert.match(allowedEntryProblem('mail.dev.horizons.gg') ?? '', /never be exempted/)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/shared/hostnames.test.ts`
Expected: FAIL, `Cannot find module './hostnames.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/shared/hostnames.ts`:

```ts
// Every hostname hostd accepts passes through here first. It is the only place that decides what a
// hostname is, so the vhost renderer, the registry parser and the endpoints cannot disagree about it.

import { HOSTNAME } from './formats.ts'

// Names that may never appear in the registry's `allowed` list, whatever the operator writes. The
// carve-out exists so a test hostname can be exempted from `reserved`; it must never become a door to
// the apex or to the mail stack. This is in code rather than in the runbook because a runbook does not
// refuse a typo.
export const NEVER_ALLOWED_EXACT = ['horizons.gg']
export const NEVER_ALLOWED_SUBTREE = ['dev.horizons.gg']

// URL does the IDNA conversion and the lowercasing that punycode-by-hand gets wrong. node:punycode is
// deprecated and does not implement UTS-46, so it would accept names a browser would not.
export function normaliseHostname(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw === '') return null
    // A trailing dot is a valid fully qualified name but is not what goes in a ServerName, and it would
    // make two spellings of one hostname compare unequal everywhere else.
    const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw
    let host: string
    try {
        const url = new URL(`https://${trimmed}`)
        // Anything beyond the host itself means the caller passed a URL, a port or a path, none of which
        // is a hostname. Comparing the whole URL back is what catches all three at once.
        if (url.href !== `https://${url.hostname}/`) return null
        host = url.hostname
    } catch {
        return null
    }
    return HOSTNAME.test(host) ? host : null
}

export function atOrBelow(host: string, parent: string): boolean {
    return host === parent || host.endsWith(`.${parent}`)
}

export function isReserved(host: string, reserved: string[], allowed: string[]): boolean {
    // Exact match only. A subtree exemption would mean exempting one test name also exempted every name
    // below it, which is the hole this key is shaped to avoid.
    if (allowed.includes(host)) return false
    return reserved.some(entry => atOrBelow(host, entry))
}

export function allowedEntryProblem(host: string): string | null {
    const never = NEVER_ALLOWED_EXACT.includes(host)
        || NEVER_ALLOWED_SUBTREE.some(entry => atOrBelow(host, entry))
    return never ? `${host} can never be exempted from reserved` : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/shared/hostnames.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/shared/hostnames.ts hostd/src/shared/hostnames.test.ts
git commit -m "Add the hostname rules and the allowed carve-out"
```

---

### Task 2: `aliases` and `allowed` in the registry

**Files:**
- Modify: `hostd/src/shared/registry.ts`
- Modify: `hostd/src/shared/registry.test.ts`
- Modify: `hostd/registry/projects.example.yaml`

**Interfaces:**
- Consumes: `normaliseHostname`, `isReserved`, `allowedEntryProblem` from Task 1
- Produces:
  - `EnvironmentEntry` gains `aliases: string[]`
  - `Registry` gains `allowed: string[]`
  - `export function hostnamesOf(environment: EnvironmentEntry): string[]` (primary first, then aliases; empty when there is no primary)

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry.test.ts`:

```ts
describe('aliases', () => {
    const base = (extra: string) => `
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: acme.com
${extra}
`

    it('defaults to none, so every entry that exists today is unchanged', () => {
        const registry = parseRegistry(base(''))
        assert.deepEqual(registry.projects.get('acme')!.environments.get('live')!.aliases, [])
    })

    it('normalises each alias', () => {
        const registry = parseRegistry(base('        aliases: [WWW.Acme.com]'))
        assert.deepEqual(registry.projects.get('acme')!.environments.get('live')!.aliases, ['www.acme.com'])
    })

    it('puts the primary first and the aliases after it', () => {
        const registry = parseRegistry(base('        aliases: [www.acme.com]'))
        const live = registry.projects.get('acme')!.environments.get('live')!
        assert.deepEqual(hostnamesOf(live), ['acme.com', 'www.acme.com'])
    })

    it('refuses an alias equal to its own primary', () => {
        const registry = parseRegistry(base('        aliases: [acme.com]'))
        assert.match(registry.invalid.get('acme') ?? '', /already this environment's domain/)
    })

    it('refuses more hostnames than maxDomains allows, counting the primary', () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    maxDomains: 2
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: acme.com
        aliases: [www.acme.com, shop.acme.com]
`)
        assert.match(registry.invalid.get('acme') ?? '', /at most 2 hostnames/)
    })

    it('refuses an alias another project already uses', () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com }
  other:
    client: cl_2
    name: Other
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/other, port: 5011, domain: other.com, aliases: [acme.com] }
`)
        assert.equal(registry.projects.size, 0)
    })
})

describe('allowed', () => {
    const withAllowed = (allowed: string) => `
reserved: [horizons.gg]
allowed: [${allowed}]
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: test.hostd.horizons.gg }
`

    it('exempts exactly the named hostname from reserved', () => {
        const registry = parseRegistry(withAllowed('test.hostd.horizons.gg'))
        assert.equal(registry.projects.get('acme')!.environments.get('live')!.domain, 'test.hostd.horizons.gg')
    })

    it('rejects the whole file when the apex is listed', () => {
        assert.throws(() => parseRegistry(withAllowed('horizons.gg')), /can never be exempted/)
    })

    it('rejects the whole file when the mail subtree is listed', () => {
        assert.throws(() => parseRegistry(withAllowed('mail.dev.horizons.gg')), /can never be exempted/)
    })

    it('still refuses a reserved name that is not listed', () => {
        const registry = parseRegistry(withAllowed('something.else.horizons.gg'))
        assert.match(registry.invalid.get('acme') ?? '', /reserved/)
    })
})
```

Add `hostnamesOf` to the file's existing import from `./registry.ts`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/registry.test.ts`
Expected: FAIL. `hostnamesOf` is not exported, and `aliases` is reported as an unknown key.

- [ ] **Step 3: Write the implementation**

In `hostd/src/shared/registry.ts`:

Import from the new module and drop the local `isReserved`, which Task 1 replaced:

```ts
import { normaliseHostname, isReserved, allowedEntryProblem } from './hostnames.ts'
```

Add `aliases` to the environment type and key set, and `allowed` to the registry type and top-level keys:

```ts
export type EnvironmentEntry = {
    name: EnvironmentName
    dir: string
    composePaths: string[]
    branch: string | null
    domain: string | null
    aliases: string[]
    port: number
    certificate: CertificateMode | null
    deployed: string | null
}

export type Registry = {
    reserved: string[]
    allowed: string[]
    offsite: { keep: Keep }
    projects: Map<string, ProjectEntry>
    invalid: Map<string, string>
}

const ENVIRONMENT_KEYS = new Set(['dir', 'compose', 'branch', 'domain', 'aliases', 'port', 'certificate', 'deployed'])
const TOP_KEYS = new Set(['reserved', 'allowed', 'offsite', 'projects'])

// The primary first, because it is the canonical name and every alias redirects to it. An environment
// with no domain has no hostnames at all rather than a list of aliases pointing at nothing.
export function hostnamesOf(environment: EnvironmentEntry): string[] {
    return environment.domain === null ? [] : [environment.domain, ...environment.aliases]
}
```

`parseEnvironment` gains `allowed` as a parameter alongside `reserved`, normalises the primary through the new function, and parses the aliases. Replace the existing `domain` block with:

```ts
    let domain: string | null = null
    if (raw.domain !== undefined) {
        const host = normaliseHostname(raw.domain)
        if (host === null) problems.push(`${where}.domain must be a lowercase hostname`)
        else if (isReserved(host, reserved, allowed)) problems.push(`${where}.domain must not be at or below a reserved domain`)
        else domain = host
    }

    const aliases: string[] = []
    if (raw.aliases !== undefined) {
        if (!Array.isArray(raw.aliases)) problems.push(`${where}.aliases must be a list of hostnames`)
        else {
            for (const entry of raw.aliases) {
                const host = normaliseHostname(entry)
                if (host === null) problems.push(`${where}.aliases must be a list of lowercase hostnames`)
                else if (isReserved(host, reserved, allowed)) problems.push(`${where}.aliases must not be at or below a reserved domain`)
                else if (host === domain) problems.push(`${where}.aliases entry ${host} is already this environment's domain`)
                else if (aliases.includes(host)) problems.push(`${where}.aliases lists ${host} twice`)
                else aliases.push(host)
            }
        }
    }
```

Return `aliases` in the entry, and add `aliases: []` to the synthesised single-environment entry beside its existing `domain: null`.

`parseProject` checks the cap once the environments are parsed, where `maxDomains` is already in scope:

```ts
    for (const environment of environments.values()) {
        const hostnames = hostnamesOf(environment)
        if (hostnames.length > maxDomains) {
            problems.push(`environments.${environment.name} has ${hostnames.length} hostnames, and this project allows at most ${maxDomains}`)
        }
    }
```

In `parseRegistry`, parse `allowed` before the projects, since `parseProject` needs it:

```ts
    let allowed: string[] = []
    if (doc.allowed !== undefined) {
        const list = doc.allowed
        if (!Array.isArray(list)) failures.push('allowed must be a list of lowercase hostnames')
        else {
            for (const entry of list) {
                const host = normaliseHostname(entry)
                if (host === null) failures.push('allowed must be a list of lowercase hostnames')
                else {
                    // A whole-file failure, not a per-project one. An operator who wrote this meant it to
                    // take effect, so the right answer is to refuse the file and keep the last good
                    // registry, not to drop the entry and carry on looking healthy.
                    const problem = allowedEntryProblem(host)
                    if (problem) failures.push(problem)
                    else allowed.push(host)
                }
            }
        }
    }
```

Pass `allowed` through `parseProject` to `parseEnvironments` to `parseEnvironment`, and return it on the registry.

The existing cross-entry check that refuses two environments sharing a domain now compares every hostname. Replace the `env.domain !== null` block with:

```ts
            for (const host of hostnamesOf(env)) {
                const sharing = [...parsed.values()]
                    .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => hostnamesOf(otherEnv).includes(host)))
                    .map(other => other.id)
                if (sharing.length > 0) messages.push(`domain ${host} is also used by ${sharing.join(', ')}`)
            }
```

- [ ] **Step 4: Run the whole shared suite**

Run: `cd hostd && npx tsx --test "src/shared/*.test.ts"`
Expected: PASS. Existing tests still pass, because `aliases` defaults to `[]` and `allowed` to `[]`.

- [ ] **Step 5: Document both keys in the example registry**

In `hostd/registry/projects.example.yaml`, replace the `reserved` comment block with:

```yaml
# Hostnames at or below these are never accepted as client domains.
reserved: [horizons.gg]

# Exact hostnames exempted from the rule above, for the one test name domain verification needs on the
# dedi. Exact names only: this never exempts the subtree below an entry. The apex horizons.gg and
# anything under dev.horizons.gg (the mail stack) are refused here whatever this says, and listing one
# rejects the whole file.
# allowed: [test.hostd.horizons.gg]
```

And in the commented `widget-shop` example, under `live:`, beneath `domain: widgetshop.com`:

```yaml
  #       aliases: [www.widgetshop.com]  # served, and each one 301s to the domain above. The domain
  #                                      # plus its aliases must not exceed maxDomains (default 3).
```

- [ ] **Step 6: Teach the registry writer to set aliases**

Parsing `aliases` is only half of it. Task 14's "add an alias" endpoint has to persist one, and
`hostd/src/shared/registry-write.ts` currently cannot express that: its `Change` union has no alias
variant and `EnvironmentDraft` has no `aliases` field. Without this the endpoint has nowhere to write to.

Add to `hostd/src/shared/registry-write.ts`:

```ts
export type Change =
    | { kind: 'add-project', id: string, project: ProjectDraft }
    | { kind: 'add-environment', id: string, environment: EnvironmentDraft }
    | { kind: 'set-deployed', id: string, environment: EnvironmentName, commit: string }
    | { kind: 'set-branch', id: string, environment: EnvironmentName, branch: string }
    // The whole list, not one alias at a time. A read-modify-write of a list through two verbs would
    // race with the operator's own editor; handing over the list that should be there makes the write
    // idempotent and lets the existing conflict check do its job.
    | { kind: 'set-aliases', id: string, environment: EnvironmentName, aliases: string[] }
    | { kind: 'remove-project', id: string }
    | { kind: 'remove-environment', id: string, environment: EnvironmentName }
```

Give `EnvironmentDraft` an `aliases: string[]`, and emit it from `environmentNode` only when it has
entries, so an environment with none keeps the exact shape it has today:

```ts
    ...(draft.aliases.length ? { aliases: draft.aliases } : {}),
```

In `edit()`, handle `set-aliases` beside `set-branch`: refuse when the project or environment is absent,
then `doc.setIn(['projects', id, 'environments', environment, 'aliases'], aliases)`, or
`doc.deleteIn(...)` when the list is empty, so removing the last alias leaves no empty key behind.

Add to `hostd/src/shared/registry-write.test.ts`:

```ts
describe('set-aliases', () => {
    it('writes the list under the environment', () => {
        const result = applyChange(REGISTRY, { kind: 'set-aliases', id: 'acme', environment: 'live', aliases: ['www.acme.com'] })
        assert.equal(result.ok, true)
        assert.match(result.ok ? result.text : '', /aliases:\s*\n?\s*- www\.acme\.com|aliases: \[ ?www\.acme\.com ?\]/)
    })

    it('removes the key entirely when the list is empty, rather than leaving aliases: []', () => {
        const withOne = applyChange(REGISTRY, { kind: 'set-aliases', id: 'acme', environment: 'live', aliases: ['www.acme.com'] })
        const result = applyChange(withOne.ok ? withOne.text : '', { kind: 'set-aliases', id: 'acme', environment: 'live', aliases: [] })
        assert.doesNotMatch(result.ok ? result.text : '', /aliases/)
    })

    it('refuses an environment the project does not have', () => {
        const result = applyChange(REGISTRY, { kind: 'set-aliases', id: 'acme', environment: 'test', aliases: [] })
        assert.equal(result.ok, false)
    })

    it('leaves the rest of the entry untouched, comments included', () => {
        const result = applyChange(REGISTRY, { kind: 'set-aliases', id: 'acme', environment: 'live', aliases: ['www.acme.com'] })
        assert.match(result.ok ? result.text : '', /domain: acme\.com/)
    })
})
```

Reuse whatever `REGISTRY` fixture the existing tests in that file already define rather than adding
another; if it has no `live` environment with a `domain`, extend that one fixture.

- [ ] **Step 7: Commit**

```bash
cd hostd && npm run typecheck && npm test
git add hostd/src/shared/registry.ts hostd/src/shared/registry.test.ts hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts hostd/registry/projects.example.yaml
git commit -m "Give an environment aliases, and the registry an allowed carve-out"
```

---

### Task 3: The rail's request and result shapes

**Files:**
- Create: `hostd/src/shared/apache.ts`, `hostd/src/shared/apache.test.ts`

**Interfaces:**
- Produces:
  - `export const APACHE_ACTIONS = ['reload', 'adopt'] as const`; `export type ApacheAction = typeof APACHE_ACTIONS[number]`
  - `export type ApacheWrite = { path: string, text: string }`
  - `export type ApacheRequest = { seq: number, action: ApacheAction, write: ApacheWrite | null, remove: string[], disable: string[] }`
  - `export type ApacheResult = { seq: number, ok: boolean, output: string }`
  - `export function parseApacheResult(text: string): ApacheResult | null`
  - `export const REQUEST_FILE = 'request.json'`, `export const RESULT_FILE = 'result.json'`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/shared/apache.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseApacheResult } from './apache.ts'

describe('parseApacheResult', () => {
    it('reads a result the host unit wrote', () => {
        assert.deepEqual(
            parseApacheResult('{"seq":7,"ok":true,"output":"Syntax OK"}'),
            { seq: 7, ok: true, output: 'Syntax OK' },
        )
    })

    it('reads a failure with Apache\'s own output', () => {
        const result = parseApacheResult('{"seq":8,"ok":false,"output":"AH00526: Syntax error on line 4"}')
        assert.equal(result?.ok, false)
        assert.match(result?.output ?? '', /AH00526/)
    })

    it('returns null for anything malformed, rather than guessing', () => {
        for (const bad of ['', 'not json', '{}', '{"seq":"7","ok":true,"output":""}', '{"seq":7,"ok":1,"output":""}', '[]']) {
            assert.equal(parseApacheResult(bad), null, bad)
        }
    })

    it('returns null for a negative or fractional sequence', () => {
        assert.equal(parseApacheResult('{"seq":-1,"ok":true,"output":""}'), null)
        assert.equal(parseApacheResult('{"seq":1.5,"ok":true,"output":""}'), null)
    })

    it('tolerates a result being written while it is read, by failing rather than throwing', () => {
        assert.equal(parseApacheResult('{"seq":7,"ok":tr'), null)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/shared/apache.test.ts`
Expected: FAIL, `Cannot find module './apache.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/shared/apache.ts`:

```ts
// The only language the host rail speaks. The agent writes a request, a systemd unit on the host acts on
// it and writes a result. Both files live in a bind-mounted directory that holds nothing else.
//
// Parsing is strict in the same spirit as the agent protocol: a result that is not exactly right is no
// result at all, because the alternative is treating a half-written file as an answer. The request is
// not parsed here at all, because nothing in this codebase reads one: the host script does, in shell.

export const APACHE_ACTIONS = ['reload', 'adopt'] as const
export type ApacheAction = typeof APACHE_ACTIONS[number]

export const REQUEST_FILE = 'request.json'
export const RESULT_FILE = 'result.json'

export type ApacheWrite = { path: string, text: string }

// One request does at most one write, any number of removals, and, for an adopt, moves named files out of
// sites-enabled. All three happen before the single configtest, which is what makes an adoption one
// reload rather than two.
export type ApacheRequest = {
    seq: number
    action: ApacheAction
    write: ApacheWrite | null
    remove: string[]
    disable: string[]
}

export type ApacheResult = { seq: number, ok: boolean, output: string }

export function parseApacheResult(text: string): ApacheResult | null {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        // A partially written file parses as nothing, which is the same answer as a file that is not
        // there yet: keep waiting. The sequence number is what eventually ends the wait.
        return null
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const { seq, ok, output } = value as Record<string, unknown>
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
    if (typeof ok !== 'boolean' || typeof output !== 'string') return null
    return { seq, ok, output }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/shared/apache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/shared/apache.ts hostd/src/shared/apache.test.ts
git commit -m "Define the Apache rail's request and result"
```

---

### Task 4: The vhost template

**Files:**
- Create: `hostd/src/agent/vhost.ts`, `hostd/src/agent/vhost.test.ts`

**Interfaces:**
- Consumes: `EnvironmentEntry`, `hostnamesOf` from `src/shared/registry.ts`
- Produces:
  - `export type VhostInput = { id: string, environment: EnvironmentName, primary: string, aliases: string[], port: number, token: string, certificate: { chain: string, key: string }, maintenanceDir: string, maintenanceFlag: string, acmeWebroot: string }`
  - `export function vhostPath(dir: string, id: string, environment: EnvironmentName): string`
  - `export function renderVhost(input: VhostInput): string`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/vhost.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderVhost, vhostPath, type VhostInput } from './vhost.ts'

const input = (over: Partial<VhostInput> = {}): VhostInput => ({
    id: 'acme',
    environment: 'live',
    primary: 'acme.com',
    aliases: ['www.acme.com'],
    port: 5010,
    token: 'abc123',
    certificate: { chain: '/etc/ssl/hostd/origin.pem', key: '/etc/ssl/hostd/origin.key' },
    maintenanceDir: '/var/www/hostd-maintenance',
    maintenanceFlag: '/run/hostd/maintenance/acme-live',
    acmeWebroot: '/var/www/hostd-acme',
    ...over,
})

describe('vhostPath', () => {
    it('names the file after the project and the environment', () => {
        assert.equal(vhostPath('/etc/apache2/hostd', 'acme', 'test'), '/etc/apache2/hostd/acme-test.conf')
    })
})

describe('renderVhost', () => {
    it('serves the primary and every alias on port 80', () => {
        const text = renderVhost(input())
        const port80 = text.split('<VirtualHost')[1] ?? ''
        assert.match(port80, /ServerName acme\.com/)
        assert.match(port80, /ServerAlias www\.acme\.com/)
    })

    it('serves the ACME challenge directory before redirecting, so a challenge is never 301ed away', () => {
        const text = renderVhost(input())
        const challenge = text.indexOf('/.well-known/acme-challenge')
        const redirect = text.indexOf('RewriteRule')
        assert.ok(challenge >= 0 && redirect > challenge, 'the challenge alias must come before the redirect')
    })

    it('answers the verification token with 204 and the token in a header', () => {
        const text = renderVhost(input({ token: 'deadbeef' }))
        assert.match(text, /<Location "\/\.well-known\/hostd\/deadbeef">/)
        assert.match(text, /Header always set X-Hostd-Token "deadbeef"/)
        assert.match(text, /Redirect 204/)
    })

    it('proxies the primary on 443 to the environment\'s own port', () => {
        assert.match(renderVhost(input({ port: 5108 })), /ProxyPass \/ http:\/\/127\.0\.0\.1:5108\//)
    })

    it('serves the holding page when the maintenance flag exists', () => {
        const text = renderVhost(input())
        assert.match(text, /-f "\/run\/hostd\/maintenance\/acme-live"/)
        assert.match(text, /ErrorDocument 503/)
    })

    it('redirects each alias to the primary on 443 rather than serving it', () => {
        const text = renderVhost(input())
        const aliasBlock = text.split('<VirtualHost').pop() ?? ''
        assert.match(aliasBlock, /ServerName www\.acme\.com/)
        assert.match(aliasBlock, /Redirect permanent \/ https:\/\/acme\.com\//)
        assert.doesNotMatch(aliasBlock, /ProxyPass/)
    })

    it('writes no alias virtual host at all when there are none', () => {
        const text = renderVhost(input({ aliases: [] }))
        assert.equal(text.match(/<VirtualHost/g)?.length, 2)
        assert.doesNotMatch(text, /Redirect permanent/)
    })

    it('names the certificate it was given and never interpolates anything else into an SSL directive', () => {
        const text = renderVhost(input())
        assert.match(text, /SSLCertificateFile \/etc\/ssl\/hostd\/origin\.pem/)
        assert.match(text, /SSLCertificateKeyFile \/etc\/ssl\/hostd\/origin\.key/)
    })

    it('says at the top that it is generated, so nobody edits it by hand', () => {
        assert.match(renderVhost(input()), /^# Generated by hostd/)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/agent/vhost.test.ts`
Expected: FAIL, `Cannot find module './vhost.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/vhost.ts`:

```ts
// One environment's Apache vhost, rendered from a fixed template. The only values that reach the output
// are ones the caller has already validated: hostnames through normaliseHostname, the port and the id
// from the registry entry, the token from api, and the certificate paths from the agent's own
// configuration. Nothing here escapes anything, because nothing here is allowed to receive a value that
// would need escaping.

import { posix } from 'node:path'
import type { EnvironmentName } from '../shared/registry.ts'

export type VhostInput = {
    id: string
    environment: EnvironmentName
    primary: string
    aliases: string[]
    port: number
    token: string
    certificate: { chain: string, key: string }
    maintenanceDir: string
    maintenanceFlag: string
    acmeWebroot: string
}

export function vhostPath(dir: string, id: string, environment: EnvironmentName): string {
    return posix.join(dir, `${id}-${environment}.conf`)
}

const aliasLines = (aliases: string[]): string =>
    aliases.map(alias => `    ServerAlias ${alias}`).join('\n')

// Port 80 exists to do three things and nothing else: answer the ACME challenge (which 4b needs and which
// costs nothing to serve now), answer the verification token, and send everything else to https. The
// challenge and the token are matched before the rewrite, because a 301 would take a challenge with it.
function port80(input: VhostInput): string {
    return `<VirtualHost *:80>
    ServerName ${input.primary}
${aliasLines(input.aliases)}

    Alias "/.well-known/acme-challenge" "${input.acmeWebroot}/.well-known/acme-challenge"
    <Directory "${input.acmeWebroot}/.well-known/acme-challenge">
        Require all granted
    </Directory>

    <Location "/.well-known/hostd/${input.token}">
        Header always set X-Hostd-Token "${input.token}"
        Redirect 204
    </Location>

    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/
    RewriteRule ^/?(.*)$ https://${input.primary}/$1 [R=301,L]
</VirtualHost>`
}

// The maintenance rules come before the proxy so that a deploy in progress, or an upstream that is not
// answering, both meet the holding page rather than a proxy error. ErrorDocument 503 is what turns a
// failed proxy into the same page, which is the half of this that covers an unplanned outage.
function port443(input: VhostInput): string {
    return `<VirtualHost *:443>
    ServerName ${input.primary}
${aliasLines(input.aliases)}

    SSLEngine on
    SSLCertificateFile ${input.certificate.chain}
    SSLCertificateKeyFile ${input.certificate.key}

    <Location "/.well-known/hostd/${input.token}">
        Header always set X-Hostd-Token "${input.token}"
        Redirect 204
    </Location>

    DocumentRoot "${input.maintenanceDir}"
    ErrorDocument 503 /index.html
    Header always set Retry-After "120" "expr=%{REQUEST_STATUS} == 503"

    RewriteEngine On
    RewriteCond expr "-f '${input.maintenanceFlag}'"
    RewriteRule ^ - [R=503,L]

    ProxyPreserveHost On
    ProxyPass /.well-known/hostd/${input.token} !
    ProxyPass / http://127.0.0.1:${input.port}/
    ProxyPassReverse / http://127.0.0.1:${input.port}/
</VirtualHost>`
}

// An alias never serves the site. It exists to send a visitor to the one canonical address, so that a
// site is not reachable at two URLs with two sets of cookies and two entries in a search index.
function aliasRedirect(input: VhostInput): string {
    if (input.aliases.length === 0) return ''
    return `
<VirtualHost *:443>
${input.aliases.map(alias => `    ServerName ${alias}`).join('\n')}

    SSLEngine on
    SSLCertificateFile ${input.certificate.chain}
    SSLCertificateKeyFile ${input.certificate.key}

    Redirect permanent / https://${input.primary}/
</VirtualHost>`
}

export function renderVhost(input: VhostInput): string {
    return `# Generated by hostd for ${input.id} (${input.environment}). Do not edit: every change hostd makes
# rewrites this file in full. To take a site back by hand, move this file out of the include directory.

${port80(input)}

${port443(input)}${aliasRedirect(input)}
`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/agent/vhost.test.ts`
Expected: PASS. If the alias block count fails, check that `aliasRedirect` returns exactly `''` for no aliases rather than a newline.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/agent/vhost.ts hostd/src/agent/vhost.test.ts
git commit -m "Render an environment's Apache vhost from a fixed template"
```

---

### Task 5: Reading the hand-written vhosts

**Files:**
- Create: `hostd/src/agent/sites-enabled.ts`, `hostd/src/agent/sites-enabled.test.ts`

**Interfaces:**
- Consumes: `normaliseHostname` from `src/shared/hostnames.ts`
- Produces:
  - `export type VhostFile = { path: string, text: string }`
  - `export type ServerNames = { names: string[], unsupported: string | null }`
  - `export function parseServerNames(text: string): ServerNames`
  - `export function findClaims(files: VhostFile[], hostnames: string[]): { path: string, names: string[], unsupported: string | null }[]`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/sites-enabled.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseServerNames, findClaims } from './sites-enabled.ts'

describe('parseServerNames', () => {
    it('reads a ServerName and every ServerAlias, including several on one line', () => {
        const { names } = parseServerNames(`
<VirtualHost *:443>
    ServerName acme.com
    ServerAlias www.acme.com shop.acme.com
</VirtualHost>
`)
        assert.deepEqual(names, ['acme.com', 'www.acme.com', 'shop.acme.com'])
    })

    it('normalises what it finds, so a capitalised name still matches', () => {
        assert.deepEqual(parseServerNames('ServerName ACME.com').names, ['acme.com'])
    })

    it('ignores comments, because a commented-out name serves nothing', () => {
        assert.deepEqual(parseServerNames('# ServerName old.acme.com\nServerName acme.com').names, ['acme.com'])
    })

    it('does not repeat a name that appears in two blocks', () => {
        assert.deepEqual(parseServerNames('ServerName acme.com\nServerName acme.com').names, ['acme.com'])
    })

    it('reports Include as unsupported, because the names may be defined somewhere this never looked', () => {
        const parsed = parseServerNames('ServerName acme.com\nInclude /etc/apache2/common.conf')
        assert.match(parsed.unsupported ?? '', /Include/)
    })

    it('reports mod_macro as unsupported for the same reason', () => {
        assert.match(parseServerNames('Use CommonSite acme.com').unsupported ?? '', /Use/)
    })

    it('drops a name it cannot read as a hostname rather than passing it on', () => {
        assert.deepEqual(parseServerNames('ServerName ${SITE_NAME}').names, [])
    })
})

describe('findClaims', () => {
    const files = [
        { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\nServerAlias www.acme.com' },
        { path: '/etc/apache2/sites-enabled/other.conf', text: 'ServerName other.com' },
    ]

    it('returns only the files claiming one of the hostnames asked about', () => {
        const claims = findClaims(files, ['acme.com'])
        assert.equal(claims.length, 1)
        assert.equal(claims[0]!.path, '/etc/apache2/sites-enabled/acme.conf')
    })

    it('reports every name that file serves, not only the ones asked about', () => {
        assert.deepEqual(findClaims(files, ['acme.com'])[0]!.names, ['acme.com', 'www.acme.com'])
    })

    it('matches on an alias as readily as on the primary', () => {
        assert.equal(findClaims(files, ['www.acme.com']).length, 1)
    })

    it('returns nothing when no file claims the hostname', () => {
        assert.deepEqual(findClaims(files, ['nobody.com']), [])
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/agent/sites-enabled.test.ts`
Expected: FAIL, `Cannot find module './sites-enabled.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/sites-enabled.ts`:

```ts
// Reading just enough of a hand-written vhost to know which hostnames it serves. This is not an Apache
// configuration parser and must never grow into one: it reads ServerName and ServerAlias, and when it
// meets a directive that could define a hostname somewhere it cannot see, it says so and adoption
// refuses. Half-understanding a file that is serving a client's site is the failure this exists to stop.

import { normaliseHostname } from '../shared/hostnames.ts'

export type VhostFile = { path: string, text: string }
export type ServerNames = { names: string[], unsupported: string | null }

const NAME_LINE = /^\s*Server(?:Name|Alias)\s+(.+?)\s*$/i
// Include and IncludeOptional pull in files this never read. Use is mod_macro, where the hostname is an
// argument expanded at load time and is not in this file in any readable form.
const UNSUPPORTED = /^\s*(Include|IncludeOptional|Use)\s+/i

export function parseServerNames(text: string): ServerNames {
    const names: string[] = []
    let unsupported: string | null = null
    for (const raw of text.split('\n')) {
        // Apache treats a line whose first non-space character is # as a comment in full; there is no
        // trailing-comment syntax, so this is the whole rule.
        if (/^\s*#/.test(raw)) continue

        const blocked = raw.match(UNSUPPORTED)
        if (blocked && unsupported === null) {
            unsupported = `${blocked[1]} is used, so the hostnames this file serves cannot be read here`
            continue
        }

        const match = raw.match(NAME_LINE)
        if (!match) continue
        // ServerAlias takes several names on one line, separated by whitespace.
        for (const candidate of match[1]!.split(/\s+/)) {
            const host = normaliseHostname(candidate)
            // A name that will not normalise is a variable, a wildcard or a typo. None of those is a
            // hostname this can claim to have understood, so it is dropped rather than carried.
            if (host !== null && !names.includes(host)) names.push(host)
        }
    }
    return { names, unsupported }
}

export function findClaims(
    files: VhostFile[],
    hostnames: string[],
): { path: string, names: string[], unsupported: string | null }[] {
    const claims: { path: string, names: string[], unsupported: string | null }[] = []
    for (const file of files) {
        const parsed = parseServerNames(file.text)
        if (!parsed.names.some(name => hostnames.includes(name))) continue
        claims.push({ path: file.path, names: parsed.names, unsupported: parsed.unsupported })
    }
    return claims
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/agent/sites-enabled.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/agent/sites-enabled.ts hostd/src/agent/sites-enabled.test.ts
git commit -m "Read the hostnames a hand-written vhost serves, and refuse the ones it cannot"
```

---

### Task 6: The agent's end of the rail

**Files:**
- Create: `hostd/src/agent/apache-rail.ts`, `hostd/src/agent/apache-rail.test.ts`
- Create: `hostd/src/agent/testing/fake-rail.mjs`
- Modify: `hostd/docker-compose.yml`

**Interfaces:**
- Consumes: `ApacheRequest`, `ApacheResult`, `parseApacheResult`, `REQUEST_FILE`, `RESULT_FILE` from Task 3
- Produces:
  - `export type RailFs = { writeFile(path: string, text: string): Promise<void>, rename(from: string, to: string): Promise<void>, readFile(path: string): Promise<string>, unlink(path: string): Promise<void> }`
  - `export const RAIL_TIMEOUT_MS = 30_000`, `export const RAIL_POLL_MS = 250`
  - `export class ApacheRail` with `constructor(dir: string, fs: RailFs, options?: { now?: () => number, sleep?: (ms: number) => Promise<void> })`, `send(action, parts): Promise<ApacheResult>`, `lastSuccessAt(): number | null`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/apache-rail.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ApacheRail, RAIL_TIMEOUT_MS, type RailFs } from './apache-rail.ts'

// A fake host unit: it sees the request land and answers it, the way the systemd unit does. reply
// decides what it writes, so a test can make the configtest fail or make it answer the wrong request.
function setup(reply: (request: { seq: number }) => { seq: number, ok: boolean, output: string } | null = r => ({ seq: r.seq, ok: true, output: 'Syntax OK' })) {
    const files = new Map<string, string>()
    const writes: string[] = []
    let clock = 0
    const fs: RailFs = {
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) {
            const text = files.get(from)!
            files.delete(from)
            files.set(to, text)
            writes.push(to)
            if (to.endsWith('request.json')) {
                const answer = reply(JSON.parse(text))
                if (answer) {
                    files.set('/rail/result.json', JSON.stringify(answer))
                    files.delete(to)
                }
            }
        },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return text
        },
        async unlink(path) { files.delete(path) },
    }
    const rail = new ApacheRail('/rail', fs, {
        now: () => clock,
        sleep: async ms => { clock += ms },
    })
    return { rail, files, writes }
}

describe('ApacheRail', () => {
    it('writes the request by rename, never in place', async () => {
        const { rail, writes } = setup()
        await rail.send('reload', { write: { path: '/etc/apache2/hostd/a-live.conf', text: 'x' }, remove: [], disable: [] })
        assert.ok(writes.includes('/rail/request.json'))
    })

    it('returns the host unit\'s result', async () => {
        const { rail } = setup()
        const result = await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(result.ok, true)
        assert.equal(result.output, 'Syntax OK')
    })

    it('carries a failed configtest back with Apache\'s own output', async () => {
        const { rail } = setup(r => ({ seq: r.seq, ok: false, output: 'AH00526: Syntax error' }))
        const result = await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(result.ok, false)
        assert.match(result.output, /AH00526/)
    })

    it('increments the sequence, so two requests are never confused', async () => {
        const seen: number[] = []
        const { rail } = setup(r => { seen.push(r.seq); return { seq: r.seq, ok: true, output: '' } })
        await rail.send('reload', { write: null, remove: [], disable: [] })
        await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(seen[1], seen[0]! + 1)
    })

    it('ignores a result left over from an earlier request and keeps waiting', async () => {
        // The host unit answers the previous sequence, which is exactly what a stale result looks like.
        const { rail } = setup(r => ({ seq: r.seq - 1, ok: true, output: 'stale' }))
        await assert.rejects(
            rail.send('reload', { write: null, remove: [], disable: [] }),
            /did not answer/,
        )
    })

    it('gives up after the timeout, so a dead host unit fails rather than hangs', async () => {
        const { rail } = setup(() => null)
        await assert.rejects(rail.send('reload', { write: null, remove: [], disable: [] }), /did not answer/)
    })

    it('records when it last got an answer, for health to report', async () => {
        const { rail } = setup()
        assert.equal(rail.lastSuccessAt(), null)
        await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.notEqual(rail.lastSuccessAt(), null)
    })

    it('runs one request at a time, so two callers cannot interleave their sequences', async () => {
        const order: string[] = []
        const { rail } = setup(r => { order.push(`answer${r.seq}`); return { seq: r.seq, ok: true, output: '' } })
        await Promise.all([
            rail.send('reload', { write: null, remove: [], disable: [] }).then(() => order.push('done-a')),
            rail.send('reload', { write: null, remove: [], disable: [] }).then(() => order.push('done-b')),
        ])
        // The second request is not written until the first has been answered.
        assert.deepEqual(order.slice(0, 2), ['answer0', 'done-a'])
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/agent/apache-rail.test.ts`
Expected: FAIL, `Cannot find module './apache-rail.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/apache-rail.ts`:

```ts
// The agent's end of the host rail. Apache runs on the host and this process has no network namespace,
// so the only way to change what Apache serves is to leave a file where a systemd unit will find it.
//
// The sequence number is the whole safety argument. A result carrying an older number is a leftover from
// a request that timed out, and acting on it would mean believing an answer to a different question.

import { posix } from 'node:path'
import { parseApacheResult, REQUEST_FILE, RESULT_FILE, type ApacheAction, type ApacheRequest, type ApacheResult, type ApacheWrite } from '../shared/apache.ts'

export const RAIL_TIMEOUT_MS = 30_000
export const RAIL_POLL_MS = 250

export type RailFs = {
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    readFile(path: string): Promise<string>
    unlink(path: string): Promise<void>
}

export type RailParts = { write: ApacheWrite | null, remove: string[], disable: string[] }

const sleepReal = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class ApacheRail {
    private seq = 0
    private queue: Promise<unknown> = Promise.resolve()
    private lastSuccess: number | null = null
    private readonly now: () => number
    private readonly sleep: (ms: number) => Promise<void>

    constructor(
        private readonly dir: string,
        private readonly fs: RailFs,
        options: { now?: () => number, sleep?: (ms: number) => Promise<void> } = {},
    ) {
        this.now = options.now ?? (() => Date.now())
        this.sleep = options.sleep ?? sleepReal
    }

    lastSuccessAt(): number | null {
        return this.lastSuccess
    }

    // Serialised rather than merely awaited by callers: two domain actions arriving together would
    // otherwise write two requests, and the host unit answers one file.
    send(action: ApacheAction, parts: RailParts): Promise<ApacheResult> {
        const run = this.queue.then(() => this.one(action, parts))
        // The queue must not reject, or every later request inherits the failure.
        this.queue = run.catch(() => undefined)
        return run
    }

    private async one(action: ApacheAction, parts: RailParts): Promise<ApacheResult> {
        const seq = this.seq++
        const request: ApacheRequest = { seq, action, ...parts }
        const target = posix.join(this.dir, REQUEST_FILE)
        const staging = `${target}.tmp`
        // Rename, so the unit never sees a half-written request. A path unit fires on the name appearing,
        // and a plain write would make it appear while it is still being filled.
        await this.fs.writeFile(staging, JSON.stringify(request))
        await this.fs.rename(staging, target)

        const deadline = this.now() + RAIL_TIMEOUT_MS
        const resultPath = posix.join(this.dir, RESULT_FILE)
        while (this.now() < deadline) {
            let text: string | null = null
            try {
                text = await this.fs.readFile(resultPath)
            } catch {
                // Not written yet, which is the ordinary case for the first few polls.
            }
            const result = text === null ? null : parseApacheResult(text)
            if (result && result.seq === seq) {
                await this.fs.unlink(resultPath).catch(() => undefined)
                this.lastSuccess = this.now()
                return result
            }
            await this.sleep(RAIL_POLL_MS)
        }
        // The request file is deliberately left where it is. If the unit is merely slow it will still be
        // answered, and the sequence number means that answer is ignored rather than mistaken for the
        // next request's.
        throw new Error(`the Apache host unit did not answer request ${seq} within ${RAIL_TIMEOUT_MS}ms`)
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/agent/apache-rail.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Write the fake host unit used by later integration tests**

Create `hostd/src/agent/testing/fake-rail.mjs`:

```js
// A host unit that runs in a test. It implements the same handshake as hostd/host/hostd-apache.sh:
// watch for request.json, perform the writes, run a configtest (which here is whatever the caller says
// it is), reload nothing, write result.json, delete request.json.
//
// This exists so the agent's half of the protocol is exercised end to end against a real filesystem,
// without Apache or systemd. The real unit is checked by hand once, per the runbook.

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export function startFakeRail(dir, { configtest = () => ({ ok: true, output: 'Syntax OK' }) } = {}) {
    let stopped = false
    const loop = (async () => {
        while (!stopped) {
            let request
            try {
                request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'))
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5))
                continue
            }
            for (const path of request.remove ?? []) await unlink(path).catch(() => undefined)
            for (const path of request.disable ?? []) {
                await mkdir(join(dirname(path), '..', 'hostd-adopted'), { recursive: true })
                await rename(path, join(dirname(path), '..', 'hostd-adopted', `${path.split('/').pop()}.bak`))
            }
            if (request.write) {
                await mkdir(dirname(request.write.path), { recursive: true })
                await writeFile(request.write.path, request.write.text)
            }
            const test = configtest(request)
            await writeFile(join(dir, 'result.json'), JSON.stringify({ seq: request.seq, ok: test.ok, output: test.output }))
            await unlink(join(dir, 'request.json')).catch(() => undefined)
        }
    })()
    return { stop: async () => { stopped = true; await loop } }
}
```

- [ ] **Step 6: Add the mounts and settings the rail needs**

In `hostd/docker-compose.yml`, under the `agent` service's `environment:`, add:

```yaml
      HOSTD_APACHE_RAIL_DIR: /etc/hostd/apache
      HOSTD_APACHE_INCLUDE_DIR: /etc/apache2/hostd
      HOSTD_APACHE_SITES_ENABLED: /etc/apache2/sites-enabled
      HOSTD_ORIGIN_CERT: /etc/ssl/hostd/origin.pem
      HOSTD_ORIGIN_KEY: /etc/ssl/hostd/origin.key
      HOSTD_ACME_WEBROOT: /var/www/hostd-acme
      HOSTD_MAINTENANCE_ROOT: /var/www/hostd-maintenance
```

And under its `volumes:`:

```yaml
      # The handshake with the host's systemd unit. A directory of its own holding nothing but
      # request.json and result.json, so neither container can see anything else through it.
      - /etc/hostd/apache:/etc/hostd/apache
      # hostd's own include directory, which Apache is configured to IncludeOptional. Writable, because
      # this is the whole point: hostd owns every file in here and no file anywhere else.
      - /etc/apache2/hostd:/etc/apache2/hostd
      # Read-only, and it stays read-only. The agent reads this to refuse a hostname another vhost
      # already claims; moving a file out of it during an adoption is the host unit's job, precisely so
      # that a compromised agent cannot disable every site on the machine.
      - /etc/apache2/sites-enabled:/etc/apache2/sites-enabled:ro
      # The Origin certificate the vhosts present. Read-only, and never named by anything that arrives
      # over the wire.
      - /etc/ssl/hostd:/etc/ssl/hostd:ro
```

- [ ] **Step 7: Commit**

```bash
cd hostd && npm run typecheck && npm test
git add hostd/src/agent/apache-rail.ts hostd/src/agent/apache-rail.test.ts hostd/src/agent/testing/fake-rail.mjs hostd/docker-compose.yml
git commit -m "Give the agent its end of the Apache host rail"
```

---

### Task 7: The domains verb's grammar

**Files:**
- Modify: `hostd/src/shared/protocol.ts`
- Modify: `hostd/src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: `EnvironmentName` from `src/shared/registry.ts`
- Produces:
  - `export type DomainsWriteArgs = { action: 'write', environment: EnvironmentName, token: string }`
  - `export type DomainsRemoveArgs = { action: 'remove', environment: EnvironmentName }`
  - `export type DomainsPreviewArgs = { action: 'preview', environment: EnvironmentName }`
  - `export type DomainsAdoptArgs = { action: 'adopt', environment: EnvironmentName, token: string, disable: string[] }`
  - `export type DomainsSetAliasesArgs = { action: 'set-aliases', environment: EnvironmentName, aliases: string[], token: string }`
  - `export type DomainsArgs = DomainsWriteArgs | DomainsRemoveArgs | DomainsPreviewArgs | DomainsAdoptArgs | DomainsSetAliasesArgs`
    - `set-aliases` is how an alias is added or removed. It carries the whole list the environment should end up with rather than one hostname and a direction, because the agent writes the registry and then rewrites the vhost from it: a list makes the pair idempotent, so a retry after a half-failure lands in the same place instead of adding the alias twice. It carries the token too, because the vhost is rewritten in the same call and the token has to survive that rewrite.
  - `export type DomainsRequest = { verb: 'domains', project: string, args: DomainsArgs }`
  - `export function parseDomainsArgs(args: unknown): { ok: true, args: DomainsArgs } | Refusal`
  - The replies themselves are declared beside the code that builds them: `DomainsWritten` in Task 8 and `AdoptPreview` in Task 9, both in `src/agent/domains.ts`. Nothing in `protocol.ts` needs them, because the agent's server hands them straight to the socket.
  - `DomainsRequest` added to `ProjectRequest`, and `domains: 'domains'` added to `VERB_CAPABILITY`

- [ ] **Step 1: Write the failing test**

Add to `hostd/src/shared/protocol.test.ts`:

```ts
describe('parseDomainsArgs', () => {
    const ok = (args: unknown) => {
        const parsed = parseDomainsArgs(args)
        assert.equal(parsed.ok, true, JSON.stringify(parsed))
        return parsed
    }

    it('accepts a write with an environment and a token', () => {
        const parsed = ok({ action: 'write', environment: 'live', token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args, { action: 'write', environment: 'live', token: 'abc123' })
    })

    it('accepts a remove, a preview and an adopt', () => {
        ok({ action: 'remove', environment: 'test' })
        ok({ action: 'preview', environment: 'live' })
        ok({ action: 'adopt', environment: 'live', token: 'abc123', disable: ['/etc/apache2/sites-enabled/acme.conf'] })
    })

    it('refuses an unknown action', () => {
        assert.equal(parseDomainsArgs({ action: 'rewrite', environment: 'live' }).ok, false)
    })

    it('refuses an unknown environment', () => {
        assert.equal(parseDomainsArgs({ action: 'remove', environment: 'staging' }).ok, false)
    })

    it('refuses an extra field, because the agent is root and ignores nothing', () => {
        assert.equal(parseDomainsArgs({ action: 'remove', environment: 'live', force: true }).ok, false)
    })

    it('refuses a token that is not plain hex, so nothing shaped like a path reaches a Location', () => {
        for (const bad of ['../x', 'a b', '', 'Z'.repeat(32)]) {
            assert.equal(parseDomainsArgs({ action: 'write', environment: 'live', token: bad }).ok, false, bad)
        }
    })

    it('refuses a disable entry that is not inside sites-enabled', () => {
        const parsed = parseDomainsArgs({ action: 'adopt', environment: 'live', token: 'abc123', disable: ['/etc/passwd'] })
        assert.equal(parsed.ok, false)
    })

    it('refuses a disable entry that climbs out with dot segments', () => {
        const parsed = parseDomainsArgs({
            action: 'adopt', environment: 'live', token: 'abc123',
            disable: ['/etc/apache2/sites-enabled/../../passwd'],
        })
        assert.equal(parsed.ok, false)
    })

    it('accepts set-aliases with a list and a token', () => {
        const parsed = ok({ action: 'set-aliases', environment: 'live', aliases: ['www.acme.com'], token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args.action === 'set-aliases' && parsed.args.aliases, ['www.acme.com'])
    })

    it('accepts an empty alias list, which is how the last one is removed', () => {
        ok({ action: 'set-aliases', environment: 'live', aliases: [], token: 'abc123' })
    })

    it('refuses an alias that is not a hostname, before it can reach a ServerAlias', () => {
        for (const bad of ['localhost', 'not a host', '../etc', 'https://acme.com']) {
            const parsed = parseDomainsArgs({ action: 'set-aliases', environment: 'live', aliases: [bad], token: 'abc123' })
            assert.equal(parsed.ok, false, bad)
        }
    })

    it('normalises the aliases it accepts, so one spelling reaches the registry', () => {
        const parsed = ok({ action: 'set-aliases', environment: 'live', aliases: ['WWW.Acme.com'], token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args.action === 'set-aliases' && parsed.args.aliases, ['www.acme.com'])
    })

    it('refuses a list longer than any project could allow, before the registry is read', () => {
        const many = Array.from({ length: 21 }, (_, i) => `a${i}.acme.com`)
        assert.equal(parseDomainsArgs({ action: 'set-aliases', environment: 'live', aliases: many, token: 'abc123' }).ok, false)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/shared/protocol.test.ts`
Expected: FAIL, `parseDomainsArgs is not exported`.

- [ ] **Step 3: Write the implementation**

In `hostd/src/shared/protocol.ts`, add the types listed in **Interfaces**, add `DomainsRequest` to the `ProjectRequest` union, add `domains: 'domains'` to `VERB_CAPABILITY`, and add:

```ts
// Hex only, and bounded. This string is interpolated into a <Location> and into a header value in the
// vhost, so it is the one value from api that reaches Apache's configuration. Nothing that could be read
// as a path, a quote or a directive is allowed to be a token.
const DOMAIN_TOKEN = /^[0-9a-f]{8,64}$/
// The only directory an adopt may disable a file in. Checked here as well as in the agent, because this
// is where a value from api first becomes something a root process will act on.
const SITES_ENABLED = '/etc/apache2/sites-enabled/'

export function parseDomainsArgs(args: unknown): { ok: true, args: DomainsArgs } | Refusal {
    if (!isRecord(args)) return refuse('bad-request', 'domains args must be an object')
    const environment = args.environment
    if (typeof environment !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return refuse('bad-request', `environment must be one of ${ENVIRONMENTS.join(', ')}`)
    }
    const name = environment as EnvironmentName

    const token = (): string | null => (typeof args.token === 'string' && DOMAIN_TOKEN.test(args.token) ? args.token : null)

    switch (args.action) {
        case 'write': {
            if (!onlyKeys(args, ['action', 'environment', 'token'])) return refuse('bad-request', 'write takes only environment and token')
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            return { ok: true, args: { action: 'write', environment: name, token: value } }
        }
        case 'remove':
            if (!onlyKeys(args, ['action', 'environment'])) return refuse('bad-request', 'remove takes only environment')
            return { ok: true, args: { action: 'remove', environment: name } }
        case 'preview':
            if (!onlyKeys(args, ['action', 'environment'])) return refuse('bad-request', 'preview takes only environment')
            return { ok: true, args: { action: 'preview', environment: name } }
        case 'adopt': {
            if (!onlyKeys(args, ['action', 'environment', 'token', 'disable'])) {
                return refuse('bad-request', 'adopt takes only environment, token and disable')
            }
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            const disable = args.disable
            if (!Array.isArray(disable) || disable.length === 0) return refuse('bad-request', 'adopt must name at least one file to disable')
            for (const path of disable) {
                if (typeof path !== 'string' || !path.startsWith(SITES_ENABLED) || path.includes('/..') || path.includes('/.')) {
                    return refuse('bad-request', 'every disable entry must be a plain path inside sites-enabled')
                }
            }
            return { ok: true, args: { action: 'adopt', environment: name, token: value, disable: disable as string[] } }
        }
        case 'set-aliases': {
            if (!onlyKeys(args, ['action', 'environment', 'aliases', 'token'])) {
                return refuse('bad-request', 'set-aliases takes only environment, aliases and token')
            }
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            const list = args.aliases
            if (!Array.isArray(list)) return refuse('bad-request', 'aliases must be a list of hostnames')
            // maxDomains caps at 20 per project, so a longer list cannot be valid for any project and is
            // refused before the registry is even read. The real per-project cap is checked in the agent,
            // which is what knows which project this is.
            if (list.length > MAX_ALIASES) return refuse('bad-request', `at most ${MAX_ALIASES} aliases`)
            const aliases: string[] = []
            for (const entry of list) {
                const host = normaliseHostname(entry)
                if (host === null) return refuse('bad-request', 'every alias must be a hostname')
                if (aliases.includes(host)) return refuse('bad-request', `${host} is listed twice`)
                aliases.push(host)
            }
            return { ok: true, args: { action: 'set-aliases', environment: name, aliases, token: value } }
        }
        default:
            return refuse('bad-request', 'domains action must be write, remove, preview, adopt or set-aliases')
    }
}
```

`MAX_ALIASES` is 20, matching the registry's own ceiling on `maxDomains`, and `normaliseHostname` is
imported from `./hostnames.ts` (Task 1). Normalising here rather than only in the agent means one spelling
of a hostname reaches the registry however it was typed in the portal.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/shared/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts
git commit -m "Add the domains verb to the agent's grammar"
```

---

### Task 8: Writing and removing a vhost

**Files:**
- Create: `hostd/src/agent/domains.ts`, `hostd/src/agent/domains.test.ts`

**Interfaces:**
- Consumes: `renderVhost`, `vhostPath` (Task 4), `ApacheRail` (Task 6), `hostnamesOf` (Task 2), `DomainsArgs` (Task 7)
- Produces:
  - `export type DomainsDeps = { rail: Pick<ApacheRail, 'send'>, readFile(path: string): Promise<string | null>, listSitesEnabled(): Promise<VhostFile[]>, config: DomainsConfig }`
  - `export type DomainsConfig = { includeDir: string, sitesEnabled: string, originCert: string, originKey: string, acmeWebroot: string, maintenanceFlagDir: string, maintenancePageDir: string }`
    - **The two maintenance paths are different things and the names must stay apart.** `maintenanceFlagDir` is where the deploy work already writes its per-environment flag files, `/run/hostd/maintenance`, from the agent's existing `HOSTD_MAINTENANCE_DIR`. `maintenancePageDir` is the holding page's DocumentRoot, `/var/www/hostd-maintenance`, from the new `HOSTD_MAINTENANCE_ROOT` that Task 6 adds. An earlier draft of this plan called the first one `maintenanceRoot`, which read as the second, and would have made every vhost test a flag path that never exists, so the holding page would never have appeared during a deploy.
  - `export async function writeVhost(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, token: string): Promise<DomainsWrittenReply | Refusal>`
  - `export async function removeVhost(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry): Promise<DomainsWrittenReply | Refusal>`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/domains.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { writeVhost, removeVhost, type DomainsDeps } from './domains.ts'

const REGISTRY = `
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        port: 5010
        domain: acme.com
        aliases: [www.acme.com]
`

function setup(options: { railOk?: boolean, existing?: string | null } = {}) {
    const sent: { action: string, write: { path: string, text: string } | null, remove: string[], disable: string[] }[] = []
    const railOk = options.railOk ?? true
    const deps: DomainsDeps = {
        rail: {
            async send(action, parts) {
                sent.push({ action, ...parts })
                // The revert, which is the second call, always passes: only the first is made to fail.
                const ok = railOk || sent.length > 1
                return { seq: sent.length - 1, ok, output: ok ? 'Syntax OK' : 'AH00526: Syntax error on line 9' }
            },
        },
        async readFile() { return options.existing ?? null },
        async listSitesEnabled() { return [] },
        config: {
            includeDir: '/etc/apache2/hostd',
            sitesEnabled: '/etc/apache2/sites-enabled',
            originCert: '/etc/ssl/hostd/origin.pem',
            originKey: '/etc/ssl/hostd/origin.key',
            acmeWebroot: '/var/www/hostd-acme',
            maintenanceFlagDir: '/run/hostd/maintenance',
            maintenancePageDir: '/var/www/hostd-maintenance',
        },
    }
    const registry = parseRegistry(REGISTRY)
    const project = registry.projects.get('acme')!
    return { deps, sent, project, environment: project.environments.get('live')! }
}

describe('writeVhost', () => {
    it('sends one reload carrying the rendered file', async () => {
        const { deps, sent, project, environment } = setup()
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'reload')
        assert.equal(sent[0]!.write?.path, '/etc/apache2/hostd/acme-live.conf')
        assert.match(sent[0]!.write?.text ?? '', /ServerName acme\.com/)
    })

    it('answers with every hostname it just made live', async () => {
        const { deps, project, environment } = setup()
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.written.hostnames, ['acme.com', 'www.acme.com'])
    })

    it('refuses an environment with no domain rather than writing a vhost that serves nothing', async () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
`)
        const { deps } = setup()
        const project = registry.projects.get('acme')!
        const result = await writeVhost(deps, project, project.environments.get('live')!, 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /no domain/)
    })

    it('puts the previous file back when the configtest fails', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false, existing: '# the old file\n' })
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 2, 'the revert is a second request')
        assert.equal(sent[1]!.write?.text, '# the old file\n')
    })

    it('removes the file it wrote when the configtest fails and there was no previous file', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false, existing: null })
        await writeVhost(deps, project, environment, 'abc123')
        assert.deepEqual(sent[1]!.remove, ['/etc/apache2/hostd/acme-live.conf'])
        assert.equal(sent[1]!.write, null)
    })

    it('carries Apache\'s own output back, because that is what says what is wrong', async () => {
        const { deps, project, environment } = setup({ railOk: false })
        const result = await writeVhost(deps, project, environment, 'abc123')
        assert.match(result.ok === false ? result.output ?? '' : '', /AH00526/)
    })
})

describe('removeVhost', () => {
    it('removes the file and reloads', async () => {
        const { deps, sent, project, environment } = setup()
        const result = await removeVhost(deps, project, environment)
        assert.equal(result.ok, true)
        assert.deepEqual(sent[0]!.remove, ['/etc/apache2/hostd/acme-live.conf'])
        assert.equal(sent[0]!.write, null)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/agent/domains.test.ts`
Expected: FAIL, `Cannot find module './domains.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/domains.ts`:

```ts
// The agent's domain verb. It renders a vhost, puts it on the host through the rail, and puts the
// previous one back when Apache refuses the result.
//
// Reverting is here rather than in the host unit because this is what knows the previous contents. On a
// failed configtest nothing has reloaded, so the running configuration is still good; what is dangerous
// is the bad file sitting on disk, which the next unrelated reload or a reboot would pick up.

import { posix } from 'node:path'
import { hostnamesOf, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { ApacheRail } from './apache-rail.ts'
import type { VhostFile } from './sites-enabled.ts'
import { renderVhost, vhostPath } from './vhost.ts'

export type DomainsConfig = {
    includeDir: string
    sitesEnabled: string
    originCert: string
    originKey: string
    acmeWebroot: string
    maintenanceFlagDir: string
    maintenancePageDir: string
}

export type DomainsDeps = {
    rail: Pick<ApacheRail, 'send'>
    // null rather than a throw when the file is not there: a first write has no previous file, and that
    // is the ordinary case rather than an error.
    readFile(path: string): Promise<string | null>
    listSitesEnabled(): Promise<VhostFile[]>
    config: DomainsConfig
}

export type DomainsWritten = { ok: true, written: { hostnames: string[], path: string } }

function render(deps: DomainsDeps, project: ProjectEntry, environment: EnvironmentEntry, token: string): string {
    return renderVhost({
        id: project.id,
        environment: environment.name,
        primary: environment.domain!,
        aliases: environment.aliases,
        port: environment.port,
        token,
        certificate: { chain: deps.config.originCert, key: deps.config.originKey },
        maintenanceDir: deps.config.maintenancePageDir,
        maintenanceFlag: posix.join(deps.config.maintenanceFlagDir, `${project.id}-${environment.name}`),
        acmeWebroot: deps.config.acmeWebroot,
    })
}

// Put back what was there, or take away what was just put down. Either way a second reload follows, so
// that the configuration on disk is known to pass a configtest before this returns.
async function revert(deps: DomainsDeps, path: string, previous: string | null): Promise<string> {
    const parts = previous === null
        ? { write: null, remove: [path], disable: [] }
        : { write: { path, text: previous }, remove: [], disable: [] }
    try {
        const result = await deps.rail.send('reload', parts)
        return result.ok ? '' : ` The previous configuration could not be restored either: ${result.output}`
    } catch (error) {
        return ` The previous configuration could not be restored either: ${error instanceof Error ? error.message : String(error)}`
    }
}

export async function writeVhost(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is no vhost to write`)
    }
    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const text = render(deps, project, environment, token)

    const result = await deps.rail.send('reload', { write: { path, text }, remove: [], disable: [] })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the new configuration for ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames: hostnamesOf(environment), path } }
}

export async function removeVhost(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
): Promise<DomainsWritten | Refusal> {
    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const result = await deps.rail.send('reload', { write: null, remove: [path], disable: [] })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the configuration without ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames: [], path } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/agent/domains.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Add the action that changes which hostnames an environment has**

`writeVhost` renders whatever the registry says. Changing what it says is a second thing, and Task 14's
add and remove endpoints need it. `DomainsDeps` gains a writer and a reload:

```ts
export type DomainsDeps = {
    rail: Pick<ApacheRail, 'send'>
    readFile(path: string): Promise<string | null>
    listSitesEnabled(): Promise<VhostFile[]>
    // The same RegistryWriter provisioning already uses, and a reload so the entry this just wrote is
    // what the vhost is rendered from. Rendering from the arguments instead would let a write that was
    // silently rejected still produce a vhost claiming the alias.
    writeRegistry(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
    reloadRegistry(): Promise<Registry>
    config: DomainsConfig
}
```

Add the function:

```ts
// Add or remove an alias. The caller hands over the whole list the environment should end up with, so a
// retry after a half-failure lands in the same place rather than adding the same alias twice.
//
// The order is registry first, then vhost, and it matters. The registry is the record of what this site
// is entitled to serve; the vhost is a rendering of it. Writing the vhost first would mean a crash
// between the two left Apache serving a hostname no entry claims, which is the one state nothing else in
// hostd knows how to correct.
export async function setAliases(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    aliases: string[],
    token: string,
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so it cannot have aliases`)
    }
    if (aliases.includes(environment.domain)) {
        return refuse('bad-request', `${environment.domain} is already this environment's domain`)
    }
    // The project's own cap, which the grammar's blanket ceiling could not know.
    if (1 + aliases.length > project.maxDomains) {
        return refuse('bad-request', `${project.id} allows at most ${project.maxDomains} hostnames per environment`)
    }

    const written = await deps.writeRegistry({
        kind: 'set-aliases', id: project.id, environment: environment.name, aliases,
    })
    if (!written.ok) return refuse('failed', `the registry could not be updated: ${written.problem}`)

    // Re-read rather than trusting the write: parseRegistry is what enforces reserved, the allowed
    // carve-out and cross-project uniqueness, and a list that passed the grammar can still fail those.
    const registry = await deps.reloadRegistry()
    const fresh = registry.projects.get(project.id)?.environments.get(environment.name)
    if (!fresh) {
        return refuse('failed', `${project.id} ${environment.name} did not survive the change`)
    }
    return writeVhost(deps, registry.projects.get(project.id)!, fresh, token)
}
```

And the tests:

```ts
describe('setAliases', () => {
    it('writes the registry before it writes the vhost', async () => {
        const order: string[] = []
        const { deps, project, environment } = setup()
        deps.writeRegistry = async () => { order.push('registry'); return { ok: true } }
        deps.reloadRegistry = async () => { order.push('reload'); return reloaded(['www.acme.com']) }
        const inner = deps.rail.send
        deps.rail = { send: async (a, p) => { order.push('vhost'); return inner(a, p) } }
        await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.deepEqual(order, ['registry', 'reload', 'vhost'])
    })

    it('does not touch Apache when the registry write is refused', async () => {
        const { deps, sent, project, environment } = setup()
        deps.writeRegistry = async () => ({ ok: false, problem: 'someone else changed it' })
        const result = await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 0)
    })

    it('refuses an alias equal to the primary', async () => {
        const { deps, project, environment } = setup()
        const result = await setAliases(deps, project, environment, ['acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /already this environment's domain/)
    })

    it('refuses more hostnames than the project allows, counting the primary', async () => {
        const { deps, project, environment } = setup()
        const capped = { ...project, maxDomains: 2 }
        const result = await setAliases(deps, capped, environment, ['a.acme.com', 'b.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /at most 2 hostnames/)
    })

    it('renders the vhost from the reloaded entry, not from the arguments', async () => {
        const { deps, sent, project, environment } = setup()
        // The registry accepted only one of the two: the second was already taken by another project.
        deps.reloadRegistry = async () => reloaded(['www.acme.com'])
        await setAliases(deps, project, environment, ['www.acme.com', 'taken.com'], 'abc123')
        assert.doesNotMatch(sent[0]!.write?.text ?? '', /taken\.com/)
    })

    it('reports an entry that did not survive the change rather than writing a vhost for it', async () => {
        const { deps, sent, project, environment } = setup()
        deps.reloadRegistry = async () => parseRegistry('projects: {}')
        const result = await setAliases(deps, project, environment, ['www.acme.com'], 'abc123')
        assert.equal(result.ok, false)
        assert.equal(sent.length, 0)
    })
})
```

Extend `setup()` with defaults for the two new deps, and add a `reloaded(aliases)` helper beside it that
returns `parseRegistry` over the same fixture with the given aliases spliced in, so each test names only
what it cares about.

- [ ] **Step 6: Commit**

```bash
cd hostd && npm run typecheck && npm test
git add hostd/src/agent/domains.ts hostd/src/agent/domains.test.ts
git commit -m "Write and remove an environment's vhost, reverting when Apache refuses it"
```

---

### Task 9: Previewing and performing an adoption

**Files:**
- Modify: `hostd/src/agent/domains.ts`, `hostd/src/agent/domains.test.ts`

**Interfaces:**
- Consumes: `findClaims` (Task 5), `writeVhost`'s helpers (Task 8)
- Produces:
  - `export type AdoptPreview = { ok: true, preview: { proposed: string, claims: { path: string, names: string[], unsupported: string | null }[], extraNames: string[], adoptable: boolean } }`
  - `export async function previewAdopt(deps, project, environment, token): Promise<AdoptPreview | Refusal>`
  - `export async function adopt(deps, project, environment, token, disable): Promise<DomainsWritten | Refusal>`

- [ ] **Step 1: Write the failing test**

Add to `hostd/src/agent/domains.test.ts`:

```ts
describe('previewAdopt', () => {
    const handWritten = {
        path: '/etc/apache2/sites-enabled/acme.conf',
        text: 'ServerName acme.com\nServerAlias www.acme.com legacy.acme.com\n',
    }

    it('shows the file that serves this site today and the one hostd proposes', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.preview.claims[0]!.path, handWritten.path)
        assert.match(result.ok ? result.preview.proposed : '', /ServerName acme\.com/)
    })

    it('lists hostnames the old file serves that the registry does not know about', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.deepEqual(result.ok && result.preview.extraNames, ['legacy.acme.com'])
    })

    it('moves nothing and reloads nothing', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(sent.length, 0)
    })

    it('refuses to call a file adoptable when it uses Include', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [{ path: handWritten.path, text: 'ServerName acme.com\nInclude /etc/apache2/common.conf' }]
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.adoptable, false)
    })

    it('is adoptable with no claims at all, which is a site that has no hand-written vhost', async () => {
        const { deps, project, environment } = setup()
        const result = await previewAdopt(deps, project, environment, 'abc123')
        assert.equal(result.ok && result.preview.adoptable, true)
        assert.deepEqual(result.ok && result.preview.claims, [])
    })
})

describe('adopt', () => {
    const handWritten = { path: '/etc/apache2/sites-enabled/acme.conf', text: 'ServerName acme.com\n' }

    it('writes the new file and disables the old one in a single request', async () => {
        const { deps, sent, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0]!.action, 'adopt')
        assert.deepEqual(sent[0]!.disable, [handWritten.path])
        assert.match(sent[0]!.write?.text ?? '', /Generated by hostd/)
    })

    it('refuses a file that is not currently claiming one of this environment\'s hostnames', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', ['/etc/apache2/sites-enabled/other.conf'])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /does not serve/)
    })

    it('refuses to adopt a file it could not fully read', async () => {
        const { deps, project, environment } = setup()
        deps.listSitesEnabled = async () => [{ path: handWritten.path, text: 'ServerName acme.com\nUse CommonSite acme' }]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /cannot be read/)
    })

    it('reverts when the configtest fails, so the old file comes back', async () => {
        const { deps, sent, project, environment } = setup({ railOk: false })
        deps.listSitesEnabled = async () => [handWritten]
        const result = await adopt(deps, project, environment, 'abc123', [handWritten.path])
        assert.equal(result.ok, false)
        assert.equal(sent.length, 2)
    })
})
```

Add `previewAdopt` and `adopt` to the file's import from `./domains.ts`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/domains.test.ts`
Expected: FAIL, `previewAdopt is not exported`.

- [ ] **Step 3: Write the implementation**

Add to `hostd/src/agent/domains.ts`:

```ts
import { findClaims } from './sites-enabled.ts'

export type AdoptPreview = {
    ok: true
    preview: {
        proposed: string
        claims: { path: string, names: string[], unsupported: string | null }[]
        extraNames: string[]
        adoptable: boolean
    }
}

// Reading only. Nothing here moves a file or reloads anything: an operator has to see what they are
// replacing before any of it happens, and that is the whole reason adoption is two calls.
export async function previewAdopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
): Promise<AdoptPreview | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is nothing to adopt`)
    }
    const hostnames = hostnamesOf(environment)
    const claims = findClaims(await deps.listSitesEnabled(), hostnames)
    // Names the old file serves that the registry has never heard of. Offered rather than taken: adopting
    // without carrying these across would silently stop serving hostnames that work today, and adding
    // them automatically would put hostnames in the registry nobody asked for.
    const extraNames = [...new Set(claims.flatMap(claim => claim.names))].filter(name => !hostnames.includes(name))
    return {
        ok: true,
        preview: {
            proposed: render(deps, project, environment, token),
            claims,
            extraNames,
            adoptable: claims.every(claim => claim.unsupported === null),
        },
    }
}

export async function adopt(
    deps: DomainsDeps,
    project: ProjectEntry,
    environment: EnvironmentEntry,
    token: string,
    disable: string[],
): Promise<DomainsWritten | Refusal> {
    if (environment.domain === null) {
        return refuse('bad-request', `${project.id} ${environment.name} has no domain, so there is nothing to adopt`)
    }
    const hostnames = hostnamesOf(environment)
    const claims = findClaims(await deps.listSitesEnabled(), hostnames)

    // Every named file has to be one this environment's hostnames actually reach. api chose these from a
    // preview, and the preview could be minutes old, so the claim is re-established here against the
    // files as they are now rather than trusted from the request.
    for (const path of disable) {
        const claim = claims.find(entry => entry.path === path)
        if (!claim) return refuse('bad-request', `${path} does not serve any hostname of ${project.id} ${environment.name}`)
        if (claim.unsupported) return refuse('bad-request', `${path} cannot be read well enough to adopt: ${claim.unsupported}`)
    }

    const path = vhostPath(deps.config.includeDir, project.id, environment.name)
    const previous = await deps.readFile(path)
    const text = render(deps, project, environment, token)

    // One request, so the new file arrives and the old one leaves before the single configtest. Two
    // requests would mean a moment with both files loaded, where Apache picks one by file order, or a
    // moment with neither.
    const result = await deps.rail.send('adopt', { write: { path, text }, remove: [], disable })
    if (!result.ok) {
        const also = await revert(deps, path, previous)
        return refuse('failed', `Apache refused the configuration adopting ${project.id} ${environment.name}.${also}`, result.output)
    }
    return { ok: true, written: { hostnames, path } }
}
```

The host unit's `adopt` action moves the disabled files back by itself when its configtest fails, so `revert` here is only undoing hostd's own file. That division is what the runbook documents in Task 15.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npx tsx --test src/agent/domains.test.ts`
Expected: PASS, all cases from Tasks 8 and 9.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/agent/domains.ts hostd/src/agent/domains.test.ts
git commit -m "Preview and perform an adoption, in one reload"
```

---

### Task 10: Wiring the verb into the agent

**Files:**
- Modify: `hostd/src/agent/agent.ts`, `hostd/src/agent/agent.test.ts`
- Modify: `hostd/src/agent/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 6 to 9
- Produces: `Agent` gains `domains(request: DomainsRequest): Promise<DomainsWritten | AdoptPreview | Refusal>`, routed by `handleConnection`

- [ ] **Step 1: Write the failing test**

Add to `hostd/src/agent/agent.test.ts`, following the file's existing `setup()` factory:

```ts
describe('the domains verb', () => {
    it('refuses a project without the domains capability, before touching the rail', async () => {
        const { agent, sent } = setup({ capabilities: '[lifecycle]' })
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(result.ok, false)
        assert.equal(result.ok === false && result.code, 'capability-disabled')
        assert.equal(sent.length, 0)
    })

    it('refuses an unknown project', async () => {
        const { agent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'nobody', args: { action: 'remove', environment: 'live' } })
        assert.equal(result.ok === false && result.code, 'unknown-project')
    })

    it('refuses an environment the project does not have', async () => {
        const { agent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'remove', environment: 'test' } })
        assert.equal(result.ok === false && result.code, 'unknown-environment')
    })

    it('re-reads the registry rather than trusting what api sent', async () => {
        const { agent, reload } = setup()
        await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(reload.calls, 1)
    })

    it('writes the vhost for a project that has the capability', async () => {
        const { agent, sent } = setup()
        const result = await agent.domains({ verb: 'domains', project: 'acme', args: { action: 'write', environment: 'live', token: 'abc123' } })
        assert.equal(result.ok, true)
        assert.equal(sent[0]!.write?.path, '/etc/apache2/hostd/acme-live.conf')
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/agent/agent.test.ts`
Expected: FAIL, `agent.domains is not a function`.

- [ ] **Step 3: Write the implementation**

In `hostd/src/agent/agent.ts`, add a `domains` method following the shape of the existing `env` and `deploy` methods: reload the registry, run `checkStructure` for the project, check the `domains` capability, look the environment up and return `unknown-environment` when it is absent, then dispatch on `args.action` to `writeVhost`, `removeVhost`, `previewAdopt` or `adopt`.

In `hostd/src/agent/server.ts`, add the `domains` case to the verb switch, parsing with `parseDomainsArgs` exactly as the `env` and `deploy` cases parse theirs.

In `hostd/src/agent/index.ts`, read the new configuration and build the rail:

```ts
const APACHE_RAIL_DIR = process.env.HOSTD_APACHE_RAIL_DIR ?? '/etc/hostd/apache'
const APACHE_INCLUDE_DIR = process.env.HOSTD_APACHE_INCLUDE_DIR ?? '/etc/apache2/hostd'
const APACHE_SITES_ENABLED = process.env.HOSTD_APACHE_SITES_ENABLED ?? '/etc/apache2/sites-enabled'
const ORIGIN_CERT = process.env.HOSTD_ORIGIN_CERT ?? ''
const ORIGIN_KEY = process.env.HOSTD_ORIGIN_KEY ?? ''
const ACME_WEBROOT = process.env.HOSTD_ACME_WEBROOT ?? '/var/www/hostd-acme'
const MAINTENANCE_ROOT = process.env.HOSTD_MAINTENANCE_ROOT ?? '/var/www/hostd-maintenance'
```

Add to the boot gate in `main()`, beside the existing `/var/www` check:

```ts
    // A vhost that names a certificate file which is not there fails Apache's configtest, so every
    // domain action would fail at the last step with an error about SSL rather than about configuration.
    // Better to refuse to start and say which file.
    for (const [name, path] of [['HOSTD_ORIGIN_CERT', ORIGIN_CERT], ['HOSTD_ORIGIN_KEY', ORIGIN_KEY]]) {
        if (!path) {
            failures.push(`${name} is not set, and the domains capability needs it`)
            continue
        }
        try {
            if (!(await stat(path)).isFile()) failures.push(`${name} (${path}) is not a file`)
        } catch {
            failures.push(`${name} (${path}) does not exist`)
        }
    }
```

Build the `DomainsDeps` from `node:fs/promises` and pass them into the `Agent` constructor alongside the existing `ProvisionDeps` and `DeployDeps`. `readFile` returns `null` on `ENOENT` rather than throwing, and `listSitesEnabled` reads every `.conf` in `APACHE_SITES_ENABLED`.

**The two maintenance paths are not the same path.** `index.ts` already has `MAINTENANCE_DIR`, read from `HOSTD_MAINTENANCE_DIR`, which is `/run/hostd/maintenance`: the flag files the deploy work writes. `MAINTENANCE_ROOT` above is the new one, `/var/www/hostd-maintenance`: the holding page Apache serves. Build the config with both, the right way round:

```ts
        maintenanceFlagDir: MAINTENANCE_DIR,
        maintenancePageDir: MAINTENANCE_ROOT,
```

Getting these the wrong way round makes every vhost test a flag path that never exists, so the holding page never appears during a deploy, and nothing fails loudly enough to notice.

**Report the rail's age in health, so a dead host unit is visible before somebody tries a domain action.** `Agent`'s deps gain `railAge: () => number | null`, wired in `index.ts` to `rail.lastSuccessAt()`, and `HealthReply` in `src/shared/protocol.ts` gains `railAge: number | null` which `Agent.health()` fills from it. Task 14 reads it off the health reply `api` already fetches. Without this there is no path from `ApacheRail.lastSuccessAt()` (inside the agent) to `api`, which is the only process that serves `/health`.

Add one test for it beside the others:

```ts
    it('reports the rail\'s last answer in health, so a dead host unit is visible', async () => {
        const { agent } = setup()
        const health = await agent.handle({ verb: 'health' })
        assert.ok('railAge' in health)
    })
```

- [ ] **Step 4: Run the whole agent suite**

Run: `cd hostd && npx tsx --test "src/agent/*.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck && npm test
git add hostd/src/agent/
git commit -m "Route the domains verb through the agent"
```

---

### Task 11: Domain state in api

**Files:**
- Create: `hostd/src/api/domain-state.ts`, `hostd/src/api/domain-state.test.ts`

**Interfaces:**
- Produces:
  - `export const DOMAIN_STATES = ['unmanaged', 'pending', 'active', 'failed', 'broken'] as const`; `export type DomainState = typeof DOMAIN_STATES[number]`
  - `export type DomainRecord = { project: string, environment: EnvironmentName, hostname: string, primary: boolean, state: DomainState, token: string | null, checkedAt: string | null, attempts: number, firstSeenAt: string, error: string | null, vhost: { ok: boolean, output: string } | null }`
  - `export function domainKey(project: string, environment: EnvironmentName, hostname: string): string`
  - `export function newRecord(project, environment, hostname, primary, now): DomainRecord`
  - `export class DomainStore` with `load()`, `get(key)`, `forEnvironment(project, environment)`, `all()`, `put(record)`, `remove(key)`, `reconcile(registry, now)`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/domain-state.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import { DomainStore, domainKey, newRecord, type DomainRecord } from './domain-state.ts'

const NOW = '2026-09-21T00:00:00.000Z'

function store() {
    const files = new Map<string, string>()
    const fs = {
        async readFile(path: string) {
            const text = files.get(path)
            if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return text
        },
        async writeFile(path: string, text: string) { files.set(path, text) },
        async rename(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from) },
        async mkdir() {},
    }
    return { store: new DomainStore('/state/domains.json', fs), files }
}

const REGISTRY = `
projects:
  acme:
    client: cl_1
    name: Acme
    capabilities: [domains]
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com, aliases: [www.acme.com] }
`

describe('DomainStore', () => {
    it('starts empty when there is no file yet', async () => {
        const { store: s } = store()
        await s.load()
        assert.deepEqual(s.all(), [])
    })

    it('keeps a record across a reload, which is what makes a restart resume', async () => {
        const { store: s, files } = store()
        await s.load()
        await s.put({ ...newRecord('acme', 'live', 'acme.com', true, NOW), state: 'active', attempts: 4 })
        const second = new DomainStore('/state/domains.json', {
            async readFile(path: string) { return files.get(path)! },
            async writeFile() {}, async rename() {}, async mkdir() {},
        })
        await second.load()
        assert.equal(second.get(domainKey('acme', 'live', 'acme.com'))?.state, 'active')
        assert.equal(second.get(domainKey('acme', 'live', 'acme.com'))?.attempts, 4)
    })

    it('writes by rename, so a crash mid-write cannot leave a half file', async () => {
        const { store: s, files } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'acme.com', true, NOW))
        assert.equal(files.has('/state/domains.json'), true)
        assert.equal([...files.keys()].some(key => key.endsWith('.tmp')), false)
    })

    it('returns one environment\'s records with the primary first', async () => {
        const { store: s } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'www.acme.com', false, NOW))
        await s.put(newRecord('acme', 'live', 'acme.com', true, NOW))
        assert.deepEqual(s.forEnvironment('acme', 'live').map(r => r.hostname), ['acme.com', 'www.acme.com'])
    })
})

describe('reconcile', () => {
    it('creates an unmanaged record for a hostname the registry has and the store does not', async () => {
        const { store: s } = store()
        await s.load()
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        const record = s.get(domainKey('acme', 'live', 'acme.com'))
        assert.equal(record?.state, 'unmanaged')
        assert.equal(record?.primary, true)
    })

    it('leaves an existing record\'s state alone, so a reload never restarts verification', async () => {
        const { store: s } = store()
        await s.load()
        await s.put({ ...newRecord('acme', 'live', 'acme.com', true, NOW), state: 'active', attempts: 9 })
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        assert.equal(s.get(domainKey('acme', 'live', 'acme.com'))?.state, 'active')
        assert.equal(s.get(domainKey('acme', 'live', 'acme.com'))?.attempts, 9)
    })

    it('drops a record for a hostname the registry no longer names', async () => {
        const { store: s } = store()
        await s.load()
        await s.put(newRecord('acme', 'live', 'gone.acme.com', false, NOW))
        await s.reconcile(parseRegistry(REGISTRY), NOW)
        assert.equal(s.get(domainKey('acme', 'live', 'gone.acme.com')), undefined)
    })

    it('ignores a project without the domains capability', async () => {
        const { store: s } = store()
        await s.load()
        await s.reconcile(parseRegistry(REGISTRY.replace('[domains]', '[lifecycle]')), NOW)
        assert.deepEqual(s.all(), [])
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/api/domain-state.test.ts`
Expected: FAIL, `Cannot find module './domain-state.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/api/domain-state.ts`:

```ts
// What api knows about each hostname, which is everything the registry does not: whether it has been
// proved to reach this site, when that was last checked, and what went wrong if it did not.
//
// It lives here rather than in the registry because it changes every minute and the registry is
// hand-edited and polled every ten seconds. Writing verification state into a file the operator has open
// in an editor would lose one or the other.

import { dirname } from 'node:path'
import { hostnamesOf, type EnvironmentName, type Registry } from '../shared/registry.ts'

export const DOMAIN_STATES = ['unmanaged', 'pending', 'active', 'failed', 'broken'] as const
export type DomainState = typeof DOMAIN_STATES[number]

export type DomainRecord = {
    project: string
    environment: EnvironmentName
    hostname: string
    primary: boolean
    state: DomainState
    token: string | null
    checkedAt: string | null
    attempts: number
    firstSeenAt: string
    error: string | null
    vhost: { ok: boolean, output: string } | null
}

export type DomainStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

export function domainKey(project: string, environment: EnvironmentName, hostname: string): string {
    return `${project}:${environment}:${hostname}`
}

export function newRecord(
    project: string,
    environment: EnvironmentName,
    hostname: string,
    primary: boolean,
    now: string,
): DomainRecord {
    // unmanaged, not pending: a record exists the moment the registry names a hostname, and at that
    // point hostd has written no vhost for it and proved nothing about it. Starting it pending would
    // put every one of the five existing sites into a 72 hour countdown it was never going to win.
    return {
        project, environment, hostname, primary,
        state: 'unmanaged', token: null, checkedAt: null, attempts: 0,
        firstSeenAt: now, error: null, vhost: null,
    }
}

export class DomainStore {
    private records = new Map<string, DomainRecord>()

    constructor(private readonly path: string, private readonly fs: DomainStateFs) {}

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await this.fs.readFile(this.path)) as DomainRecord[]
            this.records = new Map(parsed.map(record => [domainKey(record.project, record.environment, record.hostname), record]))
        } catch {
            // No file yet, or one that will not parse. Either way there is nothing to resume from, and
            // reconcile is about to rebuild an unmanaged record for every hostname the registry names.
            this.records = new Map()
        }
    }

    get(key: string): DomainRecord | undefined {
        return this.records.get(key)
    }

    all(): DomainRecord[] {
        return [...this.records.values()]
    }

    // The primary first, then by name. Sorted here rather than in the page so the table cannot reorder
    // itself between two renders of the same data.
    forEnvironment(project: string, environment: EnvironmentName): DomainRecord[] {
        return this.all()
            .filter(record => record.project === project && record.environment === environment)
            .sort((a, b) => (Number(b.primary) - Number(a.primary)) || a.hostname.localeCompare(b.hostname))
    }

    async put(record: DomainRecord): Promise<void> {
        this.records.set(domainKey(record.project, record.environment, record.hostname), record)
        await this.write()
    }

    async remove(key: string): Promise<void> {
        if (this.records.delete(key)) await this.write()
    }

    // Brings the store level with the registry: a record for every hostname the registry names, and none
    // for a hostname it no longer does.
    //
    // An existing record is never touched, and that is the whole point. The registry is re-read every ten
    // seconds, so anything this wrote to a live record would be written six times a minute: a pending
    // domain would have its clock reset before it could ever reach 72 hours, and an active one would
    // forget it had been checked.
    async reconcile(registry: Registry, now: string): Promise<void> {
        const wanted = new Map<string, DomainRecord>()
        for (const project of registry.projects.values()) {
            if (!project.capabilities.has('domains')) continue
            for (const environment of project.environments.values()) {
                const hostnames = hostnamesOf(environment)
                for (const hostname of hostnames) {
                    const primary = hostname === environment.domain
                    wanted.set(
                        domainKey(project.id, environment.name, hostname),
                        newRecord(project.id, environment.name, hostname, primary, now),
                    )
                }
            }
        }

        let changed = false
        for (const [key, fresh] of wanted) {
            if (this.records.has(key)) continue
            this.records.set(key, fresh)
            changed = true
        }
        for (const key of [...this.records.keys()]) {
            if (wanted.has(key)) continue
            this.records.delete(key)
            changed = true
        }
        if (changed) await this.write()
    }

    // Written whole and renamed into place: a torn file here would lose every domain's verification
    // state at once, and the whole file is a few kilobytes.
    private async write(): Promise<void> {
        await this.fs.mkdir(dirname(this.path), { recursive: true })
        const staging = `${this.path}.tmp`
        await this.fs.writeFile(staging, JSON.stringify(this.all(), null, 2))
        await this.fs.rename(staging, this.path)
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/api/domain-state.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/api/domain-state.ts hostd/src/api/domain-state.test.ts
git commit -m "Keep domain state in api, reconciled against the registry"
```

---

### Task 12: Verification, and what a failure means

**Files:**
- Create: `hostd/src/api/verify.ts`, `hostd/src/api/verify.test.ts`

**Interfaces:**
- Produces:
  - `export const VERIFY_TIMEOUT_MS = 10_000`, `export const TOKEN_HEADER = 'x-hostd-token'`
  - `export type VerifyOutcome = { ok: true } | { ok: false, reason: string, client: string }`
  - `export function newToken(): string`
  - `export function translateFailure(error: unknown, proxied: boolean): { reason: string, client: string }`
  - `export async function verifyHostname(fetchImpl: typeof fetch, hostname: string, token: string, scheme: 'http' | 'https', proxied: boolean): Promise<VerifyOutcome>`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/verify.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { verifyHostname, translateFailure, newToken, TOKEN_HEADER } from './verify.ts'

const answering = (status: number, token: string | null): typeof fetch =>
    (async () => new Response(null, {
        status,
        headers: token === null ? {} : { [TOKEN_HEADER]: token },
    })) as unknown as typeof fetch

const throwing = (error: unknown): typeof fetch => (async () => { throw error }) as unknown as typeof fetch

describe('newToken', () => {
    it('is lowercase hex, and long enough not to be guessed', () => {
        assert.match(newToken(), /^[0-9a-f]{32}$/)
    })

    it('is different every time', () => {
        assert.notEqual(newToken(), newToken())
    })
})

describe('verifyHostname', () => {
    it('passes when the token comes back in the header', async () => {
        const result = await verifyHostname(answering(204, 'abc123'), 'acme.com', 'abc123', 'https', true)
        assert.deepEqual(result, { ok: true })
    })

    it('fails when the header carries a different token, which means the name points elsewhere', async () => {
        const result = await verifyHostname(answering(204, 'someone-else'), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.client : '', /points somewhere else/)
    })

    it('fails when there is no header at all', async () => {
        const result = await verifyHostname(answering(200, null), 'acme.com', 'abc123', 'https', true)
        assert.equal(result.ok, false)
    })

    it('asks for the token path on the scheme it was given', async () => {
        const seen: string[] = []
        const recording = (async (url: string) => {
            seen.push(url)
            return new Response(null, { status: 204, headers: { [TOKEN_HEADER]: 'abc123' } })
        }) as unknown as typeof fetch
        await verifyHostname(recording, 'acme.com', 'abc123', 'http', false)
        assert.equal(seen[0], 'http://acme.com/.well-known/hostd/abc123')
    })

    it('never follows a redirect, because a redirect proves nothing about this vhost', async () => {
        const seen: RequestInit[] = []
        const recording = (async (_url: string, init: RequestInit) => {
            seen.push(init)
            return new Response(null, { status: 204, headers: { [TOKEN_HEADER]: 'abc123' } })
        }) as unknown as typeof fetch
        await verifyHostname(recording, 'acme.com', 'abc123', 'https', true)
        assert.equal(seen[0]!.redirect, 'manual')
    })
})

describe('translateFailure', () => {
    it('reads a DNS failure as no record yet', () => {
        const { client } = translateFailure(Object.assign(new Error('getaddrinfo ENOTFOUND acme.com'), { code: 'ENOTFOUND' }), true)
        assert.match(client, /No record exists yet/)
    })

    it('reads a TLS failure on a proxied domain as a proxy that is switched off', () => {
        const { client } = translateFailure(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), true)
        assert.match(client, /not proxied/)
    })

    it('never tells an unproxied domain to turn a proxy on', () => {
        const { client } = translateFailure(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), false)
        assert.doesNotMatch(client, /proxied/)
    })

    it('keeps the raw error as the reason, for the operator, and never puts it in the client line', () => {
        const { reason, client } = translateFailure(new Error('connect ECONNREFUSED 10.0.0.1:443'), true)
        assert.match(reason, /ECONNREFUSED/)
        assert.doesNotMatch(client, /10\.0\.0\.1/)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/api/verify.test.ts`
Expected: FAIL, `Cannot find module './verify.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/api/verify.ts`. The points the tests pin down:

- `newToken` is `randomBytes(16).toString('hex')`, which matches the `DOMAIN_TOKEN` pattern Task 7 enforces.
- `verifyHostname` fetches `${scheme}://${hostname}/.well-known/hostd/${token}` with `redirect: 'manual'`, an `AbortSignal.timeout(VERIFY_TIMEOUT_MS)`, and `cache: 'no-store'`, then compares the `x-hostd-token` header against the token.
- Certificate verification is on because that is Node's default and nothing here turns it off. Write a comment saying so, since the design leans on it and a future reader should not have to infer it from an absence.
- `translateFailure` maps DNS codes (`ENOTFOUND`, `EAI_AGAIN`) to the no-record sentence, TLS codes (anything starting `ERR_TLS`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`, `ERR_SSL_*`) to the proxy sentence **only when `proxied` is true**, and everything else to a generic "could not be reached" sentence.
- `reason` is the raw message, for the operator and the audit log. `client` is one of the three sentences and must never contain an address, a port or a stack.

The three client sentences, verbatim:

```ts
const NO_RECORD = 'No record exists yet. Add the CNAME and this will start working within a few minutes.'
const NOT_PROXIED = 'The CNAME is not proxied, so the request reached us directly. Turn the proxy on in Cloudflare.'
const ELSEWHERE = 'This name points somewhere else at the moment.'
const UNREACHABLE = 'We could not reach this name. We are still checking.'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/api/verify.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/api/verify.ts hostd/src/api/verify.test.ts
git commit -m "Verify a hostname, and translate what went wrong into the client's words"
```

---

### Task 13: The verification schedule

**Files:**
- Create: `hostd/src/api/verifier.ts`, `hostd/src/api/verifier.test.ts`

**Interfaces:**
- Consumes: `DomainRecord`, `DomainStore` (Task 11), `verifyHostname`, `translateFailure` (Task 12)
- Produces:
  - `export const FAST_EVERY_MS = 60_000`, `export const SLOW_EVERY_MS = 15 * 60_000`, `export const FAST_FOR_MS = 60 * 60_000`, `export const GIVE_UP_AFTER_MS = 72 * 60 * 60_000`, `export const ACTIVE_EVERY_MS = 24 * 60 * 60_000`
  - `export function nextCheckAt(record: DomainRecord): number | null`
  - `export function dueNow(records: DomainRecord[], now: number): DomainRecord[]`
  - `export function afterCheck(record: DomainRecord, outcome: VerifyOutcome, now: string): DomainRecord`
  - `export class Verifier` with `start()`, `stop()`, `checkNow(key)`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/verifier.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { newRecord, type DomainRecord } from './domain-state.ts'
import { nextCheckAt, dueNow, afterCheck, FAST_EVERY_MS, SLOW_EVERY_MS, ACTIVE_EVERY_MS } from './verifier.ts'

const START = Date.parse('2026-09-21T00:00:00.000Z')
const at = (ms: number) => new Date(ms).toISOString()

const pending = (over: Partial<DomainRecord> = {}): DomainRecord => ({
    ...newRecord('acme', 'live', 'acme.com', true, at(START)),
    state: 'pending',
    token: 'abc123',
    ...over,
})

describe('nextCheckAt', () => {
    it('never schedules an unmanaged record, because nothing is serving it yet', () => {
        assert.equal(nextCheckAt(pending({ state: 'unmanaged' })), null)
    })

    it('checks a pending record every minute for the first hour', () => {
        const record = pending({ checkedAt: at(START + 10 * 60_000) })
        assert.equal(nextCheckAt(record), START + 10 * 60_000 + FAST_EVERY_MS)
    })

    it('slows to every fifteen minutes after the first hour', () => {
        const record = pending({ checkedAt: at(START + 2 * 60 * 60_000) })
        assert.equal(nextCheckAt(record), START + 2 * 60 * 60_000 + SLOW_EVERY_MS)
    })

    it('checks an active record once a day', () => {
        const record = pending({ state: 'active', checkedAt: at(START + 5_000) })
        assert.equal(nextCheckAt(record), START + 5_000 + ACTIVE_EVERY_MS)
    })

    it('stops scheduling a failed record, which only a manual retry revives', () => {
        assert.equal(nextCheckAt(pending({ state: 'failed', checkedAt: at(START) })), null)
    })

    it('keeps checking a broken record, because a site that came back should say so by itself', () => {
        assert.notEqual(nextCheckAt(pending({ state: 'broken', checkedAt: at(START) })), null)
    })

    it('is due immediately when it has never been checked', () => {
        assert.equal(nextCheckAt(pending({ checkedAt: null })), Date.parse(pending().firstSeenAt))
    })
})

describe('dueNow', () => {
    it('returns only the records whose time has come', () => {
        const soon = pending({ hostname: 'soon.acme.com', checkedAt: at(START) })
        const later = pending({ hostname: 'later.acme.com', state: 'active', checkedAt: at(START) })
        const due = dueNow([soon, later], START + FAST_EVERY_MS + 1)
        assert.deepEqual(due.map(record => record.hostname), ['soon.acme.com'])
    })
})

describe('afterCheck', () => {
    it('turns a pending record active when the check passes', () => {
        const record = afterCheck(pending(), { ok: true }, at(START))
        assert.equal(record.state, 'active')
        assert.equal(record.error, null)
        assert.equal(record.attempts, 0)
    })

    it('counts an attempt and keeps a young record pending', () => {
        const record = afterCheck(pending(), { ok: false, reason: 'ENOTFOUND', client: 'No record exists yet.' }, at(START + 60_000))
        assert.equal(record.state, 'pending')
        assert.equal(record.attempts, 1)
        assert.match(record.error ?? '', /No record exists yet/)
    })

    it('gives up after 72 hours', () => {
        const record = afterCheck(pending(), { ok: false, reason: 'ENOTFOUND', client: 'x' }, at(START + 73 * 60 * 60_000))
        assert.equal(record.state, 'failed')
    })

    it('turns an active record broken rather than pending, so the vhost is never pulled', () => {
        const record = afterCheck(pending({ state: 'active' }), { ok: false, reason: 'x', client: 'y' }, at(START + 1000))
        assert.equal(record.state, 'broken')
    })

    it('turns a broken record active again the moment it answers', () => {
        const record = afterCheck(pending({ state: 'broken' }), { ok: true }, at(START + 1000))
        assert.equal(record.state, 'active')
    })

    it('never gives up on a broken record, however long it has been broken', () => {
        const record = afterCheck(pending({ state: 'broken' }), { ok: false, reason: 'x', client: 'y' }, at(START + 500 * 60 * 60_000))
        assert.equal(record.state, 'broken')
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd hostd && npx tsx --test src/api/verifier.test.ts`
Expected: FAIL, `Cannot find module './verifier.ts'`.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/api/verifier.ts`. `nextCheckAt` derives the next time from `checkedAt` and `firstSeenAt` and nothing else, so a restart resumes rather than restarting. `Verifier` is one interval (every 30 seconds) that calls `dueNow` over the store, verifies each due record and writes the result back, with `checkNow` forcing one record and resetting `failed` to `pending` first so a manual retry has something to schedule.

Write the comment above the class explaining why this is an interval over disk state rather than a timer per record: `api` restarts, and a timer per record would begin the 72 hours again on every restart, which is exactly the situation a client is in when they are waiting for DNS.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hostd && npx tsx --test src/api/verifier.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck
git add hostd/src/api/verifier.ts hostd/src/api/verifier.test.ts
git commit -m "Schedule verification from state on disk, so a restart resumes"
```

---

### Task 14: The endpoints, the policy and the health warnings

**Files:**
- Modify: `hostd/src/api/policy.ts`, `hostd/src/api/policy.test.ts`
- Modify: `hostd/src/api/routes.ts`, `hostd/src/api/routes.test.ts`
- Modify: `hostd/src/api/index.ts`

**Interfaces:**
- Consumes: Tasks 7, 11, 12, 13
- Produces:
  - `PolicyVerb` gains `'domains' | 'domains-read'`; `POLICY_CAPABILITY` maps both to `'domains'`; `ADMIN_ONLY` gains `'domains'`
  - `matchRoute` returns `{ verb: 'domains-list' | 'domain-add' | 'domain-remove' | 'domain-verify' | 'adopt-preview' | 'adopt', ... }`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/api/policy.test.ts`:

```ts
describe('the domains verbs', () => {
    it('lets a client read their own site\'s domains', () => {
        const decision = authorize(registry, { kind: 'client', client: 'cl_1' }, 'acme', 'domains-read')
        assert.equal(decision.ok, true)
    })

    it('answers a client asking to add a domain exactly as it answers one asking about a stranger\'s site', () => {
        const mine = authorize(registry, { kind: 'client', client: 'cl_1' }, 'acme', 'domains')
        const theirs = authorize(registry, { kind: 'client', client: 'cl_1' }, 'someone-else', 'domains')
        assert.equal(mine.ok, false)
        assert.equal(mine.ok === false && mine.status, 404)
        assert.equal(theirs.ok === false && theirs.status, 404)
    })

    it('refuses both verbs when the project has no domains capability', () => {
        const decision = authorize(withoutDomains, { kind: 'admin' }, 'acme', 'domains-read')
        assert.equal(decision.ok === false && decision.code, 'capability-disabled')
    })
})
```

Add to `hostd/src/api/routes.test.ts`:

```ts
describe('domain routes', () => {
    it('matches the six endpoints', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/domains'), { verb: 'domains-list', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/domains'), { verb: 'domain-add', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/domains/www.acme.com'), { verb: 'domain-remove', project: 'acme', environment: 'live', hostname: 'www.acme.com' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/domains/www.acme.com/verify'), { verb: 'domain-verify', project: 'acme', environment: 'live', hostname: 'www.acme.com' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/adopt'), { verb: 'adopt-preview', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/adopt'), { verb: 'adopt', project: 'acme', environment: 'live' })
    })

    it('refuses the wrong method on each of them', () => {
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/domains'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/adopt'), { verb: 'method-not-allowed' })
    })

    it('does not match an environment that does not exist', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/staging/domains'), { verb: 'not-found' })
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/api/policy.test.ts src/api/routes.test.ts`
Expected: FAIL on both files.

- [ ] **Step 3: Write the implementation**

In `policy.ts`, add both verbs to `PolicyVerb`, map both to the `domains` capability in `POLICY_CAPABILITY`, and add `'domains'` (not `'domains-read'`) to `ADMIN_ONLY`. Extend the comment above `PolicyVerb` to name the new split alongside the deploy one.

In `routes.ts`, extend `matchRoute`'s environment branch with the new paths, and add the handlers:

| Route | What it does |
| --- | --- |
| `domains-list` | `store.forEnvironment(...)`, joining the environment's `certificate` mode onto each record (it lives in the registry, not in domain state, so there is one copy of it), with `vhost.output` omitted for a client |
| `domain-add` | Read the environment's current aliases, append the new hostname, call the agent's `domains set-aliases` with the whole resulting list and the primary's token (Task 8 writes the registry and rewrites the vhost in that one call), then record the new hostname `pending` |
| `domain-remove` | Refuse the primary, then `domains set-aliases` with the list minus that hostname, and drop its record |
| `domain-verify` | `verifier.checkNow(key)` and answer the fresh record |
| `adopt-preview` | Call the agent's `domains preview` and pass it through |
| `adopt` | Check `confirm` equals the project name, then the agent's `domains adopt`, then record each hostname `pending` |

Every one of them is audited exactly as the existing routes are, with `target` set to the hostname.

In the `/health` handler, add the four warnings:

```ts
    for (const record of domains.all()) {
        if (record.state === 'broken') warnings.push(`${record.hostname} stopped answering (${record.project} ${record.environment})`)
        if (record.vhost && !record.vhost.ok) warnings.push(`the vhost for ${record.project} ${record.environment} was rolled back`)
    }
    // An environment set to letsencrypt is serving the Origin certificate until 4b lands. Said once,
    // naming the environments, rather than once per hostname.
    const waiting = environmentsAwaitingCertbot(registry)
    if (waiting.length) warnings.push(`waiting for Let's Encrypt support: ${waiting.join(', ')}`)
    // The rail not answering means no domain action can work at all, and every one of them will look
    // like a hang rather than a failure until somebody tries one. railAge comes off the agent's health
    // reply (Task 10), because lastSuccessAt lives in the agent and only api serves /health.
    if (reply.railAge === null || reply.railAge > RAIL_STALE_MS) {
        warnings.push('the Apache host unit has not answered; no domain change can take effect')
    }
```

Both helpers this uses are defined here, not assumed:

```ts
// Ten minutes. Long enough that an idle hostd with nothing to change is not perpetually unhealthy, short
// enough that a unit which died this morning is named before the day's first domain action hangs on it.
const RAIL_STALE_MS = 10 * 60_000

// Named once, listing the environments, rather than once per hostname: a site with three aliases would
// otherwise produce three copies of the same sentence about the same certificate.
function environmentsAwaitingCertbot(registry: Registry): string[] {
    const waiting: string[] = []
    for (const project of registry.projects.values()) {
        if (!project.capabilities.has('domains')) continue
        for (const environment of project.environments.values()) {
            if (environment.certificate === 'letsencrypt') waiting.push(`${project.id} ${environment.name}`)
        }
    }
    return waiting
}
```

- [ ] **Step 4: Run the whole api suite**

Run: `cd hostd && npx tsx --test "src/api/*.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd hostd && npm run typecheck && npm test
git add hostd/src/api/
git commit -m "Serve the domain endpoints, and warn about what only health can see"
```

---

### Task 15: The host units and the runbook

**Files:**
- Create: `hostd/host/hostd-apache.sh`, `hostd/host/hostd-apache.path`, `hostd/host/hostd-apache.service`, `hostd/host/apache-include.conf`
- Modify: `hostd/RUNBOOK.md`

**Interfaces:**
- Consumes: the request and result shapes from Task 3
- Produces: nothing importable. This is the half of the rail that does not run in Docker.

- [ ] **Step 1: Write the host script**

Create `hostd/host/hostd-apache.sh`:

```sh
#!/bin/sh
# hostd's Apache rail. It is started by hostd-apache.path when the agent writes a request, and it does
# four things: perform the writes it was handed, run a configtest, reload Apache if the test passed, and
# write a result carrying the request's sequence number.
#
# It validates nothing. Every path and every byte in the request was validated by the agent, which is the
# process with the registry, the hostname rules and the template. Adding checks here would mean two
# places that must agree about what is legal, and this is the one that cannot be tested in CI.
set -eu

DIR="${HOSTD_APACHE_RAIL_DIR:-/etc/hostd/apache}"
REQUEST="$DIR/request.json"
RESULT="$DIR/result.json"
ADOPTED="${HOSTD_APACHE_ADOPTED_DIR:-/etc/apache2/hostd-adopted}"

[ -f "$REQUEST" ] || exit 0

SEQ=$(jq -r '.seq' "$REQUEST")
ACTION=$(jq -r '.action' "$REQUEST")

# Everything moved or written in this run, so a failed configtest can be undone completely. A disabled
# file is moved, never deleted: undoing an adoption has to be possible by hand, months later.
MOVED=""

restore() {
    for pair in $MOVED; do
        from=$(echo "$pair" | cut -d'|' -f1)
        to=$(echo "$pair" | cut -d'|' -f2)
        mv "$to" "$from" 2>/dev/null || true
    done
}

finish() {
    printf '{"seq":%s,"ok":%s,"output":%s}\n' "$SEQ" "$1" "$(printf '%s' "$2" | jq -Rs .)" > "$RESULT.tmp"
    mv "$RESULT.tmp" "$RESULT"
    rm -f "$REQUEST"
    exit 0
}

# Removals first, then the disables, then the write. All before the single configtest, which is what
# makes an adoption one reload rather than two.
for path in $(jq -r '.remove[]?' "$REQUEST"); do
    rm -f "$path"
done

if [ "$ACTION" = "adopt" ]; then
    mkdir -p "$ADOPTED"
    for path in $(jq -r '.disable[]?' "$REQUEST"); do
        target="$ADOPTED/$(basename "$path").bak"
        mv "$path" "$target"
        MOVED="$MOVED $path|$target"
    done
fi

if [ "$(jq -r '.write // "null"' "$REQUEST")" != "null" ]; then
    WRITE_PATH=$(jq -r '.write.path' "$REQUEST")
    jq -r '.write.text' "$REQUEST" > "$WRITE_PATH.tmp"
    mv "$WRITE_PATH.tmp" "$WRITE_PATH"
fi

if OUTPUT=$(apache2ctl configtest 2>&1); then
    if RELOAD=$(systemctl reload apache2 2>&1); then
        finish true "$OUTPUT"
    fi
    # The test passed and the reload did not, which is a machine problem rather than a configuration
    # one. Nothing is undone: the files are valid, and Apache is still serving the previous version.
    finish false "configtest passed but the reload failed: $RELOAD"
fi

# The configtest failed, so nothing has reloaded and Apache is still serving what it was. The disabled
# files go back immediately, because a site with no vhost at all is the one outcome worse than the one
# this was trying to replace. The file hostd wrote is left for the agent to revert, which is what knows
# what was there before.
restore
finish false "$OUTPUT"
```

- [ ] **Step 2: Write the systemd units and the Apache include**

Create `hostd/host/hostd-apache.path`:

```ini
[Unit]
Description=Watch for a hostd Apache request

[Path]
# PathExists rather than PathChanged: the service deletes the request when it is done, which re-arms
# this. PathChanged would fire on the result being written as well.
PathExists=/etc/hostd/apache/request.json

[Install]
WantedBy=multi-user.target
```

Create `hostd/host/hostd-apache.service`:

```ini
[Unit]
Description=Apply a hostd Apache request
After=apache2.service

[Service]
Type=oneshot
# systemd will not run a second copy of a oneshot service while one is running, which is the other half
# of the agent's own lock: two requests can never be applied at once.
ExecStart=/usr/local/sbin/hostd-apache.sh
```

Create `hostd/host/apache-include.conf`:

```apache
# Added to /etc/apache2/apache2.conf. hostd owns every file in this directory and nothing outside it.
# IncludeOptional rather than Include, so an empty directory (a fresh install, or every site adopted
# back by hand) is not a configuration error that stops Apache starting.
IncludeOptional /etc/apache2/hostd/*.conf
```

- [ ] **Step 3: Write the runbook section**

Add a **Domains** section to `hostd/RUNBOOK.md` covering, in order:

1. **Host setup, done once.** Install `jq`. Create `/etc/hostd/apache`, `/etc/apache2/hostd`, `/etc/apache2/hostd-adopted`, `/var/www/hostd-acme/.well-known/acme-challenge` and `/var/www/hostd-maintenance` with a minimal `index.html` (noting that the page's real contents belong to the provisioning design). Copy `hostd-apache.sh` to `/usr/local/sbin/` and `chmod 700`. Copy both units to `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now hostd-apache.path`. Append `apache-include.conf` to `apache2.conf`. `a2enmod headers rewrite proxy proxy_http ssl`. `apache2ctl configtest` and reload.
2. **Checking the rail by hand**, which is the one thing no test covers. Write a request with a harmless write, watch `result.json` appear with the same `seq`, and confirm `request.json` is gone. Then write one whose vhost has a deliberate syntax error and confirm the result says so, that Apache did not reload, and that the agent removed the bad file.
3. **Live verification**, using `test.hostd.horizons.gg` through the registry's `allowed` key, with the exact CNAME to create and the reminder that `allowed` takes exact hostnames and should hold only this one.
4. **Adopting a site**, in the order it must be done: preview in the portal, read the whole existing file, check for rewrites or auth the template has no equivalent for, adopt, confirm the site serves, and confirm verification passes within the minute. Then the undo: move the `.bak` file back out of `/etc/apache2/hostd-adopted/`, remove hostd's file, reload.
5. **Troubleshooting**, as a table matching the file's existing style: the rail warning in `/health` and what it means, a domain stuck `pending` against each of the three client sentences, an adoption refused for an unsupported directive, and a `letsencrypt` environment warning that it is waiting for 4b.

- [ ] **Step 4: Check the script parses and is shellcheck-clean**

Run: `sh -n hostd/host/hostd-apache.sh`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add hostd/host/ hostd/RUNBOOK.md
git commit -m "Add the Apache host rail's systemd units and its runbook"
```

---

### Task 16: The portal's calls

**Files:**
- Create: `server/hostd/domains.ts`, `server/hostd/domains.test.ts`

**Interfaces:**
- Consumes: `hostdRequest`, `HostdResult` from `server/hostd/client.ts`; `Caller` from `server/hostd/actor.ts`; `EnvironmentName` from `server/hostd/env.ts`
- Produces:
  - `export type DomainState = 'unmanaged' | 'pending' | 'active' | 'failed' | 'broken'`
  - `export type Domain = { hostname: string, primary: boolean, state: DomainState, checkedAt: string | null, error: string | null, vhost: { ok: boolean, output: string } | null, certificate: 'cloudflare-origin' | 'letsencrypt' | null }`
    - `certificate` is the environment's mode, joined on by hostd when it answers rather than stored per hostname. In 4a every vhost presents the Origin certificate whatever this says, so the column reads as what the environment is set to, and `letsencrypt` reads as waiting. There is no expiry here until 4b reads one off disk.
  - `export type AdoptPreview = { proposed: string, claims: { path: string, names: string[], unsupported: string | null }[], extraNames: string[], adoptable: boolean }`
  - `export async function listDomains(config, caller, id, environment, fetchImpl?): Promise<HostdResult<Domain[]>>`
  - `export async function addDomain(config, caller, id, environment, hostname, fetchImpl?): Promise<HostdResult<Domain[]>>`
  - `export async function removeDomain(...)`, `export async function verifyDomain(...)`
  - `export async function previewAdopt(...)`, `export async function adoptSite(config, caller, id, environment, confirm, fetchImpl?)`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/domains.test.ts`, following the shape of `server/hostd/deploys.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { listDomains, addDomain, removeDomain, adoptSite } from './domains'

const config = { url: 'http://hostd:8080', token: 'secret' }
const caller = { actor: 'admin' as const, user: 'koda@horizons.gg', clientId: null }

const answering = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('listDomains', () => {
    it('asks the environment\'s own path and unwraps the list', async () => {
        const fetchImpl = answering({ ok: true, domains: [{ hostname: 'acme.com', primary: true, state: 'active' }] })
        const result = await listDomains(config, caller, 'acme', 'live', fetchImpl as unknown as typeof fetch)
        expect(result.ok && result.value[0]?.hostname).toBe('acme.com')
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://hostd:8080/projects/acme/live/domains')
    })

    it('refuses a project id that is not one, without asking hostd', async () => {
        const fetchImpl = answering({})
        const result = await listDomains(config, caller, '../etc', 'live', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})

describe('addDomain', () => {
    it('refuses a hostname that is not one, without asking hostd', async () => {
        const fetchImpl = answering({})
        for (const bad of ['localhost', 'not a host', 'https://acme.com', '']) {
            const result = await addDomain(config, caller, 'acme', 'live', bad, fetchImpl as unknown as typeof fetch)
            expect(result.ok, bad).toBe(false)
        }
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('posts the hostname and returns the new list', async () => {
        const fetchImpl = answering({ ok: true, domains: [{ hostname: 'www.acme.com', primary: false, state: 'pending' }] })
        const result = await addDomain(config, caller, 'acme', 'live', 'www.acme.com', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(true)
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ hostname: 'www.acme.com' })
    })
})

describe('removeDomain', () => {
    it('puts the hostname in the path, encoded', async () => {
        const fetchImpl = answering({ ok: true, domains: [] })
        await removeDomain(config, caller, 'acme', 'live', 'www.acme.com', fetchImpl as unknown as typeof fetch)
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://hostd:8080/projects/acme/live/domains/www.acme.com')
    })
})

describe('adoptSite', () => {
    it('sends the confirmation hostd asks for', async () => {
        const fetchImpl = answering({ ok: true, domains: [] })
        await adoptSite(config, caller, 'acme', 'live', 'Acme Bakery', fetchImpl as unknown as typeof fetch)
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ confirm: 'Acme Bakery' })
    })

    it('carries hostd\'s refusal through rather than inventing one', async () => {
        const fetchImpl = answering({ ok: false, code: 'bad-request', message: 'acme.conf cannot be read well enough to adopt' }, 400)
        const result = await adoptSite(config, caller, 'acme', 'live', 'wrong', fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.message).toMatch(/cannot be read/)
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run server/hostd/domains.test.ts`
Expected: FAIL, cannot resolve `./domains`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/domains.ts` following `server/hostd/deploys.ts` exactly: the same `PROJECT_ID` guard returning `NO_PROJECT` before any request, the same unwrapping of hostd's `ok` flag, the same `fetchImpl` parameter defaulting to `fetch`.

Copy hostd's `HOSTNAME` regex with the comment `deploys.ts` uses for `GIT_REF`, explaining that it is copied so the page can refuse a hostname immediately rather than after a round trip, and that hostd checks it again.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/domains.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/domains.ts server/hostd/domains.test.ts
git commit -m "Call hostd's domain endpoints from the portal"
```

---

### Task 17: What the panel says

**Files:**
- Create: `app/(portal)/portal/sites/[id]/domains.ts`, `app/(portal)/portal/sites/[id]/domains.test.ts`

**Interfaces:**
- Consumes: `Domain`, `DomainState` from `server/hostd/domains.ts`
- Produces:
  - `export function stateWord(state: DomainState): string`
  - `export function stateTone(state: DomainState): 'good' | 'warn' | 'crit' | 'idle'`
  - `export function clientSentence(domain: Domain): string`
  - `export function needsYou(domain: Domain): boolean`
  - `export function sortDomains(domains: Domain[]): Domain[]`

- [ ] **Step 1: Write the failing test**

Create `app/(portal)/portal/sites/[id]/domains.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Domain } from '@/server/hostd/domains'
import { stateWord, stateTone, clientSentence, needsYou, sortDomains } from './domains'

const domain = (over: Partial<Domain> = {}): Domain => ({
    hostname: 'acme.com', primary: true, state: 'active', certificate: 'cloudflare-origin',
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null, ...over,
})

describe('stateWord', () => {
    it('says what each state means in the operator\'s language', () => {
        expect(stateWord('active')).toBe('working')
        expect(stateWord('pending')).toBe('waiting for DNS')
        expect(stateWord('broken')).toBe('stopped answering')
        expect(stateWord('failed')).toBe('gave up')
        expect(stateWord('unmanaged')).toBe('set up by hand')
    })
})

describe('stateTone', () => {
    it('makes a broken domain critical and a pending one merely warm', () => {
        expect(stateTone('broken')).toBe('crit')
        expect(stateTone('pending')).toBe('warn')
        expect(stateTone('active')).toBe('good')
    })

    it('leaves an unmanaged domain neutral, because it is not a fault', () => {
        expect(stateTone('unmanaged')).toBe('idle')
    })
})

describe('clientSentence', () => {
    it('tells a client a working domain is working, without jargon', () => {
        const said = clientSentence(domain())
        expect(said).toMatch(/working/)
        expect(said).not.toMatch(/vhost|Apache|127\.0\.0\.1|proxy pass/i)
    })

    it('passes hostd\'s own explanation through when there is one', () => {
        expect(clientSentence(domain({ state: 'pending', error: 'No record exists yet. Add the CNAME.' })))
            .toMatch(/No record exists yet/)
    })

    it('says something useful about a broken domain even when hostd gave no reason', () => {
        expect(clientSentence(domain({ state: 'broken', error: null }))).toMatch(/looking into it/)
    })

    it('never shows a client a file path, whatever hostd said', () => {
        const said = clientSentence(domain({ state: 'broken', error: '/etc/apache2/sites-enabled/acme.conf is wrong' }))
        expect(said).not.toMatch(/\/etc\//)
    })

    it('says nothing alarming about an unmanaged domain, because nothing is wrong with one', () => {
        expect(clientSentence(domain({ state: 'unmanaged' }))).toMatch(/working/)
    })
})

describe('needsYou', () => {
    it('is true only for the states an operator has to act on', () => {
        expect(needsYou(domain({ state: 'broken' }))).toBe(true)
        expect(needsYou(domain({ state: 'failed' }))).toBe(true)
        expect(needsYou(domain({ state: 'active' }))).toBe(false)
        expect(needsYou(domain({ state: 'pending' }))).toBe(false)
        expect(needsYou(domain({ state: 'unmanaged' }))).toBe(false)
    })

    it('is true when the vhost was rolled back, whatever the domain\'s own state says', () => {
        expect(needsYou(domain({ state: 'active', vhost: { ok: false, output: 'AH00526' } }))).toBe(true)
    })
})

describe('sortDomains', () => {
    it('puts the primary first and then sorts by name, so the table never reorders itself', () => {
        const sorted = sortDomains([
            domain({ hostname: 'www.acme.com', primary: false }),
            domain({ hostname: 'acme.com', primary: true }),
            domain({ hostname: 'shop.acme.com', primary: false }),
        ])
        expect(sorted.map(d => d.hostname)).toEqual(['acme.com', 'shop.acme.com', 'www.acme.com'])
    })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run "app/(portal)/portal/sites/[id]/domains.test.ts"`
Expected: FAIL, cannot resolve `./domains`.

- [ ] **Step 3: Write the implementation**

Create `app/(portal)/portal/sites/[id]/domains.ts`, following `deploys.ts` in the same directory: pure functions, no fetching, a `WORDS` and a `TONES` record keyed by state.

`clientSentence` is the one with real judgement in it. It uses hostd's `error` when there is one, because that string was already written for a client by `translateFailure`, and falls back to a written sentence per state when there is not. It strips anything containing a `/`, so a path that reaches `error` by some future route still never reaches a client's screen. Write that reasoning as the comment above it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(portal)/portal/sites/[id]/domains.test.ts"`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/sites/[id]/domains.ts" "app/(portal)/portal/sites/[id]/domains.test.ts"
git commit -m "Decide what the Domains panel says, apart from rendering it"
```

---

### Task 18: The panel, the tab and the actions

**Files:**
- Create: `app/(portal)/portal/sites/[id]/domainsPanel.tsx`, `app/(portal)/portal/sites/[id]/domainsPanel.test.tsx`
- Create: `app/(portal)/portal/sites/[id]/domainControls.tsx`
- Modify: `app/(portal)/portal/sites/[id]/actions.ts`
- Modify: `app/(portal)/portal/sites/[id]/page.tsx`, `app/(portal)/portal/sites/[id]/page.test.tsx`
- Modify: `app/(portal)/portal/sites/[id]/site.module.css`

**Interfaces:**
- Consumes: Tasks 16 and 17
- Produces: `export function DomainsPanel({ id, environments, environment, domains, isAdmin, projectName, trouble }: Props)`; server actions `addDomainAction`, `removeDomainAction`, `verifyDomainAction`, `adoptAction`
- `environments` is the same list `DeployPanel` takes, because the Domains tab keeps the environment selector. The screens design says domains are not per environment and the selector therefore disappears on this tab; that was true when a domain belonged to a project, and the spec's **It keeps the environment selector** section records the correction. Reuse whatever `DeployPanel` renders the strip with rather than drawing a second one.

- [ ] **Step 1: Write the failing test**

Create `app/(portal)/portal/sites/[id]/domainsPanel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import type { Domain } from '@/server/hostd/domains'
import { DomainsPanel } from './domainsPanel'

const domain = (over: Partial<Domain> = {}): Domain => ({
    hostname: 'acme.com', primary: true, state: 'active', certificate: 'cloudflare-origin',
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null, ...over,
})

const props = {
    id: 'acme', environment: 'live' as const, projectName: 'Acme Bakery',
    environments: [{ name: 'live' as const }, { name: 'test' as const }],
    domains: [domain()], isAdmin: true, trouble: null,
}

describe('DomainsPanel, for the operator', () => {
    it('lists every hostname with its state', () => {
        render(<DomainsPanel {...props} domains={[domain(), domain({ hostname: 'www.acme.com', primary: false, state: 'pending' })]} />)
        expect(screen.getByText('acme.com')).toBeInTheDocument()
        expect(screen.getByText('www.acme.com')).toBeInTheDocument()
        expect(screen.getByText('waiting for DNS')).toBeInTheDocument()
    })

    it('marks which one is the primary, since every other name redirects to it', () => {
        render(<DomainsPanel {...props} domains={[domain(), domain({ hostname: 'www.acme.com', primary: false })]} />)
        expect(screen.getByText(/primary/i)).toBeInTheDocument()
    })

    it('offers to adopt a site that is still served by hand', () => {
        render(<DomainsPanel {...props} domains={[domain({ state: 'unmanaged' })]} />)
        expect(screen.getByRole('button', { name: /adopt/i })).toBeInTheDocument()
    })

    it('does not offer to adopt one hostd already serves', () => {
        render(<DomainsPanel {...props} />)
        expect(screen.queryByRole('button', { name: /adopt/i })).toBeNull()
    })

    it('says so plainly when the list could not be read at all', () => {
        render(<DomainsPanel {...props} domains={[]} trouble="hostd did not answer" />)
        expect(screen.getByText(/did not answer/)).toBeInTheDocument()
    })

    it('keeps the environment selector, because a domain belongs to an environment', () => {
        render(<DomainsPanel {...props} />)
        // Whatever DeployPanel renders its strip with, not a second strip invented here: match its
        // markup and assert the other environment is reachable, not which ARIA role it carries.
        expect(screen.getByText(/test/i)).toBeInTheDocument()
    })
})

describe('DomainsPanel, for a client', () => {
    const asClient = { ...props, isAdmin: false }

    it('says whether the domain is working, in a sentence', () => {
        render(<DomainsPanel {...asClient} />)
        expect(screen.getByText(/working/)).toBeInTheDocument()
    })

    it('shows no table, no ports and no file paths', () => {
        render(<DomainsPanel {...asClient} domains={[domain({ state: 'broken', error: 'x' })]} />)
        expect(screen.queryByRole('table')).toBeNull()
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
    })

    it('offers a client no action at all, because every one of them is the operator\'s', () => {
        render(<DomainsPanel {...asClient} domains={[domain({ state: 'unmanaged' })]} />)
        expect(screen.queryByRole('button')).toBeNull()
    })
})
```

Add to `app/(portal)/portal/sites/[id]/page.test.tsx`:

```tsx
it('shows a client the Domains tab, which used to be hidden from them', async () => {
    const page = await renderPage({ isAdmin: false })
    expect(page.getByRole('tab', { name: 'Domains' })).toBeInTheDocument()
})

it('does not disable the Domains tab any more', async () => {
    const page = await renderPage({ isAdmin: true })
    expect(page.getByRole('tab', { name: 'Domains' })).not.toBeDisabled()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run "app/(portal)/portal/sites/[id]"`
Expected: FAIL, cannot resolve `./domainsPanel`, and the tab assertions fail.

- [ ] **Step 3: Write the panel**

Create `domainsPanel.tsx` as a server component. For an operator, `ui/DataTable` with hostname, role, state (`ui/StatusDot` plus `stateWord`), last checked, certificate and, when `needsYou`, the reason. For a client, `ui/KeyValue` or plain paragraphs carrying `clientSentence`, and nothing else.

Create `domainControls.tsx` as the `'use client'` half holding the add box, the remove and verify buttons, and the adopt dialog (`ui/Dialog`), which shows the preview's two files side by side and requires the project name typed back before its confirm button enables.

- [ ] **Step 4: Add the server actions**

In `actions.ts`, add four actions following the file's existing `allow()` gate. `addDomainAction`, `removeDomainAction` and `adoptAction` pass `adminOnly: true`; `verifyDomainAction` does too, since only `domains-read` is client-readable and retrying is a write. Each calls the matching function from `server/hostd/domains.ts`, then `revalidatePath`.

- [ ] **Step 5: Wire the tab**

In `page.tsx`:

- Remove the `domains` entry from `WAITING`.
- Replace the admin-only, disabled tab entry with `{ id: 'domains', label: 'Domains', disabled: !view.capabilities.includes('domains') }`, no longer inside the `isAdmin` guard.
- Replace the comment above it, which currently reasons that a client must not be shown a tab they will never be given, with one saying that domains are now readable by a client and that acting on them is still the operator's.
- Fetch the domains in `gatherSite` beside the environments, and render `<DomainsPanel ... />` when `selected === 'domains'`.

- [ ] **Step 6: Run the portal suite**

Run: `npm test`
Expected: PASS, including the existing `page.test.tsx` cases.

- [ ] **Step 7: Commit**

```bash
git add "app/(portal)/portal/sites/[id]/" 
git commit -m "Build the Domains tab, and stop hiding it from clients"
```

---

## Verification before the PR

- [ ] `cd hostd && npm run typecheck && npm test` passes with no skipped files
- [ ] `npm test` at the repo root passes
- [ ] `sh -n hostd/host/hostd-apache.sh` is silent
- [ ] No em dashes in the runbook or the host files. `grep -P` is unavailable in this environment's locale, so use node:

```bash
node -e "for (const f of process.argv.slice(1)) { const n = [...require('fs').readFileSync(f,'utf8')].filter(c => c.charCodeAt(0) === 8212).length; if (n) console.log(f, n) }" hostd/RUNBOOK.md hostd/host/*
```
- [ ] The five existing sites are untouched: nothing in this branch writes to `projects.yaml`, and no vhost is written until somebody calls adopt
- [ ] The PR names what 4a deliberately leaves out: certbot and Let's Encrypt, changing a primary hostname, wildcards, and the maintenance page's own markup
