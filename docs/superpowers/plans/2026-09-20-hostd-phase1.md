# hostd phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the hostd boundary on the dedi: an unprivileged HTTP API and a privileged agent that together let an authenticated caller see the status of a registered client project, start, stop and restart it, and read or follow its logs, with every action policy-checked twice and audited.

**Architecture:** Two containers from one Node package in `hostd/`. `hostd-api` speaks HTTP on a private Docker network, authenticates the portal, applies the ownership and capability policy, and writes the audit log. `hostd-agent` holds the Docker socket, listens only on a Unix socket shared with `api`, accepts a fixed set of verbs, and re-checks every request against its own copy of the operator's registry, including a storage guard computed from `docker compose config`.

**Tech Stack:** Node 22, TypeScript run through `tsx` (no build step), `node:test` with `node:assert/strict`, the `yaml` package, the Docker Engine API over its Unix socket, the `docker compose` CLI, Docker Compose for deployment.

**Spec:** [docs/superpowers/specs/2026-09-20-hostd-design.md](../specs/2026-09-20-hostd-design.md)

## Global Constraints

- **No em dashes** (U+2014, `&mdash;`) anywhere: code comments are the only exception. Use a comma, colon, full stop or parentheses. Applies to every file, commit message and PR description this plan produces (`CLAUDE.md`).
- **Stay inside `hostd/`.** The only file outside it that this plan changes is the root `.dockerignore`, which gains one line (`hostd/`) in Task 15. Never touch `app/`, the root `package.json`, the root `docker-compose.yml`, `scripts/` or `mail/`: another session is editing the Next.js app.
- **Node 22**, ESM (`"type": "module"`), TypeScript through `tsx`, imports written with the `.ts` extension, 4-space indentation, no semicolons, single quotes: the same conventions as `mail/mailops`.
- **Tests use `node:test` and `node:assert/strict`.** No Jest, no Vitest. Run with `npm test` from `hostd/`.
- **One runtime dependency: `yaml`.** Everything else is Node built-ins.
- **Every child process is spawned with `shell: false` and a fixed argv.** No request value is ever interpolated into a command string.
- **The agent never trusts `api` for anything it can look up itself:** compose path, project directory, services and storage always come from the registry.
- **`api` publishes no host port.** It listens on `:8080` on the `hostd` Docker network only.
- **Registry lookups by name use `Object.hasOwn` or a `Map`,** never a bare `obj[name]`, so a name like `constructor` cannot resolve to a prototype property.
- **Secrets:** the operator fills `.env` on the dedi. Nothing in this plan asks for a secret to be pasted anywhere.

### Differences from the spec

1. **One package, not three.** The spec sketches `shared/`, `api/` and `agent/` as packages. With no build step, three packages would need npm workspaces and cross-package `tsx` resolution for no benefit. This plan uses one package, `hostd/`, with `src/shared`, `src/api` and `src/agent`, one lockfile, and one Dockerfile with an `api` target and an `agent` target. The separation that matters, what runs with privilege, is unchanged: each container starts only its own entrypoint.
2. **Phase 1 hard gates.** `RESTIC_PASSWORD` and a writable `/backups` are phase 2 gates; phase 1 does not check them. `example.env.agent` and `ORIGIN_HOSTNAME` also arrive with the phases that need them.
3. **The agent has no network in phase 1** (`network_mode: none`). It talks only to the Docker socket and its own Unix socket. Phase 2 gives it a network for R2.
4. **Two additions to registry validation**, both in the spirit of the storage guard: two projects may not share a `dir`, and two storage entries in one project may not overlap (otherwise a `ro` directory nested in an `rw` one would be writable through the other name). A storage directory may also not overlap a `sqlite` database file, extending "database files are never exposed" to SQLite.
5. **The storage guard is re-run before every start and restart,** not only at load, because the operator can edit a compose file without touching the registry.
6. **The storage guard checks one direction for things compose reads.** A storage directory must not *contain* the compose file, an env file, a build context or a Dockerfile. Being *inside* a build context is allowed, because `build: .` puts every storage directory inside one. The reasoning is in Task 5. Overlap with a database mount is still refused in both directions.

### File structure

```
hostd/
  package.json                    Task 1
  tsconfig.json                   Task 1
  .gitignore                      Task 1
  Dockerfile                      Task 15
  .dockerignore                   Task 15
  docker-compose.yml              Task 15
  example.env                     Task 15
  projects.example.yaml           Task 15
  RUNBOOK.md                      Task 15
  src/
    shared/
      formats.ts                  Task 1   id and path grammar, containment, isRecord
      registry.ts                 Task 2   parse and validate projects.yaml
      registry-store.ts           Task 3   load, poll, keep the last good registry
      status.ts                   Task 3   status.json for the healthcheck
      healthcheck.ts              Task 3   the Docker healthcheck command for both containers
      protocol.ts                 Task 4   agent verbs, request parsing, structural check
    agent/
      compose.ts                  Task 5   compose argv, spawn runner, compose config
      guard.ts                    Task 5   the storage guard
      logframes.ts                Task 6   Docker log frame and line decoding
      docker.ts                   Task 7   Docker Engine API client, status mapping
      agent.ts                    Task 8   verb handlers, locks, follow limits
      server.ts                   Task 8   one request per Unix socket connection
      guard-tracker.ts            Task 9   the guard's current verdict per project
      index.ts                    Task 9   boot gate, guard refresh, listen
    api/
      auth.ts                     Task 10  bearer token and actor headers
      policy.ts                   Task 10  ownership and capability decisions
      agent-client.ts             Task 11  talks to the agent socket
      audit.ts                    Task 12  JSONL audit log
      sse.ts                      Task 13  Server-Sent Events framing
      routes.ts                   Task 13  HTTP routing
      index.ts                    Task 14  boot gate, loops, listen
```

Every `*.ts` module above has a `*.test.ts` beside it, with three exceptions: the two `index.ts` entrypoints (covered by the runbook's live checks), `healthcheck.ts` (a thin wrapper over the tested `isHealthy`), and `sse.ts` (covered by the route tests).

Must-exist tests 1 and 2 from the spec's testing strategy are in this phase: Task 8 (the agent refuses when `api` itself asks) and Task 5 (the storage guard). Tests 3 to 5 belong to the phases that build files, domains and backups.

---

### Task 1: Scaffold and the shared grammar

Creates the package and the pure grammar every other module validates against: identifier patterns, the relative path rules, and path containment. Both processes import this file, so `api` and `agent` can never disagree about what a valid value is.

**Files:**
- Create: `hostd/package.json`
- Create: `hostd/tsconfig.json`
- Create: `hostd/.gitignore`
- Create: `hostd/src/shared/formats.ts`
- Test: `hostd/src/shared/formats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PROJECT_ID`, `CLIENT_ID`, `SERVICE_NAME`, `STORAGE_NAME`, `USER_ID`, `ENV_NAME`, `HOSTNAME` (RegExp); `RESERVED_PROJECT_IDS: Set<string>`; `MAX_SEGMENT_BYTES = 255`; `MAX_PATH_BYTES = 4096`; `isRecord(value: unknown): value is Record<string, unknown>`; `relativePathProblem(path: string): string | null`; `isWithin(parent: string, child: string): boolean`; `overlaps(a: string, b: string): boolean`; `describeError(error: unknown): string`.

- [ ] **Step 1: Create the package manifest**

Create `hostd/package.json`:

```json
{
  "name": "hostd",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.6"
  },
  "scripts": {
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "start:api": "node --import tsx src/api/index.ts",
    "start:agent": "node --import tsx src/agent/index.ts"
  },
  "dependencies": {
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

`>=22.6` because the tests use `duplexPair` from `node:stream`, added in 22.6.

- [ ] **Step 2: Create the TypeScript config**

Create `hostd/tsconfig.json`:

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
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the folder's gitignore**

Create `hostd/.gitignore`. The root `.gitignore` already ignores `.env*`; the registry names clients, so it is ignored here, next to the file it protects, rather than in the root file.

```
node_modules/
projects.yaml
.env
.env.*
```

- [ ] **Step 4: Install dependencies**

Run: `cd hostd && npm install`
Expected: `node_modules/` and `package-lock.json` created, no errors.

- [ ] **Step 5: Write the failing test**

Create `hostd/src/shared/formats.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    PROJECT_ID, CLIENT_ID, SERVICE_NAME, USER_ID, RESERVED_PROJECT_IDS,
    isRecord, relativePathProblem, isWithin, overlaps, describeError,
} from './formats.ts'

describe('identifier patterns', () => {
    it('accepts the project ids the registry uses', () => {
        assert.ok(PROJECT_ID.test('acme-bakery'))
        assert.ok(PROJECT_ID.test('a1'))
    })

    it('refuses project ids that could not be compose project names or are too short', () => {
        for (const id of ['A-bakery', '-acme', 'a', 'acme_bakery', 'a'.repeat(32), '__proto__']) {
            assert.equal(PROJECT_ID.test(id), false, id)
        }
    })

    it('reserves the operator\'s own stacks', () => {
        assert.deepEqual([...RESERVED_PROJECT_IDS].sort(), ['horizons', 'hostd', 'mail'])
    })

    it('accepts portal client ids and refuses anything with a separator', () => {
        assert.ok(CLIENT_ID.test('cl_8f2k1'))
        assert.equal(CLIENT_ID.test('cl:1'), false)
        assert.equal(CLIENT_ID.test(''), false)
    })

    it('accepts compose service names', () => {
        assert.ok(SERVICE_NAME.test('web'))
        assert.ok(SERVICE_NAME.test('db_1.primary'))
        assert.equal(SERVICE_NAME.test('-web'), false)
        assert.equal(SERVICE_NAME.test('web/other'), false)
    })

    it('accepts portal user ids and refuses whitespace', () => {
        assert.ok(USER_ID.test('user:abc@example.com'))
        assert.equal(USER_ID.test('a b'), false)
    })
})

describe('isRecord', () => {
    it('is true only for plain object-like values', () => {
        assert.equal(isRecord({}), true)
        assert.equal(isRecord([]), false)
        assert.equal(isRecord(null), false)
        assert.equal(isRecord('x'), false)
    })
})

describe('relativePathProblem', () => {
    it('accepts ordinary relative paths', () => {
        assert.equal(relativePathProblem('uploads'), null)
        assert.equal(relativePathProblem('uploads/2026/photo one.jpg'), null)
    })

    const refused: Array<[string, string]> = [
        ['', 'path is empty'],
        ['/etc/passwd', 'path must be relative'],
        ['uploads/../../etc', 'path contains ..'],
        ['..', 'path contains ..'],
        ['./uploads', 'path contains .'],
        ['uploads//x', 'path contains an empty segment'],
        ['uploads/', 'path contains an empty segment'],
        ['uploads\\x', 'path contains a backslash'],
        ['up\u0000loads', 'path contains a control character'],
        ['up\nloads', 'path contains a control character'],
        ['a'.repeat(256), 'a path segment is longer than 255 bytes'],
        [('a'.repeat(200) + '/').repeat(21) + 'a', 'path is longer than 4096 bytes'],
    ]
    for (const [path, reason] of refused) {
        it(`refuses ${JSON.stringify(path.slice(0, 30))}`, () => {
            assert.equal(relativePathProblem(path), reason)
        })
    }

    it('counts bytes, not characters, against the segment limit', () => {
        // 128 two-byte characters is 256 bytes.
        assert.equal(relativePathProblem('é'.repeat(128)), 'a path segment is longer than 255 bytes')
    })
})

describe('isWithin and overlaps', () => {
    it('treats a path as within itself and its ancestors', () => {
        assert.equal(isWithin('/var/www/a', '/var/www/a'), true)
        assert.equal(isWithin('/var/www/a', '/var/www/a/uploads/x'), true)
    })

    it('does not confuse a shared prefix with containment', () => {
        assert.equal(isWithin('/var/www/a', '/var/www/ab'), false)
    })

    it('overlaps in either direction', () => {
        assert.equal(overlaps('/var/www/a/uploads', '/var/www/a'), true)
        assert.equal(overlaps('/var/www/a', '/var/www/a/uploads'), true)
        assert.equal(overlaps('/var/www/a/uploads', '/var/www/a/db'), false)
    })
})

describe('describeError', () => {
    it('uses the message of an Error and stringifies anything else', () => {
        assert.equal(describeError(new Error('boom')), 'boom')
        assert.equal(describeError('plain'), 'plain')
    })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './formats.ts'`.

- [ ] **Step 7: Implement the grammar**

Create `hostd/src/shared/formats.ts`:

```ts
// The grammar every identifier and path must satisfy before anything else looks at it. Pure, and shared
// by both processes, so api and agent can never disagree about what a valid value is.

// Also the compose project name, so it follows compose's own rules, minus underscores.
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
export const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
export const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
export const STORAGE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
export const USER_ID = /^[A-Za-z0-9_@.:+-]{1,128}$/
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
export const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

// The operator's own stacks. A registry mistake must never be able to enrol them.
export const RESERVED_PROJECT_IDS = new Set(['hostd', 'mail', 'horizons'])

export const MAX_SEGMENT_BYTES = 255
export const MAX_PATH_BYTES = 4096

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Returns null when the path is acceptable, otherwise the reason it is not. Deliberately stricter than
// POSIX: no '.' or empty segments either, so there is exactly one spelling of every path and nothing
// downstream ever has to normalise.
export function relativePathProblem(path: string): string | null {
    if (path === '') return 'path is empty'
    if (Buffer.byteLength(path) > MAX_PATH_BYTES) return `path is longer than ${MAX_PATH_BYTES} bytes`
    if (path.startsWith('/')) return 'path must be relative'
    if (path.includes('\\')) return 'path contains a backslash'
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) return 'path contains a control character'
    for (const segment of path.split('/')) {
        if (segment === '') return 'path contains an empty segment'
        if (segment === '..') return 'path contains ..'
        if (segment === '.') return 'path contains .'
        if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return `a path segment is longer than ${MAX_SEGMENT_BYTES} bytes`
    }
    return null
}

// POSIX absolute paths that are already normalised: everything the agent compares comes either from
// posix.join over grammar-checked parts or from compose's own resolved output.
export function isWithin(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

export function overlaps(a: string, b: string): boolean {
    return isWithin(a, b) || isWithin(b, a)
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS, all `formats` tests green.

- [ ] **Step 9: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add hostd/package.json hostd/package-lock.json hostd/tsconfig.json hostd/.gitignore hostd/src/shared/formats.ts hostd/src/shared/formats.test.ts
git commit -m "Scaffold hostd and the grammar both of its processes validate against"
```

---

### Task 2: The registry parser

Turns `projects.yaml` into a typed `Registry`. A problem with one project marks that project invalid and leaves the others working; a problem with the file as a whole (bad YAML, unknown top-level key) rejects the file, so the store in Task 3 can keep the last good version.

**Files:**
- Create: `hostd/src/shared/registry.ts`
- Test: `hostd/src/shared/registry.test.ts`

**Interfaces:**
- Consumes: from Task 1, `PROJECT_ID`, `CLIENT_ID`, `SERVICE_NAME`, `STORAGE_NAME`, `ENV_NAME`, `HOSTNAME`, `RESERVED_PROJECT_IDS`, `isRecord`, `relativePathProblem`, `overlaps`.
- Produces:
  - `CAPABILITIES`, `type Capability = 'lifecycle' | 'logs' | 'files' | 'backups' | 'domains'`
  - `ENGINES`, `type Engine`, `type StorageMode = 'rw' | 'ro' | 'hidden'`, `type Keep = { daily: number, weekly: number, monthly: number }`
  - `type ServiceEntry = SiteService | DatabaseService | SqliteDatabase` where `SiteService = { role: 'site' }`, `DatabaseService = { role: 'database', engine: Exclude<Engine, 'sqlite'>, dump: { userEnv?: string, passwordEnv?: string } }`, `SqliteDatabase = { role: 'database', engine: 'sqlite', file: string }`
  - `type StorageEntry = { path: string, absolute: string, mode: StorageMode }`
  - `type ProjectEntry = { id, client, name, dir, compose, composePath: string, upstream: { host: string, port: number }, services: Record<string, ServiceEntry>, storage: Record<string, StorageEntry>, capabilities: Set<Capability>, maxDomains: number, backups: { maxKeep: Keep } }`
  - `type Registry = { reserved: string[], offsite: { keep: Keep }, projects: Map<string, ProjectEntry>, invalid: Map<string, string> }`
  - `class RegistryError extends Error { failures: string[] }`
  - `parseRegistry(text: string): Registry`
  - `isComposeService(entry: ServiceEntry): boolean` (false only for SQLite entries)

- [ ] **Step 1: Write the failing test**

Create `hostd/src/shared/registry.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRegistry, RegistryError, isComposeService } from './registry.ts'

const valid = `
reserved: [horizons.gg]
offsite:
  keep: { daily: 14, weekly: 8, monthly: 6 }
projects:
  acme-bakery:
    client: cl_8f2k1
    name: Acme Bakery
    dir: /var/www/acme-bakery
    compose: docker-compose.yml
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      media: { path: uploads, mode: rw }
      exports: { path: exports, mode: ro }
      config: { path: config, mode: hidden }
    capabilities: [lifecycle, logs, files, backups, domains]
    maxDomains: 3
    backups:
      maxKeep: { daily: 14, weekly: 8, monthly: 12 }
`

// A minimal valid project whose fields a test can override one at a time.
function project(overrides: Record<string, string> = {}): string {
    const fields: Record<string, string> = {
        client: 'cl_1',
        name: 'Site',
        dir: '/var/www/site',
        upstream: '127.0.0.1:5011',
        services: '{ web: { role: site } }',
        capabilities: '[lifecycle, logs]',
        ...overrides,
    }
    const body = Object.entries(fields).map(([key, value]) => `    ${key}: ${value}`).join('\n')
    return `projects:\n  site:\n${body}\n`
}

function failuresOf(text: string): string[] {
    try {
        parseRegistry(text)
    } catch (error) {
        assert.ok(error instanceof RegistryError)
        return error.failures
    }
    assert.fail('expected a RegistryError')
}

function invalidReason(text: string, id = 'site'): string | undefined {
    return parseRegistry(text).invalid.get(id)
}

describe('parseRegistry, a valid file', () => {
    it('parses every field of the documented example', () => {
        const registry = parseRegistry(valid)
        assert.deepEqual(registry.invalid, new Map())
        const entry = registry.projects.get('acme-bakery')
        assert.ok(entry)
        assert.equal(entry.client, 'cl_8f2k1')
        assert.equal(entry.composePath, '/var/www/acme-bakery/docker-compose.yml')
        assert.deepEqual(entry.upstream, { host: '127.0.0.1', port: 5010 })
        assert.deepEqual(entry.services.db, { role: 'database', engine: 'postgres', dump: {} })
        assert.deepEqual(entry.storage.media, { path: 'uploads', absolute: '/var/www/acme-bakery/uploads', mode: 'rw' })
        assert.deepEqual([...entry.capabilities].sort(), ['backups', 'domains', 'files', 'lifecycle', 'logs'])
        assert.deepEqual(entry.backups.maxKeep, { daily: 14, weekly: 8, monthly: 12 })
        assert.deepEqual(registry.offsite.keep, { daily: 14, weekly: 8, monthly: 6 })
    })

    it('applies defaults for everything optional', () => {
        const registry = parseRegistry(project())
        const entry = registry.projects.get('site')
        assert.ok(entry)
        assert.equal(entry.compose, 'docker-compose.yml')
        assert.deepEqual(entry.storage, {})
        assert.equal(entry.maxDomains, 3)
        assert.deepEqual(entry.backups.maxKeep, { daily: 14, weekly: 8, monthly: 12 })
        assert.deepEqual(registry.reserved, ['horizons.gg'])
        assert.deepEqual(registry.offsite.keep, { daily: 14, weekly: 8, monthly: 6 })
    })

    it('reads a SQLite database as a file rather than a compose service', () => {
        const registry = parseRegistry(project({
            services: '{ web: { role: site }, appdb: { role: database, engine: sqlite, file: data/app.db } }',
        }))
        const appdb = registry.projects.get('site')?.services.appdb
        assert.deepEqual(appdb, { role: 'database', engine: 'sqlite', file: 'data/app.db' })
        assert.ok(appdb)
        assert.equal(isComposeService(appdb), false)
    })

    it('accepts dump variable overrides', () => {
        const registry = parseRegistry(project({
            services: '{ web: { role: site }, db: { role: database, engine: mysql, dump: { userEnv: DB_USER, passwordEnv: DB_PASS } } }',
        }))
        assert.deepEqual(registry.projects.get('site')?.services.db, {
            role: 'database', engine: 'mysql', dump: { userEnv: 'DB_USER', passwordEnv: 'DB_PASS' },
        })
    })
})

describe('parseRegistry, problems with the whole file', () => {
    it('rejects YAML that does not parse', () => {
        assert.match(failuresOf('projects: [unclosed')[0] ?? '', /^not valid YAML/)
    })

    it('rejects a document that is not a mapping', () => {
        assert.deepEqual(failuresOf('- a\n- b\n'), ['the registry must be a mapping with a projects key'])
    })

    it('rejects an unknown top-level key, which is almost always a typo', () => {
        assert.deepEqual(failuresOf('projets: {}\nprojects: {}\n'), ['unknown top-level key projets'])
    })

    it('rejects a missing projects mapping', () => {
        assert.deepEqual(failuresOf('reserved: [horizons.gg]\n'), ['projects must be a mapping'])
    })

    it('rejects a malformed reserved list', () => {
        assert.deepEqual(failuresOf('reserved: [Horizons.GG]\nprojects: {}\n'), ['reserved must be a list of lowercase hostnames'])
    })

    it('rejects bad offsite retention', () => {
        assert.deepEqual(
            failuresOf('offsite: { keep: { daily: -1 } }\nprojects: {}\n'),
            ['offsite.keep.daily must be a whole number from 0 to 1000'],
        )
    })
})

describe('parseRegistry, problems with one project', () => {
    it('marks only the broken project invalid and keeps the rest', () => {
        const text = `${valid}  broken:\n    client: cl_2\n`
        const registry = parseRegistry(text)
        assert.ok(registry.projects.has('acme-bakery'))
        assert.equal(registry.projects.has('broken'), false)
        assert.ok(registry.invalid.get('broken'))
    })

    it('refuses a reserved id', () => {
        const text = project().replace('  site:', '  mail:')
        assert.equal(invalidReason(text, 'mail'), 'mail is reserved for the operator\'s own stacks')
    })

    it('refuses a malformed id', () => {
        const text = project().replace('  site:', '  Site_1:')
        assert.match(invalidReason(text, 'Site_1') ?? '', /^id must match/)
    })

    it('refuses an unknown key', () => {
        assert.match(invalidReason(project({ capabilites: '[logs]' })) ?? '', /unknown key capabilites/)
    })

    it('refuses a dir outside /var/www or more than one segment deep', () => {
        for (const dir of ['/srv/site', '/var/www', '/var/www/a/b', '/var/www/../etc']) {
            assert.match(invalidReason(project({ dir })) ?? '', /dir must be \/var\/www\/<one segment>/, dir)
        }
    })

    it('refuses a compose path that climbs out of dir', () => {
        assert.match(invalidReason(project({ compose: '../other/docker-compose.yml' })) ?? '', /compose: path contains \.\./)
    })

    it('refuses a malformed upstream', () => {
        for (const upstream of ['5010', 'example.com:5010', '127.0.0.1:0', '127.0.0.1:70000']) {
            assert.match(invalidReason(project({ upstream })) ?? '', /upstream must be/, upstream)
        }
    })

    it('requires at least one site service', () => {
        assert.match(
            invalidReason(project({ services: '{ db: { role: database, engine: postgres } }' })) ?? '',
            /at least one service must have role site/,
        )
    })

    it('refuses an unknown engine and a SQLite entry without a file', () => {
        assert.match(
            invalidReason(project({ services: '{ web: { role: site }, db: { role: database, engine: oracle } }' })) ?? '',
            /services\.db\.engine must be one of/,
        )
        assert.match(
            invalidReason(project({ services: '{ web: { role: site }, db: { role: database, engine: sqlite } }' })) ?? '',
            /services\.db\.file/,
        )
    })

    it('refuses storage with a bad path or mode', () => {
        assert.match(invalidReason(project({ storage: '{ media: { path: ../x, mode: rw } }' })) ?? '', /storage\.media\.path: path contains \.\./)
        assert.match(invalidReason(project({ storage: '{ media: { path: uploads, mode: write } }' })) ?? '', /storage\.media\.mode must be/)
    })

    it('refuses storage entries that overlap each other, so ro cannot be reached through rw', () => {
        assert.match(
            invalidReason(project({ storage: '{ media: { path: uploads, mode: rw }, thumbs: { path: uploads/thumbs, mode: ro } }' })) ?? '',
            /storage media and thumbs overlap/,
        )
    })

    it('refuses storage that overlaps a SQLite database file', () => {
        assert.match(
            invalidReason(project({
                services: '{ web: { role: site }, appdb: { role: database, engine: sqlite, file: data/app.db } }',
                storage: '{ data: { path: data, mode: rw } }',
            })) ?? '',
            /storage data overlaps the SQLite file data\/app\.db/,
        )
    })

    it('refuses unknown or repeated capabilities', () => {
        assert.match(invalidReason(project({ capabilities: '[logs, shell]' })) ?? '', /unknown capability shell/)
        assert.match(invalidReason(project({ capabilities: '[logs, logs]' })) ?? '', /capability logs is listed twice/)
    })

    it('refuses maxDomains outside 1 to 20', () => {
        assert.match(invalidReason(project({ maxDomains: '0' })) ?? '', /maxDomains must be a whole number from 1 to 20/)
    })

    it('marks both projects invalid when they share a dir', () => {
        const text = `${project()}  other:\n    client: cl_2\n    name: Other\n    dir: /var/www/site\n    upstream: 127.0.0.1:5012\n    services: { web: { role: site } }\n`
        const registry = parseRegistry(text)
        assert.match(registry.invalid.get('site') ?? '', /dir \/var\/www\/site is also used by other/)
        assert.match(registry.invalid.get('other') ?? '', /dir \/var\/www\/site is also used by site/)
        assert.equal(registry.projects.size, 0)
    })

    it('does not resolve a service called constructor to a prototype property', () => {
        const registry = parseRegistry(project())
        const entry = registry.projects.get('site')
        assert.ok(entry)
        assert.equal(Object.hasOwn(entry.services, 'constructor'), false)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './registry.ts'`.

- [ ] **Step 3: Implement the parser**

Create `hostd/src/shared/registry.ts`:

```ts
// The operator's registry of client projects. Hand-edited, read by both processes, never written by
// either. A problem with one project marks only that project invalid; a problem with the file as a
// whole throws, so the caller can keep the last good version instead.

import { parse } from 'yaml'
import { posix } from 'node:path'
import {
    PROJECT_ID, CLIENT_ID, SERVICE_NAME, STORAGE_NAME, ENV_NAME, HOSTNAME, RESERVED_PROJECT_IDS,
    isRecord, relativePathProblem, overlaps,
} from './formats.ts'

export const CAPABILITIES = ['lifecycle', 'logs', 'files', 'backups', 'domains'] as const
export type Capability = typeof CAPABILITIES[number]
export const ENGINES = ['postgres', 'mysql', 'mariadb', 'mongodb', 'sqlite', 'redis', 'generic'] as const
export type Engine = typeof ENGINES[number]
export const STORAGE_MODES = ['rw', 'ro', 'hidden'] as const
export type StorageMode = typeof STORAGE_MODES[number]
export type Keep = { daily: number, weekly: number, monthly: number }

export type SiteService = { role: 'site' }
export type DatabaseService = { role: 'database', engine: Exclude<Engine, 'sqlite'>, dump: { userEnv?: string, passwordEnv?: string } }
export type SqliteDatabase = { role: 'database', engine: 'sqlite', file: string }
export type ServiceEntry = SiteService | DatabaseService | SqliteDatabase
export type StorageEntry = { path: string, absolute: string, mode: StorageMode }

export type ProjectEntry = {
    id: string
    client: string
    name: string
    dir: string
    compose: string
    composePath: string
    upstream: { host: string, port: number }
    services: Record<string, ServiceEntry>
    storage: Record<string, StorageEntry>
    capabilities: Set<Capability>
    maxDomains: number
    backups: { maxKeep: Keep }
}

export type Registry = {
    reserved: string[]
    offsite: { keep: Keep }
    projects: Map<string, ProjectEntry>
    invalid: Map<string, string>
}

export class RegistryError extends Error {
    constructor(readonly failures: string[]) {
        super(`Invalid registry:\n  ${failures.join('\n  ')}`)
        this.name = 'RegistryError'
    }
}

// SQLite lives in a file the site container opens, not in a compose service of its own.
export function isComposeService(entry: ServiceEntry): boolean {
    return !(entry.role === 'database' && entry.engine === 'sqlite')
}

const DEFAULT_OFFSITE_KEEP: Keep = { daily: 14, weekly: 8, monthly: 6 }
const DEFAULT_MAX_KEEP: Keep = { daily: 14, weekly: 8, monthly: 12 }
const DEFAULT_RESERVED = ['horizons.gg']
const TOP_KEYS = new Set(['reserved', 'offsite', 'projects'])
const PROJECT_KEYS = new Set(['client', 'name', 'dir', 'compose', 'upstream', 'services', 'storage', 'capabilities', 'maxDomains', 'backups'])
const DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const UPSTREAM = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/

function wholeNumber(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function parseKeep(raw: unknown, fallback: Keep, where: string, problems: string[]): Keep {
    if (raw === undefined) return fallback
    if (!isRecord(raw)) {
        problems.push(`${where} must be a mapping`)
        return fallback
    }
    const keep = { ...fallback }
    for (const [key, value] of Object.entries(raw)) {
        if (key !== 'daily' && key !== 'weekly' && key !== 'monthly') {
            problems.push(`${where}.${key} is not a known key`)
            continue
        }
        const count = wholeNumber(value, 0, 1000)
        if (count === null) problems.push(`${where}.${key} must be a whole number from 0 to 1000`)
        else keep[key] = count
    }
    return keep
}

function parseUpstream(raw: unknown, problems: string[]): { host: string, port: number } | null {
    const match = typeof raw === 'string' ? raw.match(UPSTREAM) : null
    const port = match ? Number(match[2]) : 0
    if (!match || !match[1] || port < 1 || port > 65535) {
        problems.push('upstream must be <IPv4 address or localhost>:<port 1 to 65535>')
        return null
    }
    return { host: match[1], port }
}

function parseService(name: string, raw: unknown, problems: string[]): ServiceEntry | null {
    const where = `services.${name}`
    if (!SERVICE_NAME.test(name)) {
        problems.push(`service name ${name} is malformed`)
        return null
    }
    if (!isRecord(raw)) {
        problems.push(`${where} must be a mapping`)
        return null
    }
    if (raw.role === 'site') {
        if (!onlyKeys(raw, ['role'])) problems.push(`${where} with role site takes no other keys`)
        return { role: 'site' }
    }
    if (raw.role !== 'database') {
        problems.push(`${where}.role must be site or database`)
        return null
    }
    if (typeof raw.engine !== 'string' || !(ENGINES as readonly string[]).includes(raw.engine)) {
        problems.push(`${where}.engine must be one of ${ENGINES.join(', ')}`)
        return null
    }
    if (raw.engine === 'sqlite') {
        if (!onlyKeys(raw, ['role', 'engine', 'file'])) problems.push(`${where} with engine sqlite takes only role, engine and file`)
        const problem = typeof raw.file === 'string' ? relativePathProblem(raw.file) : 'file is required'
        if (problem) {
            problems.push(`${where}.file: ${problem}`)
            return null
        }
        return { role: 'database', engine: 'sqlite', file: raw.file as string }
    }
    if (!onlyKeys(raw, ['role', 'engine', 'dump'])) problems.push(`${where} takes only role, engine and dump`)
    const dump: { userEnv?: string, passwordEnv?: string } = {}
    if (raw.dump !== undefined) {
        if (!isRecord(raw.dump) || !onlyKeys(raw.dump, ['userEnv', 'passwordEnv'])) {
            problems.push(`${where}.dump may only contain userEnv and passwordEnv`)
        } else {
            for (const key of ['userEnv', 'passwordEnv'] as const) {
                const value = raw.dump[key]
                if (value === undefined) continue
                if (typeof value !== 'string' || !ENV_NAME.test(value)) problems.push(`${where}.dump.${key} must be an environment variable name`)
                else dump[key] = value
            }
        }
    }
    return { role: 'database', engine: raw.engine as Exclude<Engine, 'sqlite'>, dump }
}

function parseServices(raw: unknown, problems: string[]): Record<string, ServiceEntry> {
    const services: Record<string, ServiceEntry> = {}
    if (!isRecord(raw) || Object.keys(raw).length === 0) {
        problems.push('services must be a non-empty mapping')
        return services
    }
    for (const [name, value] of Object.entries(raw)) {
        const entry = parseService(name, value, problems)
        if (entry) services[name] = entry
    }
    if (!Object.values(services).some(entry => entry.role === 'site')) problems.push('at least one service must have role site')
    return services
}

function parseStorage(raw: unknown, dir: string, services: Record<string, ServiceEntry>, problems: string[]): Record<string, StorageEntry> {
    const storage: Record<string, StorageEntry> = {}
    if (raw === undefined) return storage
    if (!isRecord(raw)) {
        problems.push('storage must be a mapping')
        return storage
    }
    for (const [name, value] of Object.entries(raw)) {
        const where = `storage.${name}`
        if (!STORAGE_NAME.test(name)) {
            problems.push(`storage name ${name} is malformed`)
            continue
        }
        if (!isRecord(value) || !onlyKeys(value, ['path', 'mode'])) {
            problems.push(`${where} must be a mapping of path and mode`)
            continue
        }
        const pathProblem = typeof value.path === 'string' ? relativePathProblem(value.path) : 'path is required'
        if (pathProblem) {
            problems.push(`${where}.path: ${pathProblem}`)
            continue
        }
        if (typeof value.mode !== 'string' || !(STORAGE_MODES as readonly string[]).includes(value.mode)) {
            problems.push(`${where}.mode must be one of ${STORAGE_MODES.join(', ')}`)
            continue
        }
        const path = value.path as string
        storage[name] = { path, absolute: posix.join(dir, path), mode: value.mode as StorageMode }
    }

    const entries = Object.entries(storage)
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [a, first] = entries[i]!
            const [b, second] = entries[j]!
            if (overlaps(first.absolute, second.absolute)) problems.push(`storage ${a} and ${b} overlap`)
        }
    }
    for (const [name, entry] of entries) {
        for (const service of Object.values(services)) {
            if (service.role === 'database' && service.engine === 'sqlite' && overlaps(entry.absolute, posix.join(dir, service.file))) {
                problems.push(`storage ${name} overlaps the SQLite file ${service.file}`)
            }
        }
    }
    return storage
}

function parseCapabilities(raw: unknown, problems: string[]): Set<Capability> {
    const capabilities = new Set<Capability>()
    if (raw === undefined) return capabilities
    if (!Array.isArray(raw)) {
        problems.push('capabilities must be a list')
        return capabilities
    }
    for (const value of raw) {
        if (typeof value !== 'string' || !(CAPABILITIES as readonly string[]).includes(value)) {
            problems.push(`unknown capability ${String(value)}`)
            continue
        }
        if (capabilities.has(value as Capability)) problems.push(`capability ${value} is listed twice`)
        capabilities.add(value as Capability)
    }
    return capabilities
}

type ParsedProject = { entry: ProjectEntry } | { problems: string[] }

function parseProject(id: string, raw: unknown): ParsedProject {
    if (!PROJECT_ID.test(id)) return { problems: [`id must match ${PROJECT_ID}`] }
    if (RESERVED_PROJECT_IDS.has(id)) return { problems: [`${id} is reserved for the operator's own stacks`] }
    if (!isRecord(raw)) return { problems: ['entry must be a mapping'] }

    const problems: string[] = []
    for (const key of Object.keys(raw)) if (!PROJECT_KEYS.has(key)) problems.push(`unknown key ${key}`)

    const client = typeof raw.client === 'string' && CLIENT_ID.test(raw.client) ? raw.client : null
    if (!client) problems.push(`client must match ${CLIENT_ID}`)
    const name = typeof raw.name === 'string' && raw.name.length >= 1 && raw.name.length <= 100 ? raw.name : null
    if (!name) problems.push('name must be 1 to 100 characters')
    const dir = typeof raw.dir === 'string' && DIR.test(raw.dir) && !raw.dir.endsWith('/..') && !raw.dir.endsWith('/.') ? raw.dir : null
    if (!dir) problems.push('dir must be /var/www/<one segment>')

    let compose = 'docker-compose.yml'
    if (raw.compose !== undefined) {
        const problem = typeof raw.compose === 'string' ? relativePathProblem(raw.compose) : 'path must be a string'
        if (problem) problems.push(`compose: ${problem}`)
        else compose = raw.compose as string
    }

    const upstream = parseUpstream(raw.upstream, problems)
    const services = parseServices(raw.services, problems)
    const storage = parseStorage(raw.storage, dir ?? '/nonexistent', services, problems)
    const capabilities = parseCapabilities(raw.capabilities, problems)

    let maxDomains = 3
    if (raw.maxDomains !== undefined) {
        const value = wholeNumber(raw.maxDomains, 1, 20)
        if (value === null) problems.push('maxDomains must be a whole number from 1 to 20')
        else maxDomains = value
    }

    let maxKeep = DEFAULT_MAX_KEEP
    if (raw.backups !== undefined) {
        if (!isRecord(raw.backups) || !onlyKeys(raw.backups, ['maxKeep'])) problems.push('backups may only contain maxKeep')
        else maxKeep = parseKeep(raw.backups.maxKeep, DEFAULT_MAX_KEEP, 'backups.maxKeep', problems)
    }

    if (problems.length > 0 || !client || !name || !dir || !upstream) return { problems }
    return {
        entry: {
            id, client, name, dir, compose,
            composePath: posix.join(dir, compose),
            upstream, services, storage, capabilities, maxDomains,
            backups: { maxKeep },
        },
    }
}

export function parseRegistry(text: string): Registry {
    let doc: unknown
    try {
        doc = parse(text)
    } catch (error) {
        throw new RegistryError([`not valid YAML: ${error instanceof Error ? error.message : String(error)}`])
    }
    if (!isRecord(doc)) throw new RegistryError(['the registry must be a mapping with a projects key'])

    const failures: string[] = []
    for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) failures.push(`unknown top-level key ${key}`)

    let reserved = DEFAULT_RESERVED
    if (doc.reserved !== undefined) {
        const list = doc.reserved
        if (!Array.isArray(list) || !list.every(host => typeof host === 'string' && HOSTNAME.test(host))) {
            failures.push('reserved must be a list of lowercase hostnames')
        } else {
            reserved = list as string[]
        }
    }

    let offsiteKeep = DEFAULT_OFFSITE_KEEP
    if (doc.offsite !== undefined) {
        if (!isRecord(doc.offsite) || !onlyKeys(doc.offsite, ['keep'])) failures.push('offsite may only contain keep')
        else offsiteKeep = parseKeep(doc.offsite.keep, DEFAULT_OFFSITE_KEEP, 'offsite.keep', failures)
    }

    if (!isRecord(doc.projects)) failures.push('projects must be a mapping')
    if (failures.length > 0) throw new RegistryError(failures)

    const parsed = new Map<string, ProjectEntry>()
    const invalid = new Map<string, string>()
    for (const [id, raw] of Object.entries(doc.projects as Record<string, unknown>)) {
        const result = parseProject(id, raw)
        if ('problems' in result) invalid.set(id, result.problems.join('; '))
        else parsed.set(id, result.entry)
    }

    // Two entries over one directory would let one client's settings drive another client's site.
    const projects = new Map<string, ProjectEntry>()
    for (const [id, entry] of parsed) {
        const sharing = [...parsed.values()].filter(other => other.id !== id && other.dir === entry.dir).map(other => other.id)
        if (sharing.length > 0) invalid.set(id, `dir ${entry.dir} is also used by ${sharing.join(', ')}`)
        else projects.set(id, entry)
    }

    return { reserved, offsite: { keep: offsiteKeep }, projects, invalid }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS, all `registry` and `formats` tests green.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/registry.ts hostd/src/shared/registry.test.ts
git commit -m "Parse the project registry, isolating a broken entry from the rest"
```

---
### Task 3: Registry store and the status file

The store owns the registry over time. The first load throws, so each boot gate can name the failure. Later reloads never throw: a file that stops parsing leaves the last good registry in force and turns into a warning. The status module writes the `status.json` both healthchecks read, the same arrangement as `mailops`.

**Files:**
- Create: `hostd/src/shared/registry-store.ts`
- Create: `hostd/src/shared/status.ts`
- Create: `hostd/src/shared/healthcheck.ts`
- Test: `hostd/src/shared/registry-store.test.ts`
- Test: `hostd/src/shared/status.test.ts`

**Interfaces:**
- Consumes: from Task 1, `describeError`; from Task 2, `parseRegistry`, `RegistryError`, `type Registry`.
- Produces:
  - `type RegistryFs = { stat(path: string): Promise<{ mtimeMs: number, isFile(): boolean }>, readFile(path: string): Promise<string> }`
  - `class RegistryStore` with `constructor(path: string, fs?: RegistryFs)`, `load(): Promise<Registry>` (throws), `refresh(): Promise<boolean>` (never throws, true when a new registry took effect), `current(): Registry`, `warnings(): string[]`
  - `explainRegistryError(error: unknown): string`
  - `type Status = { ok: boolean, checkedAt: string, warnings: string[] }`, `buildStatus(warnings: string[], now: Date): Status`, `writeStatus(path: string, status: Status): Promise<void>`, `HEALTHCHECK_MAX_AGE_MS = 180_000`, `isHealthy(text: string, now: number): boolean`

- [ ] **Step 1: Write the failing store test**

Create `hostd/src/shared/registry-store.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegistryStore, type RegistryFs } from './registry-store.ts'
import { RegistryError } from './registry.ts'

const good = 'projects:\n  site:\n    client: cl_1\n    name: Site\n    dir: /var/www/site\n    upstream: 127.0.0.1:5011\n    services: { web: { role: site } }\n'
const other = good.replace('name: Site', 'name: Renamed')

// A file whose contents, modification time and kind the test controls, counting reads.
function fakeFs(initial: { text: string, mtimeMs: number, isFile?: boolean }) {
    const state = { ...initial, isFile: initial.isFile ?? true, missing: false, reads: 0 }
    const fs: RegistryFs = {
        async stat() {
            if (state.missing) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
            return { mtimeMs: state.mtimeMs, isFile: () => state.isFile }
        },
        async readFile() {
            state.reads++
            return state.text
        },
    }
    return { fs, state }
}

describe('RegistryStore.load', () => {
    it('loads and exposes the registry', async () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/etc/hostd/projects.yaml', fs)
        await store.load()
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.deepEqual(store.warnings(), [])
    })

    it('names the usual first-run mistake when compose created a directory instead of the file', async () => {
        const { fs } = fakeFs({ text: '', mtimeMs: 1, isFile: false })
        const store = new RegistryStore('/etc/hostd/projects.yaml', fs)
        await assert.rejects(store.load(), (error: unknown) => {
            assert.ok(error instanceof RegistryError)
            assert.match(error.failures[0] ?? '', /is not a file \(was projects\.yaml created before the first docker compose up\?\)/)
            return true
        })
    })

    it('throws on a file that does not parse', async () => {
        const { fs } = fakeFs({ text: 'projects: [', mtimeMs: 1 })
        await assert.rejects(new RegistryStore('/p', fs).load(), RegistryError)
    })

    it('refuses current() before a load', () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1 })
        assert.throws(() => new RegistryStore('/p', fs).current(), /has not been loaded/)
    })
})

describe('RegistryStore.refresh', () => {
    it('does nothing, and reads nothing, while the modification time is unchanged', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        assert.equal(await store.refresh(), false)
        assert.equal(state.reads, 1)
    })

    it('takes a changed, valid file into effect', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: other, mtimeMs: 2 })
        assert.equal(await store.refresh(), true)
        assert.equal(store.current().projects.get('site')?.name, 'Renamed')
    })

    it('keeps the last good registry when an edit breaks the file, and says so', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        assert.equal(await store.refresh(), false)
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.match(store.warnings()[0] ?? '', /^registry reload rejected, still using the last good version: not valid YAML/)
    })

    it('does not re-parse a rejected file every poll', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        await store.refresh()
        assert.equal(state.reads, 2)
    })

    it('clears the warning once the file is fixed', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        Object.assign(state, { text: other, mtimeMs: 3 })
        assert.equal(await store.refresh(), true)
        assert.deepEqual(store.warnings(), [])
    })

    it('warns while the file is missing and reloads it when it returns, even with the old mtime', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        state.missing = true
        assert.equal(await store.refresh(), false)
        assert.match(store.warnings()[0] ?? '', /ENOENT/)
        state.missing = false
        assert.equal(await store.refresh(), true)
        assert.deepEqual(store.warnings(), [])
    })
})
```

- [ ] **Step 2: Write the failing status test**

Create `hostd/src/shared/status.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatus, writeStatus, isHealthy, HEALTHCHECK_MAX_AGE_MS } from './status.ts'

const now = new Date('2026-09-20T00:00:00.000Z')

describe('buildStatus', () => {
    it('is ok with no warnings', () => {
        assert.deepEqual(buildStatus([], now), { ok: true, checkedAt: '2026-09-20T00:00:00.000Z', warnings: [] })
    })

    it('is not ok with any warning', () => {
        assert.equal(buildStatus(['project x is invalid'], now).ok, false)
    })
})

describe('writeStatus', () => {
    it('writes the status where the healthcheck reads it, leaving no temporary file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hostd-status-'))
        try {
            const path = join(dir, 'status.json')
            await writeStatus(path, buildStatus([], now))
            assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), buildStatus([], now))
            await assert.rejects(readFile(`${path}.tmp`, 'utf8'))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

describe('isHealthy', () => {
    const fresh = JSON.stringify(buildStatus([], now))

    it('is healthy when ok and recent', () => {
        assert.equal(isHealthy(fresh, now.getTime() + 1000), true)
    })

    // A process that has hung stops writing. Without an age limit the last ok: true would stand forever.
    it('is unhealthy when the status has gone stale', () => {
        assert.equal(isHealthy(fresh, now.getTime() + HEALTHCHECK_MAX_AGE_MS), false)
    })

    it('is unhealthy when not ok, or when the file is not a status at all', () => {
        assert.equal(isHealthy(JSON.stringify(buildStatus(['x'], now)), now.getTime()), false)
        assert.equal(isHealthy('not json', now.getTime()), false)
        assert.equal(isHealthy('{}', now.getTime()), false)
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './registry-store.ts'` and `Cannot find module './status.ts'`.

- [ ] **Step 4: Implement the store**

Create `hostd/src/shared/registry-store.ts`:

```ts
// Holds the registry over time. The first load throws so the boot gate can name the failure; every later
// reload is forgiving, because an operator mid-edit must never take a running service down.

import { readFile, stat } from 'node:fs/promises'
import { parseRegistry, RegistryError, type Registry } from './registry.ts'
import { describeError } from './formats.ts'

export type RegistryFs = {
    stat(path: string): Promise<{ mtimeMs: number, isFile(): boolean }>
    readFile(path: string): Promise<string>
}

const nodeFs: RegistryFs = {
    stat: path => stat(path),
    readFile: path => readFile(path, 'utf8'),
}

export function explainRegistryError(error: unknown): string {
    return error instanceof RegistryError ? error.failures.join('; ') : describeError(error)
}

export class RegistryStore {
    private registry: Registry | null = null
    private loadedMtimeMs = -1
    private rejection: string | null = null

    constructor(private readonly path: string, private readonly fs: RegistryFs = nodeFs) {}

    async load(): Promise<Registry> {
        const info = await this.fs.stat(this.path)
        // Compose creates a directory when a bind-mounted file does not exist yet, so this is the usual
        // first-run mistake, and the message says how it happened.
        if (!info.isFile()) {
            throw new RegistryError([`${this.path} is not a file (was projects.yaml created before the first docker compose up?)`])
        }
        const registry = parseRegistry(await this.fs.readFile(this.path))
        this.registry = registry
        this.loadedMtimeMs = info.mtimeMs
        this.rejection = null
        return registry
    }

    async refresh(): Promise<boolean> {
        let info
        try {
            info = await this.fs.stat(this.path)
        } catch (error) {
            this.rejection = explainRegistryError(error)
            // Forget the mtime, so the file is re-read when it reappears even if its mtime did not change.
            this.loadedMtimeMs = -1
            return false
        }
        if (info.mtimeMs === this.loadedMtimeMs) return false
        // Recorded before parsing, so a rejected file is parsed once, not on every poll.
        this.loadedMtimeMs = info.mtimeMs
        try {
            if (!info.isFile()) throw new RegistryError([`${this.path} is not a file`])
            this.registry = parseRegistry(await this.fs.readFile(this.path))
            this.rejection = null
            return true
        } catch (error) {
            this.rejection = explainRegistryError(error)
            return false
        }
    }

    current(): Registry {
        if (!this.registry) throw new Error('the registry has not been loaded')
        return this.registry
    }

    warnings(): string[] {
        return this.rejection ? [`registry reload rejected, still using the last good version: ${this.rejection}`] : []
    }
}
```

- [ ] **Step 5: Implement the status module and the healthcheck script**

Create `hostd/src/shared/status.ts`:

```ts
// status.json, written by each process and read by its Docker healthcheck. Environmental problems never
// stop the service; they land here instead, so the operator sees them without anything going down.

import { writeFile, rename } from 'node:fs/promises'

export type Status = { ok: boolean, checkedAt: string, warnings: string[] }

// A process that hangs stops writing its status. Without an age limit its last ok: true would stand
// forever, which is the failure the mail stack's healthcheck had.
export const HEALTHCHECK_MAX_AGE_MS = 180_000

export function buildStatus(warnings: string[], now: Date): Status {
    return { ok: warnings.length === 0, checkedAt: now.toISOString(), warnings }
}

// Write then rename, so the healthcheck never reads a half-written file.
export async function writeStatus(path: string, status: Status): Promise<void> {
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(status, null, 2))
    await rename(temporary, path)
}

export function isHealthy(text: string, now: number): boolean {
    try {
        const status = JSON.parse(text) as Partial<Status>
        return status.ok === true
            && typeof status.checkedAt === 'string'
            && now - Date.parse(status.checkedAt) < HEALTHCHECK_MAX_AGE_MS
    } catch {
        return false
    }
}
```

Create `hostd/src/shared/healthcheck.ts`:

```ts
// The Docker healthcheck for both containers: exit 0 when the status file is ok and fresh.

import { readFileSync } from 'node:fs'
import { isHealthy } from './status.ts'

const path = process.argv[2] ?? '/tmp/hostd-status.json'
let text = ''
try {
    text = readFileSync(path, 'utf8')
} catch {
    process.exit(1)
}
process.exit(isHealthy(text, Date.now()) ? 0 : 1)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add hostd/src/shared/registry-store.ts hostd/src/shared/registry-store.test.ts hostd/src/shared/status.ts hostd/src/shared/status.test.ts hostd/src/shared/healthcheck.ts
git commit -m "Keep the last good registry through bad edits, and report health with an age limit"
```

---

### Task 4: The agent protocol

Defines every verb the agent accepts and parses a request line strictly: unknown verbs and unknown fields are refused. It also performs the structural check the agent applies to every project verb, whatever `api` says: the project is registered, valid, and has the capability for the verb.

**Files:**
- Create: `hostd/src/shared/protocol.ts`
- Test: `hostd/src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: from Task 1, `PROJECT_ID`, `SERVICE_NAME`, `isRecord`; from Task 2, `isComposeService`, `type Capability`, `type ProjectEntry`, `type Registry`.
- Produces:
  - `MAX_REQUEST_BYTES = 65536`, `MAX_TAIL = 5000`, `DEFAULT_TAIL = 200`, `LIFECYCLE_ACTIONS`, `type LifecycleAction = 'start' | 'stop' | 'restart'`
  - `type LogsArgs = { service: string, tail: number, since: number | null, follow: boolean }`
  - `type HealthRequest`, `StatusRequest`, `LifecycleRequest`, `LogsRequest`, `type ProjectRequest = StatusRequest | LifecycleRequest | LogsRequest`, `type AgentRequest = HealthRequest | ProjectRequest`, `type Verb`
  - `type RefusalCode = 'bad-request' | 'unknown-project' | 'invalid-project' | 'capability-disabled' | 'unknown-service' | 'busy' | 'failed' | 'unavailable'`
  - `type Refusal = { ok: false, code: RefusalCode, message: string, output?: string }`, `refuse(code, message, output?): Refusal`
  - `type ServiceStatus = { service: string, role: 'site' | 'database', state: string, health: string | null, startedAt: string | null, restartCount: number | null, image: string | null }`
  - `type HealthReply = { ok: true, warnings: string[], invalid: Record<string, string> }`, `type StatusReply = { ok: true, services: ServiceStatus[] }`, `type LifecycleReply = { ok: true, output: string }`, `type StreamHeader = { ok: true, stream: true }`, `type AgentReply = HealthReply | StatusReply | LifecycleReply | Refusal`
  - `type LogLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }`
  - `VERB_CAPABILITY: Record<Verb, Capability | null>`
  - `parseAgentRequest(line: string): { ok: true, request: AgentRequest } | Refusal`
  - `checkStructure(registry: Registry, request: ProjectRequest, guardInvalid: ReadonlyMap<string, string>): { ok: true, project: ProjectEntry } | Refusal`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/shared/protocol.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentRequest, checkStructure, MAX_REQUEST_BYTES, type ProjectRequest } from './protocol.ts'
import { parseRegistry } from './registry.ts'

function parsed(value: unknown) {
    return parseAgentRequest(JSON.stringify(value))
}

function refusalOf(value: unknown): string {
    const result = parsed(value)
    assert.equal(result.ok, false)
    return result.ok ? '' : `${result.code}: ${result.message}`
}

describe('parseAgentRequest', () => {
    it('parses every phase 1 verb', () => {
        assert.deepEqual(parsed({ verb: 'health' }), { ok: true, request: { verb: 'health' } })
        assert.deepEqual(parsed({ verb: 'status', project: 'acme' }), { ok: true, request: { verb: 'status', project: 'acme' } })
        assert.deepEqual(
            parsed({ verb: 'lifecycle', project: 'acme', args: { action: 'restart' } }),
            { ok: true, request: { verb: 'lifecycle', project: 'acme', args: { action: 'restart' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'logs', project: 'acme', args: { service: 'web', tail: 50, since: 1700000000.5, follow: true } }),
            { ok: true, request: { verb: 'logs', project: 'acme', args: { service: 'web', tail: 50, since: 1700000000.5, follow: true } } },
        )
    })

    it('defaults tail, since and follow for logs', () => {
        assert.deepEqual(
            parsed({ verb: 'logs', project: 'acme', args: { service: 'web' } }),
            { ok: true, request: { verb: 'logs', project: 'acme', args: { service: 'web', tail: 200, since: null, follow: false } } },
        )
    })

    it('refuses lines that are not JSON objects', () => {
        assert.deepEqual(parseAgentRequest('not json'), { ok: false, code: 'bad-request', message: 'request is not JSON' })
        assert.equal(refusalOf([1, 2]), 'bad-request: request must be a JSON object')
    })

    it('refuses an oversized request before parsing it', () => {
        const line = JSON.stringify({ verb: 'health', pad: 'x'.repeat(MAX_REQUEST_BYTES) })
        assert.deepEqual(parseAgentRequest(line), { ok: false, code: 'bad-request', message: 'request is too large' })
    })

    it('refuses verbs from later phases and anything unknown', () => {
        assert.equal(refusalOf({ verb: 'fs.write', project: 'acme' }), 'bad-request: unknown verb')
        assert.equal(refusalOf({ verb: 'exec', project: 'acme' }), 'bad-request: unknown verb')
    })

    // An unknown field is how a future caller would smuggle in a value the agent should derive itself,
    // such as a compose path.
    it('refuses unknown fields at every level', () => {
        assert.equal(refusalOf({ verb: 'health', project: 'acme' }), 'bad-request: health takes no other fields')
        assert.equal(refusalOf({ verb: 'status', project: 'acme', compose: '/etc/x.yml' }), 'bad-request: status takes only project')
        assert.equal(
            refusalOf({ verb: 'lifecycle', project: 'acme', args: { action: 'start', dir: '/' } }),
            'bad-request: lifecycle takes only args.action',
        )
        assert.equal(
            refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', container: 'abc' } }),
            'bad-request: logs takes only args.service, args.tail, args.since and args.follow',
        )
    })

    it('refuses malformed values', () => {
        assert.equal(refusalOf({ verb: 'status', project: '../acme' }), 'bad-request: project is malformed')
        assert.equal(refusalOf({ verb: 'lifecycle', project: 'acme', args: { action: 'down' } }), 'bad-request: action must be start, stop or restart')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'a/b' } }), 'bad-request: service is malformed')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', tail: 5001 } }), 'bad-request: tail must be a whole number from 0 to 5000')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', since: -1 } }), 'bad-request: since must be a non-negative number of seconds')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', follow: 'yes' } }), 'bad-request: follow must be true or false')
    })
})

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      appdb: { role: database, engine: sqlite, file: data/app.db }
    capabilities: [logs]
  broken:
    client: cl_1
`)

describe('checkStructure', () => {
    const status = (project: string): ProjectRequest => ({ verb: 'status', project })
    const none = new Map<string, string>()

    it('passes a registered, valid project and returns its entry', () => {
        const result = checkStructure(registry, status('acme'), none)
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.project.id, 'acme')
    })

    it('refuses an unregistered project', () => {
        assert.deepEqual(checkStructure(registry, status('ghost'), none), { ok: false, code: 'unknown-project', message: 'ghost is not registered' })
    })

    it('refuses a project the registry itself marked invalid', () => {
        const result = checkStructure(registry, status('broken'), none)
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'invalid-project')
    })

    it('refuses a project the storage guard marked invalid', () => {
        const result = checkStructure(registry, status('acme'), new Map([['acme', 'storage media overlaps a database mount']]))
        assert.deepEqual(result, { ok: false, code: 'invalid-project', message: 'acme is invalid: storage media overlaps a database mount' })
    })

    it('refuses a verb whose capability is switched off', () => {
        const result = checkStructure(registry, { verb: 'lifecycle', project: 'acme', args: { action: 'start' } }, none)
        assert.deepEqual(result, { ok: false, code: 'capability-disabled', message: 'lifecycle is not enabled for acme' })
    })

    it('refuses logs for an unknown service, a SQLite entry, or a prototype property name', () => {
        for (const service of ['ghost', 'appdb', 'constructor']) {
            const result = checkStructure(registry, { verb: 'logs', project: 'acme', args: { service, tail: 10, since: null, follow: false } }, none)
            assert.deepEqual(result, { ok: false, code: 'unknown-service', message: `${service} is not a registered service of acme` }, service)
        }
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './protocol.ts'`.

- [ ] **Step 3: Implement the protocol**

Create `hostd/src/shared/protocol.ts`:

```ts
// The only language the agent speaks. One JSON request line per connection, answered by one JSON line,
// or by a header line followed by a stream. Parsing is strict on purpose: the agent is root, so anything
// it does not recognise, including an extra field, is refused rather than ignored.

import { PROJECT_ID, SERVICE_NAME, isRecord } from './formats.ts'
import { isComposeService, type Capability, type ProjectEntry, type Registry } from './registry.ts'

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_TAIL = 5000
export const DEFAULT_TAIL = 200
export const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]

export type LogsArgs = { service: string, tail: number, since: number | null, follow: boolean }
export type HealthRequest = { verb: 'health' }
export type StatusRequest = { verb: 'status', project: string }
export type LifecycleRequest = { verb: 'lifecycle', project: string, args: { action: LifecycleAction } }
export type LogsRequest = { verb: 'logs', project: string, args: LogsArgs }
export type ProjectRequest = StatusRequest | LifecycleRequest | LogsRequest
export type AgentRequest = HealthRequest | ProjectRequest
export type Verb = AgentRequest['verb']

export type RefusalCode =
    | 'bad-request' | 'unknown-project' | 'invalid-project' | 'capability-disabled'
    | 'unknown-service' | 'busy' | 'failed' | 'unavailable'
export type Refusal = { ok: false, code: RefusalCode, message: string, output?: string }

export function refuse(code: RefusalCode, message: string, output?: string): Refusal {
    return output === undefined ? { ok: false, code, message } : { ok: false, code, message, output }
}

export type ServiceStatus = {
    service: string
    role: 'site' | 'database'
    state: string
    health: string | null
    startedAt: string | null
    restartCount: number | null
    image: string | null
}
export type HealthReply = { ok: true, warnings: string[], invalid: Record<string, string> }
export type StatusReply = { ok: true, services: ServiceStatus[] }
export type LifecycleReply = { ok: true, output: string }
export type StreamHeader = { ok: true, stream: true }
export type AgentReply = HealthReply | StatusReply | LifecycleReply | Refusal
export type LogLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }

// Status is visible to anyone who may see the project at all; everything else needs its capability.
export const VERB_CAPABILITY: Record<Verb, Capability | null> = {
    health: null,
    status: null,
    lifecycle: 'lifecycle',
    logs: 'logs',
}

type Parsed = { ok: true, request: AgentRequest } | Refusal

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function projectOf(raw: Record<string, unknown>): string | null {
    return typeof raw.project === 'string' && PROJECT_ID.test(raw.project) ? raw.project : null
}

function parseLogsArgs(args: unknown): LogsArgs | Refusal {
    if (!isRecord(args) || !onlyKeys(args, ['service', 'tail', 'since', 'follow'])) {
        return refuse('bad-request', 'logs takes only args.service, args.tail, args.since and args.follow')
    }
    if (typeof args.service !== 'string' || !SERVICE_NAME.test(args.service)) return refuse('bad-request', 'service is malformed')
    const tail = args.tail === undefined ? DEFAULT_TAIL : args.tail
    if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 0 || tail > MAX_TAIL) {
        return refuse('bad-request', `tail must be a whole number from 0 to ${MAX_TAIL}`)
    }
    const since = args.since === undefined || args.since === null ? null : args.since
    if (since !== null && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) {
        return refuse('bad-request', 'since must be a non-negative number of seconds')
    }
    const follow = args.follow === undefined ? false : args.follow
    if (typeof follow !== 'boolean') return refuse('bad-request', 'follow must be true or false')
    return { service: args.service, tail, since: since as number | null, follow }
}

export function parseAgentRequest(line: string): Parsed {
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return refuse('bad-request', 'request is too large')
    let raw: unknown
    try {
        raw = JSON.parse(line)
    } catch {
        return refuse('bad-request', 'request is not JSON')
    }
    if (!isRecord(raw)) return refuse('bad-request', 'request must be a JSON object')

    switch (raw.verb) {
        case 'health':
            if (!onlyKeys(raw, ['verb'])) return refuse('bad-request', 'health takes no other fields')
            return { ok: true, request: { verb: 'health' } }

        case 'status': {
            if (!onlyKeys(raw, ['verb', 'project'])) return refuse('bad-request', 'status takes only project')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            return { ok: true, request: { verb: 'status', project } }
        }

        case 'lifecycle': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'lifecycle takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            if (!isRecord(raw.args) || !onlyKeys(raw.args, ['action'])) return refuse('bad-request', 'lifecycle takes only args.action')
            const action = raw.args.action
            if (typeof action !== 'string' || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
                return refuse('bad-request', 'action must be start, stop or restart')
            }
            return { ok: true, request: { verb: 'lifecycle', project, args: { action: action as LifecycleAction } } }
        }

        case 'logs': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'logs takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseLogsArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'logs', project, args } }
        }

        default:
            return refuse('bad-request', 'unknown verb')
    }
}

// The agent's own check, applied to every project verb regardless of what api decided. It cannot know
// who the actor is, so ownership is not here; everything that depends only on the registry is.
export function checkStructure(
    registry: Registry,
    request: ProjectRequest,
    guardInvalid: ReadonlyMap<string, string>,
): { ok: true, project: ProjectEntry } | Refusal {
    const id = request.project
    const registryProblem = registry.invalid.get(id)
    if (registryProblem !== undefined) return refuse('invalid-project', `${id} is invalid: ${registryProblem}`)
    const project = registry.projects.get(id)
    if (!project) return refuse('unknown-project', `${id} is not registered`)
    const guardProblem = guardInvalid.get(id)
    if (guardProblem !== undefined) return refuse('invalid-project', `${id} is invalid: ${guardProblem}`)

    const capability = VERB_CAPABILITY[request.verb]
    if (capability && !project.capabilities.has(capability)) return refuse('capability-disabled', `${capability} is not enabled for ${id}`)

    if (request.verb === 'logs') {
        const service = request.args.service
        const entry = Object.hasOwn(project.services, service) ? project.services[service] : undefined
        if (!entry || !isComposeService(entry)) return refuse('unknown-service', `${service} is not a registered service of ${id}`)
    }
    return { ok: true, project }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts
git commit -m "Define the agent's verbs and refuse anything outside them"
```

---

### Task 5: Compose commands and the storage guard

Everything the agent runs through the `docker` CLI, and the storage guard computed from the output of `docker compose config`. The guard enforces the rule that makes file access (phase 3) safe: a client can never write a file that compose reads.

**Files:**
- Create: `hostd/src/agent/compose.ts`
- Create: `hostd/src/agent/guard.ts`
- Test: `hostd/src/agent/compose.test.ts`
- Test: `hostd/src/agent/guard.test.ts`

**Interfaces:**
- Consumes: from Task 1, `isRecord`, `isWithin`, `overlaps`; from Task 2, `isComposeService`, `type ProjectEntry`; from Task 4, `type LifecycleAction`.
- Produces:
  - `LIFECYCLE_TIMEOUT_MS = 120_000`, `CONFIG_TIMEOUT_MS = 30_000`, `OUTPUT_TAIL_BYTES = 4096`
  - `composeBase(project: ProjectEntry): string[]`, `lifecycleArgv(project: ProjectEntry, action: LifecycleAction): string[]`, `configArgv(project: ProjectEntry): string[]`
  - `type RunResult = { exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }`
  - `type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>`
  - `createSpawnRunner(spawn?: typeof import('node:child_process').spawn): Runner`
  - `tail(text: string, bytes?: number): string`
  - `type LifecycleResult = { ok: true, output: string } | { ok: false, message: string, output: string }`, `runLifecycle(project, action, run: Runner): Promise<LifecycleResult>`
  - `type ResolvedCompose = { name: string, services: Record<string, ResolvedService> }`, `type ResolvedService = { volumes?: Array<{ type?: string, source?: string }>, env_file?: Array<string | { path?: string }>, build?: string | { context?: string, dockerfile?: string } }`
  - `resolveCompose(project, run: Runner): Promise<{ ok: true, resolved: ResolvedCompose } | { ok: false, problem: string }>`
  - `guardProblems(project: ProjectEntry, resolved: ResolvedCompose): string[]`

### A further difference from the spec

The spec's storage guard says a storage directory must neither contain nor be contained by anything compose reads. The "contained by" half cannot apply to a build context: nearly every real project uses `build: .`, which makes the context the whole site directory, and every storage directory sits inside it. Taken literally, the rule would mark almost every project invalid. It would also protect little. Lifecycle actions run with `--no-build`, so hostd never reads a build context; only the operator's own manual builds do, and what a client could plant there reaches only that client's own image. The dangerous case is the reverse, a storage directory that contains the context, the Dockerfile, the compose file or an env file, because then the client would be writing the build instructions or the container configuration themselves. So the guard checks one direction only: **a storage directory must not contain anything compose reads.** Overlap with a database mount is still checked in both directions.

- [ ] **Step 1: Write the failing compose test**

Create `hostd/src/agent/compose.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn as nodeSpawn } from 'node:child_process'
import {
    lifecycleArgv, configArgv, runLifecycle, resolveCompose, createSpawnRunner, tail,
    LIFECYCLE_TIMEOUT_MS, OUTPUT_TAIL_BYTES, type Runner, type RunResult,
} from './compose.ts'
import { parseRegistry } from '../shared/registry.ts'

const project = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
`).projects.get('acme')!

function runnerReturning(result: Partial<RunResult>) {
    const calls: Array<{ command: string, args: string[], timeoutMs: number }> = []
    const run: Runner = async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result }
    }
    return { run, calls }
}

describe('argv', () => {
    const base = ['compose', '--project-directory', '/var/www/acme', '-f', '/var/www/acme/docker-compose.yml']

    // up rather than start, so a start also works after a down or a reboot; never builds or pulls, so a
    // start cannot fetch anything new.
    it('starts with up, never building or pulling', () => {
        assert.deepEqual(lifecycleArgv(project, 'start'), [...base, 'up', '-d', '--no-build', '--pull', 'never'])
    })

    it('stops and restarts in place', () => {
        assert.deepEqual(lifecycleArgv(project, 'stop'), [...base, 'stop'])
        assert.deepEqual(lifecycleArgv(project, 'restart'), [...base, 'restart'])
    })

    it('resolves the configuration as JSON', () => {
        assert.deepEqual(configArgv(project), [...base, 'config', '--format', 'json'])
    })
})

describe('runLifecycle', () => {
    it('runs docker with the lifecycle argv and timeout', async () => {
        const { run, calls } = runnerReturning({ stderr: 'Container acme-web-1 Started' })
        const result = await runLifecycle(project, 'start', run)
        assert.deepEqual(result, { ok: true, output: 'Container acme-web-1 Started' })
        assert.deepEqual(calls, [{ command: 'docker', args: lifecycleArgv(project, 'start'), timeoutMs: LIFECYCLE_TIMEOUT_MS }])
    })

    it('reports a non-zero exit with the output', async () => {
        const { run } = runnerReturning({ exitCode: 1, stderr: 'no such image' })
        assert.deepEqual(await runLifecycle(project, 'start', run), { ok: false, message: 'start exited with code 1', output: 'no such image' })
    })

    it('reports a timeout', async () => {
        const { run } = runnerReturning({ exitCode: null, timedOut: true })
        assert.deepEqual(await runLifecycle(project, 'restart', run), { ok: false, message: 'restart timed out after 120 seconds', output: '' })
    })

    it('reports a command that could not run at all', async () => {
        const { run } = runnerReturning({ exitCode: null, stderr: 'spawn docker ENOENT' })
        assert.deepEqual(await runLifecycle(project, 'stop', run), { ok: false, message: 'stop could not run', output: 'spawn docker ENOENT' })
    })

    it('keeps only the last 4 KB of output', async () => {
        const { run } = runnerReturning({ stdout: 'x'.repeat(10_000) + 'END' })
        const result = await runLifecycle(project, 'stop', run)
        assert.equal(Buffer.byteLength(result.output), OUTPUT_TAIL_BYTES)
        assert.ok(result.output.endsWith('END'))
    })
})

describe('tail', () => {
    it('returns short text unchanged', () => {
        assert.equal(tail('abc', 10), 'abc')
    })

    it('keeps the end of long text', () => {
        assert.equal(tail('abcdef', 3), 'def')
    })
})

describe('resolveCompose', () => {
    it('parses the resolved configuration', async () => {
        const { run, calls } = runnerReturning({ stdout: JSON.stringify({ name: 'acme', services: { web: {} } }) })
        assert.deepEqual(await resolveCompose(project, run), { ok: true, resolved: { name: 'acme', services: { web: {} } } })
        assert.deepEqual(calls[0]?.args, configArgv(project))
    })

    it('reports a failing compose config with its stderr', async () => {
        const { run } = runnerReturning({ exitCode: 1, stderr: 'yaml: line 3: mapping values are not allowed' })
        assert.deepEqual(await resolveCompose(project, run), {
            ok: false, problem: 'docker compose config failed: yaml: line 3: mapping values are not allowed',
        })
    })

    it('reports output that is not a compose configuration', async () => {
        for (const stdout of ['not json', '{"services":{}}', '{"name":"acme"}']) {
            const { run } = runnerReturning({ stdout })
            assert.deepEqual(await resolveCompose(project, run), { ok: false, problem: 'docker compose config returned unreadable output' }, stdout)
        }
    })

    it('reports a timeout', async () => {
        const { run } = runnerReturning({ exitCode: null, timedOut: true })
        assert.deepEqual(await resolveCompose(project, run), { ok: false, problem: 'docker compose config timed out' })
    })
})

type FakeChild = EventEmitter & { stdout: PassThrough, stderr: PassThrough, killedWith: string | null, kill(signal: string): boolean }

function fakeSpawn(behaviour: (child: FakeChild) => void) {
    const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
    const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options })
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            killedWith: null as string | null,
            kill(signal: string) {
                child.killedWith = signal
                setImmediate(() => child.emit('close', null))
                return true
            },
        })
        setImmediate(() => behaviour(child))
        return child
    }) as unknown as typeof nodeSpawn
    return { spawn, calls }
}

describe('createSpawnRunner', () => {
    it('never uses a shell and captures stdout and the exit code', async () => {
        const { spawn, calls } = fakeSpawn(child => {
            child.stdout.once('end', () => child.emit('close', 0))
            child.stdout.end('hello')
        })
        const result = await createSpawnRunner(spawn)('docker', ['compose', 'ls'], 1000)
        assert.deepEqual(result, { exitCode: 0, stdout: 'hello', stderr: '', timedOut: false })
        assert.equal(calls[0]?.options.shell, false)
        assert.deepEqual(calls[0]?.args, ['compose', 'ls'])
    })

    it('reports a spawn failure as a null exit code with the error', async () => {
        const { spawn } = fakeSpawn(child => child.emit('error', new Error('spawn docker ENOENT')))
        const result = await createSpawnRunner(spawn)('docker', [], 1000)
        assert.deepEqual(result, { exitCode: null, stdout: '', stderr: 'spawn docker ENOENT', timedOut: false })
    })

    it('kills a command that outlives its timeout', async () => {
        let spawned: FakeChild | null = null
        const { spawn } = fakeSpawn(child => { spawned = child })
        const result = await createSpawnRunner(spawn)('docker', [], 20)
        assert.equal(result.timedOut, true)
        assert.equal((spawned as FakeChild | null)?.killedWith, 'SIGKILL')
    })
})
```

- [ ] **Step 2: Write the failing guard test**

Create `hostd/src/agent/guard.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardProblems } from './guard.ts'
import type { ResolvedCompose } from './compose.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'

function entry(extra = '', compose = 'docker-compose.yml'): ProjectEntry {
    const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    compose: ${compose}
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
      appdb: { role: database, engine: sqlite, file: sqlite/app.db }
    storage:
      media: { path: uploads, mode: rw }
${extra}`)
    const project = registry.projects.get('acme')
    assert.ok(project, JSON.stringify([...registry.invalid]))
    return project
}

const bind = (source: string) => ({ type: 'bind', source, target: '/x' })

function resolved(overrides: Partial<ResolvedCompose['services']> = {}, name = 'acme'): ResolvedCompose {
    return {
        name,
        services: {
            web: { volumes: [bind('/var/www/acme/uploads'), { type: 'volume', source: 'cache' }], build: { context: '/var/www/acme', dockerfile: 'Dockerfile' } },
            db: { volumes: [bind('/var/www/acme/db')], env_file: [{ path: '/var/www/acme/db.env' }] },
            ...overrides,
        } as ResolvedCompose['services'],
    }
}

describe('guardProblems', () => {
    it('passes a project whose storage is a site bind mount and nothing compose reads', () => {
        assert.deepEqual(guardProblems(entry(), resolved()), [])
    })

    // A start with a different project name would create a second copy of the site beside the running one.
    it('refuses a project whose compose name differs from the registry id', () => {
        assert.deepEqual(guardProblems(entry(), resolved({}, 'acme-old')), [
            'compose resolves the project name acme-old, not acme; set name: acme in the compose file, or rename the registry entry',
        ])
    })

    it('refuses a registered service that is not in the compose file, but not a SQLite entry', () => {
        const { db: _db, ...withoutDb } = resolved().services
        assert.deepEqual(guardProblems(entry(), { name: 'acme', services: withoutDb }), ['service db is not in the compose file'])
    })

    it('refuses storage that is not bind-mounted into a site service', () => {
        const problems = guardProblems(entry(), resolved({ web: { volumes: [] } }))
        assert.deepEqual(problems, ['storage media (/var/www/acme/uploads) is not bind-mounted into a site service'])
    })

    // Must-exist test 2 (spec, Testing strategy): the storage guard.
    describe('must-exist: storage that would expose a database or anything compose reads', () => {
        it('refuses storage mounted into a database service as well', () => {
            const problems = guardProblems(entry(), resolved({ db: { volumes: [bind('/var/www/acme/uploads')] } }))
            assert.deepEqual(problems, ['storage media overlaps a database service\'s mount'])
        })

        it('refuses storage inside a database mount', () => {
            const problems = guardProblems(entry(), resolved({ db: { volumes: [bind('/var/www/acme')] } }))
            assert.ok(problems.includes('storage media overlaps a database service\'s mount'), problems.join('\n'))
        })

        it('refuses storage that contains the compose file', () => {
            const problems = guardProblems(
                entry('', 'uploads/docker-compose.yml'),
                resolved(),
            )
            assert.deepEqual(problems, ['storage media contains /var/www/acme/uploads/docker-compose.yml, which compose reads'])
        })

        it('refuses storage that contains an env_file, in either of compose\'s spellings', () => {
            for (const envFile of ['/var/www/acme/uploads/.env.web', { path: '/var/www/acme/uploads/.env.web' }]) {
                const problems = guardProblems(entry(), resolved({
                    web: { volumes: [bind('/var/www/acme/uploads')], env_file: [envFile] },
                }))
                assert.deepEqual(problems, ['storage media contains /var/www/acme/uploads/.env.web, which compose reads'], JSON.stringify(envFile))
            }
        })

        it('refuses storage that contains a build context or a Dockerfile', () => {
            assert.deepEqual(
                guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: { context: '/var/www/acme/uploads/app' } } })),
                ['storage media contains /var/www/acme/uploads/app, which compose reads'],
            )
            assert.deepEqual(
                guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: { context: '/var/www/acme', dockerfile: 'uploads/Dockerfile' } } })),
                ['storage media contains /var/www/acme/uploads/Dockerfile, which compose reads'],
            )
        })
    })

    // The deliberate difference from the spec, recorded above: storage inside a build context is allowed.
    it('allows storage inside a build context, the usual build: . layout', () => {
        assert.deepEqual(guardProblems(entry(), resolved()), [])
    })

    it('ignores a build context that is a URL rather than a path', () => {
        const problems = guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: 'https://github.com/example/app.git' } }))
        assert.deepEqual(problems, [])
    })

    it('treats a trailing slash on a bind source as the same directory', () => {
        assert.deepEqual(guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads/')] } })), [])
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './compose.ts'` and `Cannot find module './guard.ts'`.

- [ ] **Step 4: Implement the compose module**

Create `hostd/src/agent/compose.ts`:

```ts
// Everything the agent runs through the docker CLI. Every argv is built here from registry values only,
// and every spawn is shell-free, so no value from a request can ever reach a command line.

import { spawn as nodeSpawn } from 'node:child_process'
import { isRecord } from '../shared/formats.ts'
import type { ProjectEntry } from '../shared/registry.ts'
import type { LifecycleAction } from '../shared/protocol.ts'

export const LIFECYCLE_TIMEOUT_MS = 120_000
export const CONFIG_TIMEOUT_MS = 30_000
export const OUTPUT_TAIL_BYTES = 4096
// A resolved compose file is tens of kilobytes. Anything near this is not one, and must not grow unbounded.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

const LIFECYCLE_ARGS: Record<LifecycleAction, string[]> = {
    start: ['up', '-d', '--no-build', '--pull', 'never'],
    stop: ['stop'],
    restart: ['restart'],
}

export function composeBase(project: ProjectEntry): string[] {
    return ['compose', '--project-directory', project.dir, '-f', project.composePath]
}

export function lifecycleArgv(project: ProjectEntry, action: LifecycleAction): string[] {
    return [...composeBase(project), ...LIFECYCLE_ARGS[action]]
}

export function configArgv(project: ProjectEntry): string[] {
    return [...composeBase(project), 'config', '--format', 'json']
}

export type RunResult = { exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }
export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>

// Keeps the most recent bytes only, so a chatty command cannot exhaust memory.
class Capture {
    private chunks: Buffer[] = []
    private size = 0

    add(chunk: Buffer): void {
        this.chunks.push(chunk)
        this.size += chunk.length
        if (this.size > 2 * MAX_CAPTURE_BYTES) {
            const joined = Buffer.concat(this.chunks)
            const kept = joined.subarray(joined.length - MAX_CAPTURE_BYTES)
            this.chunks = [kept]
            this.size = kept.length
        }
    }

    text(): string {
        const joined = Buffer.concat(this.chunks)
        return joined.subarray(Math.max(0, joined.length - MAX_CAPTURE_BYTES)).toString('utf8')
    }
}

export function createSpawnRunner(spawn: typeof nodeSpawn = nodeSpawn): Runner {
    return (command, args, timeoutMs) => new Promise(resolve => {
        const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
        const stdout = new Capture()
        const stderr = new Capture()
        child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
        child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))

        let timedOut = false
        let settled = false
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, timeoutMs)

        const finish = (exitCode: number | null, error?: string) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            const errorText = stderr.text()
            resolve({ exitCode, stdout: stdout.text(), stderr: error ? (errorText ? `${errorText}\n${error}` : error) : errorText, timedOut })
        }
        child.on('error', error => finish(null, error.message))
        child.on('close', code => finish(code))
    })
}

export function tail(text: string, bytes = OUTPUT_TAIL_BYTES): string {
    const buffer = Buffer.from(text)
    return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString('utf8')
}

export type LifecycleResult = { ok: true, output: string } | { ok: false, message: string, output: string }

export async function runLifecycle(project: ProjectEntry, action: LifecycleAction, run: Runner): Promise<LifecycleResult> {
    const result = await run('docker', lifecycleArgv(project, action), LIFECYCLE_TIMEOUT_MS)
    // Compose writes its progress to stderr, so both streams are the output.
    const output = tail([result.stdout, result.stderr].filter(text => text !== '').join('\n'))
    if (result.timedOut) return { ok: false, message: `${action} timed out after ${LIFECYCLE_TIMEOUT_MS / 1000} seconds`, output }
    if (result.exitCode === null) return { ok: false, message: `${action} could not run`, output }
    if (result.exitCode !== 0) return { ok: false, message: `${action} exited with code ${result.exitCode}`, output }
    return { ok: true, output }
}

export type ResolvedService = {
    volumes?: Array<{ type?: string, source?: string }>
    env_file?: Array<string | { path?: string }>
    build?: string | { context?: string, dockerfile?: string }
}
export type ResolvedCompose = { name: string, services: Record<string, ResolvedService> }

export async function resolveCompose(
    project: ProjectEntry,
    run: Runner,
): Promise<{ ok: true, resolved: ResolvedCompose } | { ok: false, problem: string }> {
    const result = await run('docker', configArgv(project), CONFIG_TIMEOUT_MS)
    if (result.timedOut) return { ok: false, problem: 'docker compose config timed out' }
    if (result.exitCode !== 0) return { ok: false, problem: `docker compose config failed: ${tail(result.stderr.trim(), 500)}` }
    try {
        const parsed: unknown = JSON.parse(result.stdout)
        if (!isRecord(parsed) || typeof parsed.name !== 'string' || !isRecord(parsed.services)) throw new Error('shape')
        return { ok: true, resolved: parsed as ResolvedCompose }
    } catch {
        return { ok: false, problem: 'docker compose config returned unreadable output' }
    }
}
```

- [ ] **Step 5: Implement the guard**

Create `hostd/src/agent/guard.ts`:

```ts
// The storage guard. Checked against compose's own resolved configuration, so includes, extends and
// relative paths are all accounted for. Its central rule: a client must never be able to write a file
// that compose reads, because editing one and pressing start is root on the dedi.

import { posix } from 'node:path'
import { isWithin, overlaps } from '../shared/formats.ts'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ResolvedCompose, ResolvedService } from './compose.ts'

function withoutTrailingSlash(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function bindSources(service: ResolvedService): string[] {
    return (service.volumes ?? [])
        .filter(volume => volume.type === 'bind' && typeof volume.source === 'string')
        .map(volume => withoutTrailingSlash(volume.source as string))
}

// Everything compose reads for this service: env files, the build context and the Dockerfile. Contexts
// that are URLs (a git repository) are not on this disk, so they cannot be written by a client.
function readsOf(service: ResolvedService): string[] {
    const reads: string[] = []
    for (const envFile of service.env_file ?? []) {
        const path = typeof envFile === 'string' ? envFile : envFile.path
        if (typeof path === 'string') reads.push(path)
    }
    const build = typeof service.build === 'string' ? { context: service.build } : service.build
    if (build?.context?.startsWith('/')) {
        const context = withoutTrailingSlash(build.context)
        reads.push(context)
        if (build.dockerfile) reads.push(build.dockerfile.startsWith('/') ? build.dockerfile : posix.join(context, build.dockerfile))
    }
    return reads
}

export function guardProblems(project: ProjectEntry, resolved: ResolvedCompose): string[] {
    const problems: string[] = []
    if (resolved.name !== project.id) {
        problems.push(`compose resolves the project name ${resolved.name}, not ${project.id}; set name: ${project.id} in the compose file, or rename the registry entry`)
    }

    const siteSources: string[] = []
    const databaseSources: string[] = []
    for (const [name, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry)) continue
        const service = Object.hasOwn(resolved.services, name) ? resolved.services[name] : undefined
        if (!service) {
            problems.push(`service ${name} is not in the compose file`)
            continue
        }
        if (entry.role === 'site') siteSources.push(...bindSources(service))
        else databaseSources.push(...bindSources(service))
    }

    const reads = [project.composePath, posix.join(project.dir, '.env')]
    for (const service of Object.values(resolved.services)) reads.push(...readsOf(service))

    for (const [name, storage] of Object.entries(project.storage)) {
        if (!siteSources.includes(storage.absolute)) {
            problems.push(`storage ${name} (${storage.absolute}) is not bind-mounted into a site service`)
        }
        if (databaseSources.some(source => overlaps(source, storage.absolute))) {
            problems.push(`storage ${name} overlaps a database service's mount`)
        }
        for (const read of reads) {
            if (isWithin(storage.absolute, read)) problems.push(`storage ${name} contains ${read}, which compose reads`)
        }
    }
    return problems
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add hostd/src/agent/compose.ts hostd/src/agent/compose.test.ts hostd/src/agent/guard.ts hostd/src/agent/guard.test.ts
git commit -m "Run compose with fixed argv and refuse storage that exposes what compose reads"
```

---

### Task 6: Log stream decoding

Turns the bytes of Docker's log endpoint into `LogLine`s. For containers without a TTY, Docker interleaves stdout and stderr in framed chunks; for containers with one, it sends a plain stream. Lines are capped at 16 KB, and the timestamp Docker prefixes to every line is split out.

**Files:**
- Create: `hostd/src/agent/logframes.ts`
- Test: `hostd/src/agent/logframes.test.ts`

**Interfaces:**
- Consumes: from Task 4, `type LogLine`.
- Produces: `MAX_LINE_BYTES = 16384`, `MAX_FRAME_BYTES`, `class FrameDecoder { push(chunk: Buffer): Array<{ stream: 'stdout' | 'stderr', data: Buffer }> }`, `class LineSplitter { constructor(stream, timestamps: boolean); push(data: Buffer): LogLine[]; flush(): LogLine[] }`, `type LogDecoder = { push(chunk: Buffer): LogLine[], flush(): LogLine[] }`, `createLogDecoder(tty: boolean, timestamps?: boolean): LogDecoder`.

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/logframes.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FrameDecoder, createLogDecoder, MAX_LINE_BYTES, MAX_FRAME_BYTES } from './logframes.ts'

function frame(type: number, text: string | Buffer): Buffer {
    const payload = typeof text === 'string' ? Buffer.from(text) : text
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
}

const TS = '2026-09-20T01:02:03.123456789Z'

describe('FrameDecoder', () => {
    it('decodes one frame', () => {
        const frames = new FrameDecoder().push(frame(1, 'hello\n'))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stdout', 'hello\n']])
    })

    it('decodes several frames in one chunk, keeping stdout and stderr apart', () => {
        const frames = new FrameDecoder().push(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stdout', 'out\n'], ['stderr', 'err\n']])
    })

    it('waits for a frame split across chunks, including a split header', () => {
        const whole = frame(2, 'split frame\n')
        const decoder = new FrameDecoder()
        assert.deepEqual(decoder.push(whole.subarray(0, 5)), [])
        assert.deepEqual(decoder.push(whole.subarray(5, 12)), [])
        const frames = decoder.push(whole.subarray(12))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stderr', 'split frame\n']])
    })

    it('ignores stdin frames', () => {
        assert.deepEqual(new FrameDecoder().push(frame(0, 'typed\n')), [])
    })

    it('refuses a frame length no log line could have', () => {
        const header = Buffer.alloc(8)
        header[0] = 1
        header.writeUInt32BE(MAX_FRAME_BYTES + 1, 4)
        assert.throws(() => new FrameDecoder().push(header), /is larger than/)
    })
})

describe('createLogDecoder without a TTY', () => {
    it('splits timestamped lines into their parts', () => {
        const lines = createLogDecoder(false).push(frame(1, `${TS} GET / 200\n`))
        assert.deepEqual(lines, [{ stream: 'stdout', ts: TS, text: 'GET / 200', truncated: false }])
    })

    it('joins a line that spans frames', () => {
        const decoder = createLogDecoder(false)
        assert.deepEqual(decoder.push(frame(1, `${TS} first half `)), [])
        assert.deepEqual(decoder.push(frame(1, 'second half\n')), [{ stream: 'stdout', ts: TS, text: 'first half second half', truncated: false }])
    })

    it('keeps partial lines of each stream separate', () => {
        const decoder = createLogDecoder(false)
        const lines = decoder.push(Buffer.concat([frame(1, `${TS} out `), frame(2, `${TS} err\n`), frame(1, 'done\n')]))
        assert.deepEqual(lines.map(l => [l.stream, l.text]), [['stderr', 'err'], ['stdout', 'out done']])
    })

    it('strips a carriage return', () => {
        assert.equal(createLogDecoder(false).push(frame(1, `${TS} windows\r\n`))[0]?.text, 'windows')
    })

    it('caps a line at 16 KB, marks it truncated, and carries on normally', () => {
        const decoder = createLogDecoder(false, false)
        const lines = decoder.push(frame(1, `${'x'.repeat(MAX_LINE_BYTES + 100)}\nnext\n`))
        assert.equal(lines.length, 2)
        assert.equal(Buffer.byteLength(lines[0]?.text ?? ''), MAX_LINE_BYTES)
        assert.equal(lines[0]?.truncated, true)
        assert.deepEqual(lines[1], { stream: 'stdout', ts: null, text: 'next', truncated: false })
    })

    it('flushes a final line with no newline', () => {
        const decoder = createLogDecoder(false)
        decoder.push(frame(2, `${TS} last words`))
        assert.deepEqual(decoder.flush(), [{ stream: 'stderr', ts: TS, text: 'last words', truncated: false }])
    })

    it('flushes nothing when nothing is pending', () => {
        assert.deepEqual(createLogDecoder(false).flush(), [])
    })

    it('leaves text without a timestamp alone', () => {
        assert.deepEqual(createLogDecoder(false).push(frame(1, 'no stamp\n')), [{ stream: 'stdout', ts: null, text: 'no stamp', truncated: false }])
    })
})

describe('createLogDecoder with a TTY', () => {
    it('reads the stream raw, as stdout, with no frame headers', () => {
        const lines = createLogDecoder(true).push(Buffer.from(`${TS} interactive\n`))
        assert.deepEqual(lines, [{ stream: 'stdout', ts: TS, text: 'interactive', truncated: false }])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './logframes.ts'`.

- [ ] **Step 3: Implement the decoder**

Create `hostd/src/agent/logframes.ts`:

```ts
// Docker's log stream for a container without a TTY is multiplexed: each frame is an 8-byte header (the
// stream type, three zero bytes, a big-endian payload length) followed by the payload. Frames split
// lines at arbitrary points and socket chunks split frames at arbitrary points, so both layers buffer.

import type { LogLine } from '../shared/protocol.ts'

type StreamName = LogLine['stream']

export const MAX_LINE_BYTES = 16 * 1024
// No log frame is anywhere near this. A length this large means the bytes are not what we think they are,
// and buffering towards it would exhaust memory.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\S+) ([\s\S]*)$/

export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0)

    push(chunk: Buffer): Array<{ stream: StreamName, data: Buffer }> {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
        const frames: Array<{ stream: StreamName, data: Buffer }> = []
        while (this.buffer.length >= 8) {
            const type = this.buffer[0]
            const size = this.buffer.readUInt32BE(4)
            if (size > MAX_FRAME_BYTES) throw new Error(`log frame of ${size} bytes is larger than ${MAX_FRAME_BYTES}`)
            if (this.buffer.length < 8 + size) break
            const data = this.buffer.subarray(8, 8 + size)
            this.buffer = this.buffer.subarray(8 + size)
            if (type === 1) frames.push({ stream: 'stdout', data })
            else if (type === 2) frames.push({ stream: 'stderr', data })
        }
        return frames
    }
}

export class LineSplitter {
    private parts: Buffer[] = []
    private size = 0
    private truncated = false

    constructor(private readonly stream: StreamName, private readonly timestamps: boolean) {}

    push(data: Buffer): LogLine[] {
        const lines: LogLine[] = []
        let start = 0
        let newline = data.indexOf(0x0a, start)
        while (newline !== -1) {
            this.append(data.subarray(start, newline))
            lines.push(this.finish())
            start = newline + 1
            newline = data.indexOf(0x0a, start)
        }
        this.append(data.subarray(start))
        return lines
    }

    flush(): LogLine[] {
        return this.size > 0 || this.truncated ? [this.finish()] : []
    }

    private append(part: Buffer): void {
        const room = MAX_LINE_BYTES - this.size
        let kept = part
        if (kept.length > room) {
            this.truncated = true
            kept = kept.subarray(0, room)
        }
        if (kept.length > 0) {
            this.parts.push(kept)
            this.size += kept.length
        }
    }

    private finish(): LogLine {
        let text = Buffer.concat(this.parts).toString('utf8')
        if (text.endsWith('\r')) text = text.slice(0, -1)
        let ts: string | null = null
        if (this.timestamps) {
            const match = text.match(TIMESTAMP)
            if (match && match[1] !== undefined && match[2] !== undefined) {
                ts = match[1]
                text = match[2]
            }
        }
        const line: LogLine = { stream: this.stream, ts, text, truncated: this.truncated }
        this.parts = []
        this.size = 0
        this.truncated = false
        return line
    }
}

export type LogDecoder = { push(chunk: Buffer): LogLine[], flush(): LogLine[] }

export function createLogDecoder(tty: boolean, timestamps = true): LogDecoder {
    const stdout = new LineSplitter('stdout', timestamps)
    if (tty) return { push: chunk => stdout.push(chunk), flush: () => stdout.flush() }

    const stderr = new LineSplitter('stderr', timestamps)
    const frames = new FrameDecoder()
    return {
        push: chunk => frames.push(chunk).flatMap(frame => (frame.stream === 'stdout' ? stdout : stderr).push(frame.data)),
        flush: () => [...stdout.flush(), ...stderr.flush()],
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/logframes.ts hostd/src/agent/logframes.test.ts
git commit -m "Decode Docker's framed log stream into capped, timestamped lines"
```

---

### Task 7: The Docker Engine API client

A minimal client over the Docker socket: ping, list a project's containers, inspect one, and open its log stream. That is everything phase 1 needs from the daemon. Lifecycle actions go through the compose CLI (Task 5), not this client. The pure parts (paths, choosing a container per service, mapping to `ServiceStatus`) are tested directly. The HTTP layer is tested through an injected request function, so the tests need no Docker and run on any platform.

**Files:**
- Create: `hostd/src/agent/docker.ts`
- Test: `hostd/src/agent/docker.test.ts`

**Interfaces:**
- Consumes: from Task 2, `isComposeService`, `type ProjectEntry`; from Task 4, `type ServiceStatus`.
- Produces:
  - `DOCKER_SOCKET = '/var/run/docker.sock'`, `DOCKER_TIMEOUT_MS = 15_000`
  - `type ContainerSummary = { Id: string, State: string, Labels?: Record<string, string> }`
  - `type ContainerInspect = { Id: string, RestartCount: number, Config: { Tty: boolean, Image: string }, State: { Status: string, StartedAt: string, Health?: { Status: string } } }`
  - `type LogsOptions = { tail: number, since: number | null, follow: boolean }`
  - `type DockerApi = { ping(): Promise<boolean>, listProjectContainers(project: string): Promise<ContainerSummary[]>, inspect(id: string): Promise<ContainerInspect>, logs(id: string, options: LogsOptions): Promise<Readable> }`
  - `containersPath(project: string): string`, `logsPath(id: string, options: LogsOptions): string`, `checkedId(id: string): string`
  - `createDockerApi(socketPath?: string, request?: RequestFn): DockerApi`
  - `pickPerService(containers: ContainerSummary[]): Map<string, ContainerSummary>`
  - `buildServiceStatuses(project: ProjectEntry, inspected: ReadonlyMap<string, ContainerInspect>): ServiceStatus[]`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/docker.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import {
    containersPath, logsPath, checkedId, createDockerApi, pickPerService, buildServiceStatuses,
    type ContainerInspect, type ContainerSummary,
} from './docker.ts'
import { parseRegistry } from '../shared/registry.ts'

const ID = 'a'.repeat(64)

describe('paths', () => {
    it('filters containers by the compose project label', () => {
        const path = containersPath('acme')
        assert.ok(path.startsWith('/containers/json?all=1&filters='))
        const filters = JSON.parse(decodeURIComponent(path.split('filters=')[1] ?? ''))
        assert.deepEqual(filters, { label: ['com.docker.compose.project=acme'] })
    })

    it('asks for timestamped stdout and stderr with the requested tail, since and follow', () => {
        const query = new URLSearchParams(logsPath(ID, { tail: 50, since: 1700000000.5, follow: true }).split('?')[1])
        assert.deepEqual(Object.fromEntries(query), { stdout: '1', stderr: '1', timestamps: '1', tail: '50', follow: '1', since: '1700000000.5' })
    })

    it('omits since when there is none', () => {
        assert.equal(logsPath(ID, { tail: 0, since: null, follow: false }).includes('since'), false)
    })

    it('refuses to put anything but a container id into a path', () => {
        assert.equal(checkedId(ID), ID)
        for (const id of ['../../info', 'abc', 'A'.repeat(64)]) assert.throws(() => checkedId(id), /malformed container id/, id)
    })
})

// Stands in for http.request: records the options and answers with the given status and body.
function fakeRequest(status: number, body: string, fail?: Error) {
    const calls: RequestOptions[] = []
    const request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
        calls.push(options)
        const req = Object.assign(new EventEmitter(), {
            setTimeout() { return req },
            destroy() { return req },
            end() {
                setImmediate(() => {
                    if (fail) {
                        req.emit('error', fail)
                        return
                    }
                    const response = Object.assign(new PassThrough(), { statusCode: status })
                    callback(response as unknown as IncomingMessage)
                    response.end(body)
                })
                return req
            },
        })
        return req as unknown as ClientRequest
    }
    return { request, calls }
}

describe('createDockerApi', () => {
    it('talks to the socket it was given', async () => {
        const { request, calls } = fakeRequest(200, '[]')
        await createDockerApi('/var/run/docker.sock', request).listProjectContainers('acme')
        assert.equal(calls[0]?.socketPath, '/var/run/docker.sock')
        assert.equal(calls[0]?.path, containersPath('acme'))
        assert.equal(calls[0]?.method, 'GET')
    })

    it('parses JSON answers', async () => {
        const { request } = fakeRequest(200, JSON.stringify({ Id: ID }))
        assert.deepEqual(await createDockerApi('/s', request).inspect(ID), { Id: ID })
    })

    it('turns a non-200 answer into an error naming the endpoint', async () => {
        const { request } = fakeRequest(404, '{"message":"No such container"}')
        await assert.rejects(createDockerApi('/s', request).inspect(ID), /Docker API \/containers\/a+\/json answered 404/)
    })

    it('pings true on 200 and false when the socket is not there', async () => {
        assert.equal(await createDockerApi('/s', fakeRequest(200, 'OK').request).ping(), true)
        assert.equal(await createDockerApi('/s', fakeRequest(0, '', new Error('connect ENOENT')).request).ping(), false)
    })

    it('returns the log response as a stream', async () => {
        const { request } = fakeRequest(200, 'bytes')
        const stream = await createDockerApi('/s', request).logs(ID, { tail: 10, since: null, follow: false })
        let text = ''
        for await (const chunk of stream) text += String(chunk)
        assert.equal(text, 'bytes')
    })
})

describe('pickPerService', () => {
    it('keys containers by compose service and prefers a running one', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'exited', Labels: { 'com.docker.compose.service': 'web' } },
            { Id: '2', State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
            { Id: '3', State: 'running', Labels: { 'com.docker.compose.service': 'db' } },
            { Id: '4', State: 'running' },
        ]
        const picked = pickPerService(containers)
        assert.deepEqual([...picked].map(([service, c]) => [service, c.Id]), [['web', '2'], ['db', '3']])
    })
})

describe('buildServiceStatuses', () => {
    const project = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
      appdb: { role: database, engine: sqlite, file: data/app.db }
`).projects.get('acme')!

    const running: ContainerInspect = {
        Id: ID,
        RestartCount: 2,
        Config: { Tty: false, Image: 'acme-web:latest' },
        State: { Status: 'running', StartedAt: '2026-09-20T00:00:00Z', Health: { Status: 'healthy' } },
    }

    it('reports every registered compose service in registry order, missing ones included', () => {
        const statuses = buildServiceStatuses(project, new Map([['web', running]]))
        assert.deepEqual(statuses, [
            { service: 'web', role: 'site', state: 'running', health: 'healthy', startedAt: '2026-09-20T00:00:00Z', restartCount: 2, image: 'acme-web:latest' },
            { service: 'db', role: 'database', state: 'missing', health: null, startedAt: null, restartCount: null, image: null },
        ])
    })

    it('reports no health when there is no healthcheck, and no start time for a never-started container', () => {
        const created: ContainerInspect = { ...running, RestartCount: 0, State: { Status: 'created', StartedAt: '0001-01-01T00:00:00Z' } }
        const [web] = buildServiceStatuses(project, new Map([['web', created]]))
        assert.equal(web?.health, null)
        assert.equal(web?.startedAt, null)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './docker.ts'`.

- [ ] **Step 3: Implement the client**

Create `hostd/src/agent/docker.ts`:

```ts
// A minimal Docker Engine API client over the Unix socket: ping, list, inspect and logs, and nothing
// else. Lifecycle goes through the compose CLI, so this client never creates, starts or execs anything.

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import type { Readable } from 'node:stream'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'

export const DOCKER_SOCKET = '/var/run/docker.sock'
export const DOCKER_TIMEOUT_MS = 15_000
const CONTAINER_ID = /^[a-f0-9]{12,64}$/
// What Docker reports as the start time of a container that has never started.
const NEVER = '0001-01-01T00:00:00Z'

export type ContainerSummary = { Id: string, State: string, Labels?: Record<string, string> }
export type ContainerInspect = {
    Id: string
    RestartCount: number
    Config: { Tty: boolean, Image: string }
    State: { Status: string, StartedAt: string, Health?: { Status: string } }
}
export type LogsOptions = { tail: number, since: number | null, follow: boolean }

export type DockerApi = {
    ping(): Promise<boolean>
    listProjectContainers(project: string): Promise<ContainerSummary[]>
    inspect(id: string): Promise<ContainerInspect>
    logs(id: string, options: LogsOptions): Promise<Readable>
}

type RequestFn = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest

export function containersPath(project: string): string {
    const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] })
    return `/containers/json?all=1&filters=${encodeURIComponent(filters)}`
}

// Container ids come from Docker itself, but they are still checked before going into a URL path.
export function checkedId(id: string): string {
    if (!CONTAINER_ID.test(id)) throw new Error(`refusing malformed container id ${JSON.stringify(id.slice(0, 80))}`)
    return id
}

export function logsPath(id: string, options: LogsOptions): string {
    const query = new URLSearchParams({
        stdout: '1',
        stderr: '1',
        timestamps: '1',
        tail: String(options.tail),
        follow: options.follow ? '1' : '0',
    })
    if (options.since !== null) query.set('since', String(options.since))
    return `/containers/${checkedId(id)}/logs?${query}`
}

const endpoint = (path: string) => path.split('?')[0]

export function createDockerApi(socketPath = DOCKER_SOCKET, request: RequestFn = httpRequest): DockerApi {
    function open(path: string, timeoutMs: number | null): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = request({ socketPath, path, method: 'GET' }, resolve)
            req.on('error', reject)
            if (timeoutMs !== null) req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timed out on ${endpoint(path)}`)))
            req.end()
        })
    }

    async function json<T>(path: string): Promise<T> {
        const response = await open(path, DOCKER_TIMEOUT_MS)
        response.setEncoding('utf8')
        let body = ''
        for await (const chunk of response) body += chunk
        if (response.statusCode !== 200) throw new Error(`Docker API ${endpoint(path)} answered ${response.statusCode}: ${body.slice(0, 200)}`)
        return JSON.parse(body) as T
    }

    return {
        async ping() {
            try {
                const response = await open('/_ping', DOCKER_TIMEOUT_MS)
                response.resume()
                return response.statusCode === 200
            } catch {
                return false
            }
        },
        listProjectContainers: project => json<ContainerSummary[]>(containersPath(project)),
        inspect: id => json<ContainerInspect>(`/containers/${checkedId(id)}/json`),
        // No timeout: a followed stream is legitimately idle for long stretches. The agent bounds its life.
        async logs(id, options) {
            const response = await open(logsPath(id, options), null)
            if (response.statusCode !== 200) {
                response.resume()
                throw new Error(`Docker API logs answered ${response.statusCode}`)
            }
            return response
        },
    }
}

// Compose labels every container with its service. With several for one service (scaled, or a leftover
// from an old run), the running one is the one the client means.
export function pickPerService(containers: ContainerSummary[]): Map<string, ContainerSummary> {
    const chosen = new Map<string, ContainerSummary>()
    for (const container of containers) {
        const service = container.Labels?.['com.docker.compose.service']
        if (!service) continue
        const current = chosen.get(service)
        if (!current || (current.State !== 'running' && container.State === 'running')) chosen.set(service, container)
    }
    return chosen
}

export function buildServiceStatuses(project: ProjectEntry, inspected: ReadonlyMap<string, ContainerInspect>): ServiceStatus[] {
    const statuses: ServiceStatus[] = []
    for (const [service, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry)) continue
        const info = inspected.get(service)
        if (!info) {
            statuses.push({ service, role: entry.role, state: 'missing', health: null, startedAt: null, restartCount: null, image: null })
            continue
        }
        statuses.push({
            service,
            role: entry.role,
            state: info.State.Status,
            health: info.State.Health?.Status ?? null,
            startedAt: info.State.StartedAt === NEVER ? null : info.State.StartedAt,
            restartCount: info.RestartCount,
            image: info.Config.Image,
        })
    }
    return statuses
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/docker.ts hostd/src/agent/docker.test.ts
git commit -m "Read container status and logs from the Docker socket, and nothing more"
```

---

### Task 8: Agent handlers and the socket server

The agent's verb handlers, and the server that runs one request per Unix socket connection. This is where the spec's first must-exist test lives: the agent refuses an unregistered project, an invalid one, or a switched-off capability **even when `api` asks**, and neither compose nor Docker is ever called in those cases.

**Files:**
- Create: `hostd/src/agent/agent.ts`
- Create: `hostd/src/agent/server.ts`
- Test: `hostd/src/agent/agent.test.ts`
- Test: `hostd/src/agent/server.test.ts`

**Interfaces:**
- Consumes: from Task 2, `type ProjectEntry`, `type Registry`, `parseRegistry` (tests); from Task 4, `checkStructure`, `refuse`, `parseAgentRequest`, `MAX_REQUEST_BYTES` and the request, reply and `LogLine` types; from Task 5, `runLifecycle`, `lifecycleArgv` (tests), `type Runner`; from Task 6, `createLogDecoder`; from Task 7, `pickPerService`, `buildServiceStatuses`, `type DockerApi`, `type ContainerInspect`.
- Produces:
  - `MAX_FOLLOWS_PER_PROJECT = 4`, `FOLLOW_MAX_MS = 3_600_000`
  - `type AgentDeps = { registry: () => Registry, guardInvalid: () => ReadonlyMap<string, string>, warnings: () => string[], docker: DockerApi, runner: Runner, recheck: (project: ProjectEntry) => Promise<string | null>, followMaxMs?: number }`
  - `type Outcome = { kind: 'reply', reply: HealthReply | StatusReply | LifecycleReply | Refusal } | { kind: 'stream', lines: AsyncIterable<LogLine>, close: () => void }`
  - `class Agent { constructor(deps: AgentDeps); handle(request: AgentRequest): Promise<Outcome>; followCount(project: string): number }`
  - `type AgentHandler = { handle(request: AgentRequest): Promise<Outcome> }`
  - `readRequestLine(input: Readable, maxBytes?: number): Promise<string | null>`
  - `handleConnection(socket: Duplex, agent: AgentHandler, log: (message: string) => void): Promise<void>`

- [ ] **Step 1: Write the failing agent test**

Create `hostd/src/agent/agent.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Agent, MAX_FOLLOWS_PER_PROJECT, type AgentDeps, type Outcome } from './agent.ts'
import { lifecycleArgv, type Runner, type RunResult } from './compose.ts'
import type { ContainerInspect, DockerApi } from './docker.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { AgentRequest, LogLine } from '../shared/protocol.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    capabilities: [lifecycle, logs]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  broken:
    client: cl_1
`)

const WEB = 'a'.repeat(64)
const inspectWeb: ContainerInspect = {
    Id: WEB,
    RestartCount: 0,
    Config: { Tty: false, Image: 'acme-web' },
    State: { Status: 'running', StartedAt: '2026-09-20T00:00:00Z' },
}

function frame(text: string): Buffer {
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(Buffer.byteLength(text), 4)
    return Buffer.concat([header, Buffer.from(text)])
}

type SetupOptions = Partial<Omit<AgentDeps, 'guardInvalid'>> & {
    runResult?: Partial<RunResult>
    guardInvalid?: Map<string, string>
    containers?: boolean
}

function setup(options: SetupOptions = {}) {
    // The test-only knobs are taken out first, so only real AgentDeps fields are spread into deps.
    const { runResult, guardInvalid, containers, ...overrides } = options
    const runs: Array<{ command: string, args: string[] }> = []
    const rechecked: string[] = []
    const logStreams: PassThrough[] = []
    const runner: Runner = async (command, args) => {
        runs.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: 'done', timedOut: false, ...runResult }
    }
    const docker: DockerApi = {
        ping: async () => true,
        listProjectContainers: async () => containers === false ? [] : [{ Id: WEB, State: 'running', Labels: { 'com.docker.compose.service': 'web' } }],
        inspect: async () => inspectWeb,
        logs: async () => {
            const stream = new PassThrough()
            logStreams.push(stream)
            return stream
        },
    }
    const deps: AgentDeps = {
        registry: () => registry,
        guardInvalid: () => guardInvalid ?? new Map(),
        warnings: () => [],
        docker,
        runner,
        recheck: async (project: ProjectEntry) => {
            rechecked.push(project.id)
            return null
        },
        ...overrides,
    }
    return { agent: new Agent(deps), runs, rechecked, logStreams }
}

function replyOf(outcome: Outcome) {
    assert.equal(outcome.kind, 'reply')
    return outcome.kind === 'reply' ? outcome.reply : null
}

const lifecycle = (project: string, action: 'start' | 'stop' | 'restart' = 'start'): AgentRequest => ({ verb: 'lifecycle', project, args: { action } })
const logs = (follow: boolean, project = 'acme'): AgentRequest => ({ verb: 'logs', project, args: { service: 'web', tail: 10, since: null, follow } })

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
    const out: LogLine[] = []
    for await (const line of lines) out.push(line)
    return out
}

// Must-exist test 1 (spec, Testing strategy): the agent enforces the registry itself.
describe('must-exist: the agent refuses when api itself asks', () => {
    it('refuses an unregistered project without touching compose', async () => {
        const { agent, runs, rechecked } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('ghost'))), { ok: false, code: 'unknown-project', message: 'ghost is not registered' })
        assert.deepEqual(runs, [])
        assert.deepEqual(rechecked, [])
    })

    it('refuses a project the registry marked invalid', async () => {
        const { agent, runs } = setup()
        const reply = replyOf(await agent.handle(lifecycle('broken')))
        assert.equal(reply?.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(runs, [])
    })

    it('refuses a project the storage guard marked invalid', async () => {
        const { agent, runs } = setup({ guardInvalid: new Map([['acme', 'storage media overlaps a database service\'s mount']]) })
        const reply = replyOf(await agent.handle(lifecycle('acme')))
        assert.equal(reply?.ok === false && reply.code, 'invalid-project')
        assert.deepEqual(runs, [])
    })

    it('refuses a verb whose capability is off', async () => {
        const { agent, runs } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('quiet'))), { ok: false, code: 'capability-disabled', message: 'lifecycle is not enabled for quiet' })
        const reply = replyOf(await agent.handle(logs(false, 'quiet')))
        assert.equal(reply?.ok === false && reply.code, 'capability-disabled')
        assert.deepEqual(runs, [])
    })
})

describe('lifecycle', () => {
    it('re-runs the storage guard before a start, then runs compose from the registry entry', async () => {
        const { agent, runs, rechecked } = setup()
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'start'))), { ok: true, output: 'done' })
        assert.deepEqual(rechecked, ['acme'])
        assert.deepEqual(runs, [{ command: 'docker', args: lifecycleArgv(registry.projects.get('acme')!, 'start') }])
    })

    // Stopping reads no mounts, so a project whose guard has just failed can still be stopped.
    it('does not re-run the guard before a stop', async () => {
        const { agent, rechecked } = setup()
        await agent.handle(lifecycle('acme', 'stop'))
        assert.deepEqual(rechecked, [])
    })

    it('refuses to start when the re-run guard finds a problem', async () => {
        const { agent, runs } = setup({ recheck: async () => 'storage media contains /var/www/acme/uploads/.env, which compose reads' })
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'restart'))), {
            ok: false, code: 'invalid-project', message: 'storage media contains /var/www/acme/uploads/.env, which compose reads',
        })
        assert.deepEqual(runs, [])
    })

    it('reports a failed command with its output', async () => {
        const { agent } = setup({ runResult: { exitCode: 1, stderr: 'no such image' } })
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme'))), { ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
    })

    it('allows one lifecycle action per project at a time', async () => {
        let release: () => void = () => {}
        const blocked = new Promise<void>(resolve => { release = resolve })
        const { agent } = setup({
            runner: async () => {
                await blocked
                return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
            },
        })
        const first = agent.handle(lifecycle('acme'))
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(replyOf(await agent.handle(lifecycle('acme', 'stop'))), { ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        release()
        assert.equal(replyOf(await first)?.ok, true)
        assert.equal(replyOf(await agent.handle(lifecycle('acme', 'stop')))?.ok, true)
    })
})

describe('status and health', () => {
    it('reports each registered service', async () => {
        const { agent } = setup()
        assert.deepEqual(replyOf(await agent.handle({ verb: 'status', project: 'acme' })), {
            ok: true,
            services: [
                { service: 'web', role: 'site', state: 'running', health: null, startedAt: '2026-09-20T00:00:00Z', restartCount: 0, image: 'acme-web' },
                { service: 'db', role: 'database', state: 'missing', health: null, startedAt: null, restartCount: null, image: null },
            ],
        })
    })

    it('reports warnings and every invalid project, from the registry and from the guard', async () => {
        const { agent } = setup({ guardInvalid: new Map([['acme', 'guard problem']]), warnings: () => ['registry reload rejected'] })
        const reply = replyOf(await agent.handle({ verb: 'health' }))
        assert.ok(reply && reply.ok && 'invalid' in reply)
        assert.deepEqual(reply.warnings, ['registry reload rejected'])
        assert.equal(reply.invalid.acme, 'guard problem')
        assert.ok(reply.invalid.broken)
    })
})

describe('logs', () => {
    it('streams decoded lines until Docker ends the stream', async () => {
        const { agent, logStreams } = setup()
        const outcome = await agent.handle(logs(false))
        assert.equal(outcome.kind, 'stream')
        if (outcome.kind !== 'stream') return
        logStreams[0]?.end(frame('2026-09-20T00:00:00Z hello\n'))
        assert.deepEqual(await collect(outcome.lines), [{ stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }])
    })

    it('says so when the service has no container at all', async () => {
        const { agent } = setup({ containers: false })
        assert.deepEqual(replyOf(await agent.handle(logs(false))), { ok: false, code: 'unavailable', message: 'web has no container; has acme been started?' })
    })

    it('allows four follow streams per project and frees a slot when one closes', async () => {
        const { agent } = setup()
        const open: Outcome[] = []
        for (let i = 0; i < MAX_FOLLOWS_PER_PROJECT; i++) open.push(await agent.handle(logs(true)))
        assert.deepEqual(replyOf(await agent.handle(logs(true))), { ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
        const first = open[0]
        assert.ok(first && first.kind === 'stream')
        first.close()
        assert.equal(agent.followCount('acme'), MAX_FOLLOWS_PER_PROJECT - 1)
        assert.equal((await agent.handle(logs(true))).kind, 'stream')
    })

    it('does not count a non-follow read against the limit', async () => {
        const { agent } = setup()
        await agent.handle(logs(false))
        assert.equal(agent.followCount('acme'), 0)
    })

    it('ends a follow stream on its own after the maximum duration, freeing its slot', async () => {
        const { agent } = setup({ followMaxMs: 20 })
        const outcome = await agent.handle(logs(true))
        assert.ok(outcome.kind === 'stream')
        assert.deepEqual(await collect(outcome.lines), [])
        assert.equal(agent.followCount('acme'), 0)
    })
})
```

- [ ] **Step 2: Write the failing server test**

Create `hostd/src/agent/server.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair } from 'node:stream'
import { handleConnection, type AgentHandler } from './server.ts'
import type { AgentRequest, LogLine } from '../shared/protocol.ts'
import { MAX_REQUEST_BYTES } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: null, text: 'hello', truncated: false }

function stubAgent(handle: AgentHandler['handle']): AgentHandler & { requests: AgentRequest[] } {
    const requests: AgentRequest[] = []
    return {
        requests,
        handle: async request => {
            requests.push(request)
            return handle(request)
        },
    }
}

// Sends raw bytes as the client and returns every line the server wrote before closing.
async function exchange(agent: AgentHandler, raw: string): Promise<string[]> {
    const [client, server] = duplexPair()
    const logged: string[] = []
    const done = handleConnection(server, agent, message => logged.push(message))
    client.write(raw)
    client.setEncoding('utf8')
    let text = ''
    for await (const chunk of client) text += chunk
    await done
    return text.split('\n').filter(part => part !== '')
}

describe('handleConnection', () => {
    it('answers a request with one JSON line and closes', async () => {
        const agent = stubAgent(async () => ({ kind: 'reply', reply: { ok: true, warnings: [], invalid: {} } }))
        assert.deepEqual(await exchange(agent, '{"verb":"health"}\n'), ['{"ok":true,"warnings":[],"invalid":{}}'])
        assert.deepEqual(agent.requests, [{ verb: 'health' }])
    })

    it('refuses a malformed request without calling the agent', async () => {
        const agent = stubAgent(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(agent, '{"verb":"exec","project":"acme"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'unknown verb' })
        assert.deepEqual(agent.requests, [])
    })

    it('refuses a request line longer than the limit', async () => {
        const agent = stubAgent(async () => { throw new Error('must not be called') })
        const [reply] = await exchange(agent, 'x'.repeat(MAX_REQUEST_BYTES + 10))
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'bad-request', message: 'expected one request line of at most 64 KB' })
    })

    it('reports an agent error as unavailable rather than dropping the connection', async () => {
        const agent = stubAgent(async () => { throw new Error('connect ENOENT /var/run/docker.sock') })
        const [reply] = await exchange(agent, '{"verb":"status","project":"acme"}\n')
        assert.deepEqual(JSON.parse(reply ?? ''), { ok: false, code: 'unavailable', message: 'connect ENOENT /var/run/docker.sock' })
    })

    it('streams a header then one JSON line per log line', async () => {
        const agent = stubAgent(async () => ({
            kind: 'stream',
            lines: (async function* () { yield line; yield { ...line, text: 'again' } })(),
            close: () => {},
        }))
        const lines = await exchange(agent, '{"verb":"logs","project":"acme","args":{"service":"web"}}\n')
        assert.deepEqual(lines.map(l => JSON.parse(l)), [{ ok: true, stream: true }, line, { ...line, text: 'again' }])
    })

    it('closes the stream when the client goes away', async () => {
        let closed = false
        let wake: () => void = () => {}
        const agent = stubAgent(async () => ({
            kind: 'stream',
            lines: (async function* () {
                yield line
                await new Promise<void>(resolve => { wake = resolve })
            })(),
            close: () => {
                closed = true
                wake()
            },
        }))
        const [client, server] = duplexPair()
        const done = handleConnection(server, agent, () => {})
        client.write('{"verb":"logs","project":"acme","args":{"service":"web","follow":true}}\n')
        client.setEncoding('utf8')
        let text = ''
        await new Promise<void>(resolve => {
            client.on('data', (chunk: string) => {
                text += chunk
                if (text.split('\n').length > 2) resolve()
            })
        })
        client.end()
        await done
        assert.equal(closed, true)
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './agent.ts'` and `Cannot find module './server.ts'`.

- [ ] **Step 4: Implement the handlers**

Create `hostd/src/agent/agent.ts`:

```ts
// The agent's verb handlers. Every project verb passes the structural check first, whatever api decided,
// and every value that reaches compose or Docker comes from the registry entry that check returned.

import {
    checkStructure, refuse,
    type AgentRequest, type HealthReply, type LifecycleAction, type LifecycleReply, type LogLine,
    type LogsArgs, type Refusal, type ServiceStatus, type StatusReply,
} from '../shared/protocol.ts'
import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { runLifecycle, type Runner } from './compose.ts'
import { buildServiceStatuses, pickPerService, type ContainerInspect, type DockerApi } from './docker.ts'
import { createLogDecoder } from './logframes.ts'

export const MAX_FOLLOWS_PER_PROJECT = 4
export const FOLLOW_MAX_MS = 60 * 60_000

export type AgentDeps = {
    registry: () => Registry
    guardInvalid: () => ReadonlyMap<string, string>
    warnings: () => string[]
    docker: DockerApi
    runner: Runner
    // Re-runs the storage guard for one project: its problem, or null when it passes.
    recheck: (project: ProjectEntry) => Promise<string | null>
    followMaxMs?: number
}

export type Outcome =
    | { kind: 'reply', reply: HealthReply | StatusReply | LifecycleReply | Refusal }
    | { kind: 'stream', lines: AsyncIterable<LogLine>, close: () => void }

const reply = (value: HealthReply | StatusReply | LifecycleReply | Refusal): Outcome => ({ kind: 'reply', reply: value })

export class Agent {
    private readonly lifecycleBusy = new Set<string>()
    private readonly follows = new Map<string, number>()

    constructor(private readonly deps: AgentDeps) {}

    followCount(project: string): number {
        return this.follows.get(project) ?? 0
    }

    async handle(request: AgentRequest): Promise<Outcome> {
        if (request.verb === 'health') return reply(this.health())
        const checked = checkStructure(this.deps.registry(), request, this.deps.guardInvalid())
        if (!checked.ok) return reply(checked)
        switch (request.verb) {
            case 'status':
                return reply({ ok: true, services: await this.status(checked.project) })
            case 'lifecycle':
                return reply(await this.lifecycle(checked.project, request.args.action))
            case 'logs':
                return this.logs(checked.project, request.args)
        }
    }

    private health(): HealthReply {
        const invalid = Object.fromEntries([...this.deps.registry().invalid, ...this.deps.guardInvalid()])
        return { ok: true, warnings: this.deps.warnings(), invalid }
    }

    private async status(project: ProjectEntry): Promise<ServiceStatus[]> {
        const chosen = pickPerService(await this.deps.docker.listProjectContainers(project.id))
        const inspected = new Map<string, ContainerInspect>()
        for (const [service, container] of chosen) {
            if (Object.hasOwn(project.services, service)) inspected.set(service, await this.deps.docker.inspect(container.Id))
        }
        return buildServiceStatuses(project, inspected)
    }

    private async lifecycle(project: ProjectEntry, action: LifecycleAction): Promise<LifecycleReply | Refusal> {
        if (this.lifecycleBusy.has(project.id)) return refuse('busy', `${project.id} already has a lifecycle action running`)
        this.lifecycleBusy.add(project.id)
        try {
            // Start and restart read the compose file and its mounts, so the guard is re-run first: the
            // operator can edit a compose file without touching the registry. Stop reads no mounts, and a
            // project whose guard has just failed must still be stoppable.
            if (action !== 'stop') {
                const problem = await this.deps.recheck(project)
                if (problem) return refuse('invalid-project', problem)
            }
            const result = await runLifecycle(project, action, this.deps.runner)
            return result.ok ? { ok: true, output: result.output } : refuse('failed', result.message, result.output)
        } finally {
            this.lifecycleBusy.delete(project.id)
        }
    }

    private async logs(project: ProjectEntry, args: LogsArgs): Promise<Outcome> {
        // The slot is taken before any await, so two requests arriving together cannot both see a free one.
        if (args.follow) {
            if (this.followCount(project.id) >= MAX_FOLLOWS_PER_PROJECT) {
                return reply(refuse('busy', `${project.id} already has ${MAX_FOLLOWS_PER_PROJECT} log streams open`))
            }
            this.follows.set(project.id, this.followCount(project.id) + 1)
        }
        let released = false
        const release = () => {
            if (released || !args.follow) return
            released = true
            const remaining = this.followCount(project.id) - 1
            if (remaining > 0) this.follows.set(project.id, remaining)
            else this.follows.delete(project.id)
        }

        try {
            const container = pickPerService(await this.deps.docker.listProjectContainers(project.id)).get(args.service)
            if (!container) {
                release()
                return reply(refuse('unavailable', `${args.service} has no container; has ${project.id} been started?`))
            }
            const info = await this.deps.docker.inspect(container.Id)
            const source = await this.deps.docker.logs(container.Id, { tail: args.tail, since: args.since, follow: args.follow })
            const decoder = createLogDecoder(info.Config.Tty)

            let closing = false
            const close = () => {
                closing = true
                release()
                source.destroy()
            }
            // A follow stream is bounded, so an abandoned one cannot hold a slot and a socket forever. The
            // portal reconnects with since=<last timestamp>.
            const timer = args.follow ? setTimeout(close, this.deps.followMaxMs ?? FOLLOW_MAX_MS) : null
            timer?.unref()

            async function* lines(): AsyncGenerator<LogLine> {
                try {
                    for await (const chunk of source) yield* decoder.push(chunk as Buffer)
                    yield* decoder.flush()
                } catch (error) {
                    // Destroying the source on purpose surfaces as a premature close; that is the end we asked for.
                    if (!closing) throw error
                } finally {
                    if (timer) clearTimeout(timer)
                    release()
                }
            }
            return { kind: 'stream', lines: lines(), close }
        } catch (error) {
            release()
            throw error
        }
    }
}
```

- [ ] **Step 5: Implement the server**

Create `hostd/src/agent/server.ts`:

```ts
// One request per connection on the agent's Unix socket: read a single JSON line, dispatch it, and write
// either one JSON line or a header line followed by one JSON line per log line. Every verb the agent
// executes is logged to stdout, a record api cannot reach or rewrite.

import type { Duplex, Readable } from 'node:stream'
import { parseAgentRequest, refuse, MAX_REQUEST_BYTES, type AgentRequest } from '../shared/protocol.ts'
import { describeError } from '../shared/formats.ts'
import type { Outcome } from './agent.ts'

export type AgentHandler = { handle(request: AgentRequest): Promise<Outcome> }

// Resolves with the first line, or null if the peer sends more than maxBytes without a newline or leaves.
export function readRequestLine(input: Readable, maxBytes = MAX_REQUEST_BYTES): Promise<string | null> {
    return new Promise(resolve => {
        const chunks: Buffer[] = []
        let size = 0
        const finish = (value: string | null) => {
            input.off('data', onData)
            input.off('end', onEnd)
            input.off('error', onEnd)
            resolve(value)
        }
        const onData = (chunk: Buffer | string) => {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
            const newline = bytes.indexOf(0x0a)
            if (newline !== -1) {
                chunks.push(bytes.subarray(0, newline))
                size += newline
                finish(size > maxBytes ? null : Buffer.concat(chunks).toString('utf8'))
                return
            }
            chunks.push(bytes)
            size += bytes.length
            if (size > maxBytes) finish(null)
        }
        const onEnd = () => finish(null)
        input.on('data', onData)
        input.on('end', onEnd)
        input.on('error', onEnd)
    })
}

function describe(request: AgentRequest): string {
    switch (request.verb) {
        case 'health': return 'health'
        case 'status': return `status ${request.project}`
        case 'lifecycle': return `lifecycle ${request.project} ${request.args.action}`
        case 'logs': return `logs ${request.project} ${request.args.service}${request.args.follow ? ' follow' : ''}`
    }
}

function waitForDrain(socket: Duplex): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            socket.off('drain', done)
            socket.off('close', done)
            resolve()
        }
        socket.on('drain', done)
        socket.on('close', done)
    })
}

const lineOf = (value: unknown) => `${JSON.stringify(value)}\n`

export async function handleConnection(socket: Duplex, agent: AgentHandler, log: (message: string) => void): Promise<void> {
    socket.on('error', () => socket.destroy())
    const line = await readRequestLine(socket)
    // Anything after the request line is ignored, but the socket keeps reading so the peer leaving is seen.
    socket.resume()
    if (line === null) {
        log('refused bad-request: no request line')
        socket.end(lineOf(refuse('bad-request', 'expected one request line of at most 64 KB')))
        return
    }

    const parsed = parseAgentRequest(line)
    if (!parsed.ok) {
        log(`refused ${parsed.code}: ${parsed.message}`)
        socket.end(lineOf(parsed))
        return
    }

    const what = describe(parsed.request)
    let outcome: Outcome
    try {
        outcome = await agent.handle(parsed.request)
    } catch (error) {
        log(`${what} unavailable: ${describeError(error)}`)
        socket.end(lineOf(refuse('unavailable', describeError(error))))
        return
    }

    if (outcome.kind === 'reply') {
        log(`${what} ${outcome.reply.ok ? 'ok' : outcome.reply.code}`)
        socket.end(lineOf(outcome.reply))
        return
    }

    log(`${what} streaming`)
    const stream = outcome
    let gone = false
    const abort = () => {
        gone = true
        stream.close()
    }
    socket.once('end', abort)
    socket.once('close', abort)
    try {
        if (!socket.write(lineOf({ ok: true, stream: true }))) await waitForDrain(socket)
        for await (const logLine of stream.lines) {
            if (gone) break
            if (!socket.write(lineOf(logLine))) await waitForDrain(socket)
        }
        if (!gone) socket.end()
    } catch (error) {
        log(`${what} stream failed: ${describeError(error)}`)
        socket.destroy()
    } finally {
        socket.off('end', abort)
        socket.off('close', abort)
        stream.close()
        log(`${what} stream ended`)
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add hostd/src/agent/agent.ts hostd/src/agent/agent.test.ts hostd/src/agent/server.ts hostd/src/agent/server.test.ts
git commit -m "Handle agent verbs behind the registry check, one request per connection"
```

---

### Task 9: Guard tracking and the agent entrypoint

The agent's long-running process. A `GuardTracker` keeps the storage guard's verdict for every project, and it is tested. The entrypoint runs the hard gate, runs the guard over every project, and listens on the Unix socket with mode 0660 and the group `api` runs as. It then loops: it writes `status.json`, polls the registry every 10 seconds, and re-runs the guard whenever the registry changes and every 10 minutes regardless.

**Files:**
- Create: `hostd/src/agent/guard-tracker.ts`
- Create: `hostd/src/agent/index.ts`
- Test: `hostd/src/agent/guard-tracker.test.ts`

**Interfaces:**
- Consumes: from Task 2, `type ProjectEntry`, `type Registry`; from Task 3, `RegistryStore`, `explainRegistryError`, `buildStatus`, `writeStatus`; from Task 5, `resolveCompose`, `guardProblems`, `createSpawnRunner`, `type Runner`; from Task 7, `createDockerApi`; from Task 8, `Agent`, `handleConnection`.
- Produces: `type DirCheck = (path: string) => Promise<boolean>`, `class GuardTracker { constructor(run: Runner, isDirectory?: DirCheck); current(): ReadonlyMap<string, string>; check(project: ProjectEntry): Promise<string | null>; checkAll(registry: Registry): Promise<void>; warnings(): string[] }`. The entrypoint reads `HOSTD_REGISTRY_FILE`, `HOSTD_AGENT_SOCKET`, `HOSTD_SOCKET_GID` and `HOSTD_STATUS_FILE`, with the defaults shown below.

- [ ] **Step 1: Write the failing test**

Create `hostd/src/agent/guard-tracker.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GuardTracker } from './guard-tracker.ts'
import type { Runner } from './compose.ts'
import { parseRegistry } from '../shared/registry.ts'

const text = (ids: string[]) => `projects:\n${ids.map(id => `  ${id}:
    client: cl_1
    name: ${id}
    dir: /var/www/${id}
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    storage: { media: { path: uploads, mode: rw } }
`).join('')}`

// compose config as Docker would resolve it for each project, keyed by project directory.
function composeRunner(configs: Record<string, unknown>): Runner {
    return async (_command, args) => {
        const dir = args[args.indexOf('--project-directory') + 1] ?? ''
        const config = configs[dir]
        if (config === undefined) return { exitCode: 1, stdout: '', stderr: 'no configuration file provided: not found', timedOut: false }
        return { exitCode: 0, stdout: JSON.stringify(config), stderr: '', timedOut: false }
    }
}

const goodConfig = (id: string) => ({ name: id, services: { web: { volumes: [{ type: 'bind', source: `/var/www/${id}/uploads` }] } } })

describe('GuardTracker', () => {
    it('records nothing for projects that pass', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(composeRunner({ '/var/www/alpha': goodConfig('alpha') }), async () => true)
        await tracker.checkAll(registry)
        assert.deepEqual(tracker.current(), new Map())
        assert.deepEqual(tracker.warnings(), [])
    })

    it('marks a project whose directory is missing', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(composeRunner({}), async () => false)
        await tracker.checkAll(registry)
        assert.equal(tracker.current().get('alpha'), '/var/www/alpha does not exist on the dedi')
    })

    it('marks a project whose compose config fails, and one the guard rejects', async () => {
        const registry = parseRegistry(text(['alpha', 'bravo']))
        const tracker = new GuardTracker(composeRunner({
            '/var/www/bravo': { name: 'bravo', services: { web: { volumes: [] } } },
        }), async () => true)
        await tracker.checkAll(registry)
        assert.match(tracker.current().get('alpha') ?? '', /^docker compose config failed: no configuration file provided/)
        assert.equal(tracker.current().get('bravo'), 'storage media (/var/www/bravo/uploads) is not bind-mounted into a site service')
        assert.deepEqual(tracker.warnings(), [
            `project alpha is invalid: ${tracker.current().get('alpha')}`,
            'project bravo is invalid: storage media (/var/www/bravo/uploads) is not bind-mounted into a site service',
        ])
    })

    it('clears a project once it passes again, and returns the verdict from check()', async () => {
        const registry = parseRegistry(text(['alpha']))
        const configs: Record<string, unknown> = {}
        const tracker = new GuardTracker(composeRunner(configs), async () => true)
        await tracker.checkAll(registry)
        assert.ok(tracker.current().has('alpha'))
        configs['/var/www/alpha'] = goodConfig('alpha')
        assert.equal(await tracker.check(registry.projects.get('alpha')!), null)
        assert.equal(tracker.current().has('alpha'), false)
    })

    it('forgets projects that have left the registry', async () => {
        const tracker = new GuardTracker(composeRunner({}), async () => true)
        await tracker.checkAll(parseRegistry(text(['alpha'])))
        assert.ok(tracker.current().has('alpha'))
        // An empty mapping, not text([]): "projects:" with nothing under it is YAML null, a whole-file error.
        await tracker.checkAll(parseRegistry('projects: {}\n'))
        assert.deepEqual(tracker.current(), new Map())
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './guard-tracker.ts'`.

- [ ] **Step 3: Implement the tracker**

Create `hostd/src/agent/guard-tracker.ts`:

```ts
// The storage guard's current verdict for every project. A failing project is refused, never fatal, so
// one broken site cannot take the others offline.

import { stat } from 'node:fs/promises'
import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { resolveCompose, type Runner } from './compose.ts'
import { guardProblems } from './guard.ts'

export type DirCheck = (path: string) => Promise<boolean>

const isDirectoryOnDisk: DirCheck = async path => {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

export class GuardTracker {
    private readonly invalid = new Map<string, string>()

    constructor(private readonly run: Runner, private readonly isDirectory: DirCheck = isDirectoryOnDisk) {}

    current(): ReadonlyMap<string, string> {
        return this.invalid
    }

    async check(project: ProjectEntry): Promise<string | null> {
        const problem = await this.problemOf(project)
        if (problem) this.invalid.set(project.id, problem)
        else this.invalid.delete(project.id)
        return problem
    }

    async checkAll(registry: Registry): Promise<void> {
        for (const id of [...this.invalid.keys()]) {
            if (!registry.projects.has(id)) this.invalid.delete(id)
        }
        for (const project of registry.projects.values()) await this.check(project)
    }

    warnings(): string[] {
        return [...this.invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`)
    }

    private async problemOf(project: ProjectEntry): Promise<string | null> {
        if (!(await this.isDirectory(project.dir))) return `${project.dir} does not exist on the dedi`
        const resolved = await resolveCompose(project, this.run)
        if (!resolved.ok) return resolved.problem
        const problems = guardProblems(project, resolved.resolved)
        return problems.length > 0 ? problems.join('; ') : null
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Write the entrypoint**

Create `hostd/src/agent/index.ts`. It is exercised by the live checks in the runbook (Task 15), not by unit tests. Everything it composes has already been tested.

```ts
// The agent: boot gate, then the storage guard over every project, then the socket. It runs as root with
// the Docker socket, so it listens on nothing but a Unix socket shared with api.

import { createServer } from 'node:net'
import { chmod, chown, rm, stat } from 'node:fs/promises'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createDockerApi } from './docker.ts'
import { createSpawnRunner } from './compose.ts'
import { GuardTracker } from './guard-tracker.ts'
import { Agent } from './agent.ts'
import { handleConnection } from './server.ts'

const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/projects.yaml'
const SOCKET_PATH = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const WWW = '/var/www'
const POLL_MS = 10_000
// Compose files can change without the registry changing, so the guard also runs on a timer.
const GUARD_EVERY_MS = 10 * 60_000
// Roughly 75 seconds in total, as in mailops: long enough for a daemon still starting after a reboot.
const BOOT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]

const log = (message: string) => console.log(`[agent] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

async function main(): Promise<void> {
    if (!Number.isInteger(SOCKET_GID) || SOCKET_GID < 0) fail([`HOSTD_SOCKET_GID must be a group id, not ${process.env.HOSTD_SOCKET_GID}`])

    const store = new RegistryStore(REGISTRY_FILE)
    const failures: string[] = []
    try {
        await store.load()
    } catch (error) {
        failures.push(`the registry ${REGISTRY_FILE} could not be loaded: ${explainRegistryError(error)}`)
    }
    try {
        if (!(await stat(WWW)).isDirectory()) failures.push(`${WWW} is not a directory`)
    } catch {
        failures.push(`${WWW} is not mounted`)
    }
    if (failures.length > 0) fail(failures)

    const docker = createDockerApi()
    let reachable = await docker.ping()
    for (const delay of BOOT_BACKOFF_MS) {
        if (reachable) break
        log(`the Docker socket is not answering, retrying in ${delay / 1000}s`)
        await sleep(delay)
        reachable = await docker.ping()
    }
    if (!reachable) fail(['the Docker socket is not answering'])

    const runner = createSpawnRunner()
    const guard = new GuardTracker(runner)
    await guard.checkAll(store.current())

    const warnings = () => [
        ...store.warnings(),
        ...[...store.current().invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`),
        ...guard.warnings(),
    ]

    const agent = new Agent({
        registry: () => store.current(),
        guardInvalid: () => guard.current(),
        warnings,
        docker,
        runner,
        recheck: project => guard.check(project),
    })

    await rm(SOCKET_PATH, { force: true })
    // The socket is created 0660 rather than chmodded afterwards, so there is no moment when it is wider.
    process.umask(0o117)
    const server = createServer(socket => {
        handleConnection(socket, agent, log).catch(error => log(`connection failed: ${describeError(error)}`))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(SOCKET_PATH, resolve)
    })
    await chown(SOCKET_PATH, 0, SOCKET_GID)
    await chmod(SOCKET_PATH, 0o660)
    log(`listening on ${SOCKET_PATH}`)

    let lastGuardRun = Date.now()
    let lastWarnings = ''
    for (;;) {
        const current = warnings()
        // Logged when they change rather than every poll, so the log shows transitions, not noise.
        if (current.join('\n') !== lastWarnings) {
            for (const warning of current) log(`WARN ${warning}`)
            if (current.length === 0 && lastWarnings !== '') log('all warnings cleared')
            lastWarnings = current.join('\n')
        }
        await writeStatus(STATUS_FILE, buildStatus(current, new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)
        const changed = await store.refresh()
        if (changed) log('registry reloaded')
        if (changed || Date.now() - lastGuardRun >= GUARD_EVERY_MS) {
            await guard.checkAll(store.current())
            lastGuardRun = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
```

- [ ] **Step 6: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add hostd/src/agent/guard-tracker.ts hostd/src/agent/guard-tracker.test.ts hostd/src/agent/index.ts
git commit -m "Run the agent: gate, guard every project, and listen on a group-only socket"
```

---

### Task 10: Authentication and policy in api

`api`'s first two checks on every request. The first is the bearer token and the actor headers. The second is the ownership and capability policy. A client asking about someone else's project gets exactly the same answer as for a project that does not exist, so ids cannot be probed.

**Files:**
- Create: `hostd/src/api/auth.ts`
- Create: `hostd/src/api/policy.ts`
- Test: `hostd/src/api/auth.test.ts`
- Test: `hostd/src/api/policy.test.ts`

**Interfaces:**
- Consumes: from Task 1, `CLIENT_ID`, `USER_ID`; from Task 2, `type Registry`, `type ProjectEntry`; from Task 4, `VERB_CAPABILITY`.
- Produces:
  - `type Actor = { kind: 'admin' } | { kind: 'client', client: string }`, `type Caller = { actor: Actor, user: string }`
  - `type AuthFailure = { ok: false, status: 400 | 401, code: 'unauthorized' | 'bad-request', message: string, label: string, user: string }`
  - `tokensMatch(given: string, expected: string): boolean`, `parseActor(raw: string | undefined): Actor | null`, `actorLabel(actor: Actor): string`
  - `authenticate(headers: IncomingHttpHeaders, token: string): { ok: true, caller: Caller } | AuthFailure`
  - `type PolicyVerb = 'status' | 'lifecycle' | 'logs' | 'audit'`
  - `type Decision = { ok: true, project: ProjectEntry } | { ok: false, status: 403 | 404 | 409, code: 'not-found' | 'capability-disabled' | 'invalid-project', message: string }`
  - `authorize(registry: Registry, actor: Actor, projectId: string, verb: PolicyVerb): Decision`
  - `visibleProjects(registry: Registry, actor: Actor): ProjectEntry[]`

- [ ] **Step 1: Write the failing auth test**

Create `hostd/src/api/auth.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authenticate, tokensMatch, parseActor, actorLabel } from './auth.ts'

const TOKEN = 't'.repeat(64)
const headers = (overrides: Record<string, string | undefined> = {}) => ({
    authorization: `Bearer ${TOKEN}`,
    'x-hostd-actor': 'client:cl_1',
    'x-hostd-user': 'user_42',
    ...overrides,
})

describe('tokensMatch', () => {
    it('matches only the exact token, whatever the lengths', () => {
        assert.equal(tokensMatch(TOKEN, TOKEN), true)
        assert.equal(tokensMatch(TOKEN.slice(1), TOKEN), false)
        assert.equal(tokensMatch('', TOKEN), false)
        assert.equal(tokensMatch(`${TOKEN}x`, TOKEN), false)
    })
})

describe('parseActor', () => {
    it('reads admin and client actors', () => {
        assert.deepEqual(parseActor('admin'), { kind: 'admin' })
        assert.deepEqual(parseActor('client:cl_1'), { kind: 'client', client: 'cl_1' })
    })

    it('refuses anything else', () => {
        for (const raw of [undefined, '', 'Admin', 'client:', 'client:a:b', 'client:a b', 'root']) {
            assert.equal(parseActor(raw), null, String(raw))
        }
    })

    it('labels actors the way the audit log shows them', () => {
        assert.equal(actorLabel({ kind: 'admin' }), 'admin')
        assert.equal(actorLabel({ kind: 'client', client: 'cl_1' }), 'client:cl_1')
    })
})

describe('authenticate', () => {
    it('accepts a correct token with well-formed headers', () => {
        assert.deepEqual(authenticate(headers(), TOKEN), { ok: true, caller: { actor: { kind: 'client', client: 'cl_1' }, user: 'user_42' } })
    })

    it('refuses a missing or wrong token with 401, recording what was claimed', () => {
        for (const authorization of [undefined, 'Bearer wrong', TOKEN, `Basic ${TOKEN}`]) {
            const result = authenticate(headers({ authorization }), TOKEN)
            assert.equal(result.ok, false)
            assert.equal(!result.ok && result.status, 401)
            assert.equal(!result.ok && result.label, 'unauthenticated (claimed client:cl_1)')
        }
    })

    it('refuses a malformed actor with 400', () => {
        const result = authenticate(headers({ 'x-hostd-actor': 'client:../x' }), TOKEN)
        assert.deepEqual(result, {
            ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-Actor must be admin or client:<id>',
            label: 'invalid (client:../x)', user: 'user_42',
        })
    })

    it('refuses a missing or malformed user with 400', () => {
        for (const user of [undefined, 'has space']) {
            const result = authenticate(headers({ 'x-hostd-user': user }), TOKEN)
            assert.equal(!result.ok && result.message, 'X-Hostd-User is missing or malformed')
        }
    })
})
```

- [ ] **Step 2: Write the failing policy test**

Create `hostd/src/api/policy.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, visibleProjects } from './policy.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Actor } from './auth.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  other:
    client: cl_2
    name: Other
    dir: /var/www/other
    upstream: 127.0.0.1:5012
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  broken:
    client: cl_1
`)

const admin: Actor = { kind: 'admin' }
const owner: Actor = { kind: 'client', client: 'cl_1' }
const stranger: Actor = { kind: 'client', client: 'cl_2' }

describe('authorize', () => {
    it('lets the owner and the admin use an enabled capability', () => {
        for (const actor of [owner, admin]) {
            const decision = authorize(registry, actor, 'acme', 'lifecycle')
            assert.equal(decision.ok && decision.project.id, 'acme')
        }
    })

    // The same answer for "not yours" and "does not exist", so ids cannot be probed.
    it('answers 404 for someone else\'s project and for a missing one alike', () => {
        const notFound = { ok: false, status: 404, code: 'not-found', message: 'no project acme' }
        assert.deepEqual(authorize(registry, stranger, 'acme', 'status'), notFound)
        assert.deepEqual(authorize(registry, owner, 'ghost', 'status'), { ...notFound, message: 'no project ghost' })
    })

    it('answers 403 for a switched-off capability, even for the admin', () => {
        for (const actor of [owner, admin]) {
            assert.deepEqual(authorize(registry, actor, 'quiet', 'logs'), {
                ok: false, status: 403, code: 'capability-disabled', message: 'logs is not enabled for quiet',
            })
        }
    })

    it('needs no capability for status or the audit trail', () => {
        assert.equal(authorize(registry, owner, 'quiet', 'status').ok, true)
        assert.equal(authorize(registry, owner, 'quiet', 'audit').ok, true)
    })

    it('tells only the admin that an invalid entry exists', () => {
        const forAdmin = authorize(registry, admin, 'broken', 'status')
        assert.equal(!forAdmin.ok && forAdmin.status, 409)
        assert.equal(!forAdmin.ok && forAdmin.code, 'invalid-project')
        assert.deepEqual(authorize(registry, owner, 'broken', 'status'), { ok: false, status: 404, code: 'not-found', message: 'no project broken' })
    })
})

describe('visibleProjects', () => {
    it('shows a client only their own projects and the admin everything', () => {
        assert.deepEqual(visibleProjects(registry, owner).map(p => p.id), ['acme', 'quiet'])
        assert.deepEqual(visibleProjects(registry, stranger).map(p => p.id), ['other'])
        assert.deepEqual(visibleProjects(registry, admin).map(p => p.id), ['acme', 'quiet', 'other'])
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './auth.ts'` and `Cannot find module './policy.ts'`.

- [ ] **Step 4: Implement authentication**

Create `hostd/src/api/auth.ts`:

```ts
// Who is calling. The token proves the caller is the portal; the actor header says which client the
// portal is acting for. hostd cannot verify that claim (the portal is what signs users in), which is why
// the agent re-checks everything that does not depend on it.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { CLIENT_ID, USER_ID } from '../shared/formats.ts'

export type Actor = { kind: 'admin' } | { kind: 'client', client: string }
export type Caller = { actor: Actor, user: string }
export type AuthFailure = {
    ok: false
    status: 400 | 401
    code: 'unauthorized' | 'bad-request'
    message: string
    label: string
    user: string
}

// Hashing both sides first gives equal-length inputs, so the comparison is constant-time whatever the
// length of the guess.
export function tokensMatch(given: string, expected: string): boolean {
    const a = createHash('sha256').update(given).digest()
    const b = createHash('sha256').update(expected).digest()
    return timingSafeEqual(a, b)
}

export function parseActor(raw: string | undefined): Actor | null {
    if (raw === 'admin') return { kind: 'admin' }
    const client = raw?.startsWith('client:') ? raw.slice('client:'.length) : null
    return client && CLIENT_ID.test(client) ? { kind: 'client', client } : null
}

export function actorLabel(actor: Actor): string {
    return actor.kind === 'admin' ? 'admin' : `client:${actor.client}`
}

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined)

export function authenticate(headers: IncomingHttpHeaders, token: string): { ok: true, caller: Caller } | AuthFailure {
    const authorization = single(headers.authorization)
    const given = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    const actorHeader = single(headers['x-hostd-actor'])
    const userHeader = single(headers['x-hostd-user'])
    // For the audit line only: what the request claimed to be, whatever it turns out to be.
    const claimed = (actorHeader ?? 'none').slice(0, 80)
    const userLabel = userHeader && USER_ID.test(userHeader) ? userHeader : 'unknown'

    if (!tokensMatch(given, token)) {
        return { ok: false, status: 401, code: 'unauthorized', message: 'missing or wrong bearer token', label: `unauthenticated (claimed ${claimed})`, user: userLabel }
    }
    const actor = parseActor(actorHeader)
    if (!actor) {
        return { ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-Actor must be admin or client:<id>', label: `invalid (${claimed})`, user: userLabel }
    }
    if (!userHeader || !USER_ID.test(userHeader)) {
        return { ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-User is missing or malformed', label: actorLabel(actor), user: 'unknown' }
    }
    return { ok: true, caller: { actor, user: userHeader } }
}
```

- [ ] **Step 5: Implement the policy**

Create `hostd/src/api/policy.ts`:

```ts
// api's policy: does this actor own this project, and is the capability on. The agent repeats the
// capability check itself; ownership exists only here, because only here is the actor known.

import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { VERB_CAPABILITY } from '../shared/protocol.ts'
import type { Actor } from './auth.ts'

export type PolicyVerb = 'status' | 'lifecycle' | 'logs' | 'audit'
export type Decision =
    | { ok: true, project: ProjectEntry }
    | { ok: false, status: 403 | 404 | 409, code: 'not-found' | 'capability-disabled' | 'invalid-project', message: string }

export function authorize(registry: Registry, actor: Actor, projectId: string, verb: PolicyVerb): Decision {
    const invalid = registry.invalid.get(projectId)
    // An invalid entry has no owner that can be trusted, so only the operator learns it exists.
    if (invalid !== undefined && actor.kind === 'admin') {
        return { ok: false, status: 409, code: 'invalid-project', message: `${projectId} is invalid: ${invalid}` }
    }
    const project = registry.projects.get(projectId)
    // Someone else's project and a missing one get the same answer, so a client cannot probe for ids.
    if (!project || (actor.kind === 'client' && actor.client !== project.client)) {
        return { ok: false, status: 404, code: 'not-found', message: `no project ${projectId}` }
    }
    const capability = verb === 'audit' ? null : VERB_CAPABILITY[verb]
    if (capability && !project.capabilities.has(capability)) {
        return { ok: false, status: 403, code: 'capability-disabled', message: `${capability} is not enabled for ${projectId}` }
    }
    return { ok: true, project }
}

export function visibleProjects(registry: Registry, actor: Actor): ProjectEntry[] {
    return [...registry.projects.values()].filter(project => actor.kind === 'admin' || project.client === actor.client)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add hostd/src/api/auth.ts hostd/src/api/auth.test.ts hostd/src/api/policy.ts hostd/src/api/policy.test.ts
git commit -m "Authenticate the portal and decide ownership without revealing other clients' projects"
```

---

### Task 11: The agent client in api

`api`'s side of the Unix socket. Each call opens one connection, writes one request line, and reads either one reply line or a header followed by a stream of log lines. A refusal from the agent comes back as a value. Anything that stops the agent answering throws `AgentUnavailableError`: no socket, a dropped connection, a timeout or an unreadable reply. The tests drive the real agent server from Task 8 over an in-memory socket pair, so both ends of the protocol are tested together.

**Files:**
- Create: `hostd/src/api/agent-client.ts`
- Test: `hostd/src/api/agent-client.test.ts`

**Interfaces:**
- Consumes: from Task 1, `isRecord`, `describeError`; from Task 4, the request, reply, `Refusal` and `LogLine` types; from Task 8 (tests only), `handleConnection`, `type AgentHandler`.
- Produces:
  - `class AgentUnavailableError extends Error`
  - `type Connect = () => Duplex`, `socketConnect(path: string): Connect`
  - `CALL_TIMEOUT_MS = 150_000`, `STREAM_HEADER_TIMEOUT_MS = 30_000`
  - `type LogStream = { ok: true, lines: AsyncIterable<LogLine>, close(): void }`
  - `type AgentClient = { call(request: AgentRequest): Promise<AgentReply>, stream(request: ProjectRequest): Promise<LogStream | Refusal> }`
  - `createAgentClient(connect: Connect, options?: { callTimeoutMs?: number, headerTimeoutMs?: number }): AgentClient`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/agent-client.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplexPair, type Duplex } from 'node:stream'
import { createAgentClient, AgentUnavailableError, type Connect } from './agent-client.ts'
import { handleConnection, type AgentHandler } from '../agent/server.ts'
import type { LogLine } from '../shared/protocol.ts'

const line: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }

// Each connect() gets a fresh socket pair whose far end is served by the real agent server.
function connectTo(agent: AgentHandler): Connect {
    return () => {
        const [client, server] = duplexPair()
        void handleConnection(server, agent, () => {})
        return client
    }
}

// A far end that does whatever the test says with the raw socket.
function connectRaw(behaviour: (server: Duplex, client: Duplex) => void): Connect {
    return () => {
        const [client, server] = duplexPair()
        behaviour(server, client)
        return client
    }
}

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
    const out: LogLine[] = []
    for await (const item of lines) out.push(item)
    return out
}

describe('call', () => {
    it('returns the agent\'s reply', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: true, warnings: [], invalid: {} } }) }))
        assert.deepEqual(await client.call({ verb: 'health' }), { ok: true, warnings: [], invalid: {} })
    })

    it('returns a refusal as a value, not an error', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: false, code: 'busy', message: 'busy' } }) }))
        assert.deepEqual(await client.call({ verb: 'status', project: 'acme' }), { ok: false, code: 'busy', message: 'busy' })
    })

    it('throws AgentUnavailableError when the agent hangs up without answering', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => server.end())
        }))
        await assert.rejects(client.call({ verb: 'health' }), (error: unknown) => {
            assert.ok(error instanceof AgentUnavailableError)
            assert.equal(error.message, 'the agent closed the connection without answering')
            return true
        })
    })

    it('throws AgentUnavailableError when the socket fails', async () => {
        const client = createAgentClient(connectRaw((_server, clientSide) => {
            setImmediate(() => clientSide.destroy(new Error('connect ENOENT /run/hostd/agent.sock')))
        }))
        await assert.rejects(client.call({ verb: 'health' }), /the agent connection failed: connect ENOENT \/run\/hostd\/agent\.sock/)
    })

    it('throws AgentUnavailableError when the agent does not answer in time', async () => {
        const client = createAgentClient(connectRaw(() => {}), { callTimeoutMs: 30 })
        await assert.rejects(client.call({ verb: 'health' }), /the agent did not answer within 0\.03 seconds/)
    })

    it('throws AgentUnavailableError on a reply that is not JSON', async () => {
        const client = createAgentClient(connectRaw(server => {
            server.once('data', () => server.end('garbage\n'))
        }))
        await assert.rejects(client.call({ verb: 'health' }), /the agent sent an unreadable reply/)
    })
})

describe('stream', () => {
    const logs = { verb: 'logs' as const, project: 'acme', args: { service: 'web', tail: 10, since: null, follow: true } }

    it('yields each log line and ends with the agent\'s stream', async () => {
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'stream',
                lines: (async function* () { yield line; yield { ...line, text: 'again' } })(),
                close: () => {},
            }),
        }))
        const result = await client.stream(logs)
        assert.ok(result.ok)
        assert.deepEqual(await collect(result.lines), [line, { ...line, text: 'again' }])
    })

    it('returns a refusal instead of a stream', async () => {
        const client = createAgentClient(connectTo({ handle: async () => ({ kind: 'reply', reply: { ok: false, code: 'busy', message: 'acme already has 4 log streams open' } }) }))
        assert.deepEqual(await client.stream(logs), { ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
    })

    it('closing the stream makes the agent close its end', async () => {
        let agentClosed: () => void = () => {}
        const closedOnAgent = new Promise<void>(resolve => { agentClosed = resolve })
        let wake: () => void = () => {}
        const client = createAgentClient(connectTo({
            handle: async () => ({
                kind: 'stream',
                lines: (async function* () {
                    yield line
                    await new Promise<void>(resolve => { wake = resolve })
                })(),
                close: () => {
                    agentClosed()
                    wake()
                },
            }),
        }))
        const result = await client.stream(logs)
        assert.ok(result.ok)
        const iterator = result.lines[Symbol.asyncIterator]()
        assert.deepEqual((await iterator.next()).value, line)
        result.close()
        await closedOnAgent
        assert.equal((await iterator.next()).done, true)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './agent-client.ts'`.

- [ ] **Step 3: Implement the client**

Create `hostd/src/api/agent-client.ts`:

```ts
// api's side of the agent socket: one connection per call, one request line, then either one reply line
// or a header line and a stream of log lines. A refusal is an answer; silence, a dropped connection or
// garbage is AgentUnavailableError.

import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { isRecord, describeError } from '../shared/formats.ts'
import type { AgentReply, AgentRequest, LogLine, ProjectRequest, Refusal } from '../shared/protocol.ts'

export class AgentUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentUnavailableError'
    }
}

export type Connect = () => Duplex
export type LogStream = { ok: true, lines: AsyncIterable<LogLine>, close(): void }
export type AgentClient = {
    call(request: AgentRequest): Promise<AgentReply>
    stream(request: ProjectRequest): Promise<LogStream | Refusal>
}

// Longer than the agent's own 120 second lifecycle timeout, so the agent's answer always arrives first.
export const CALL_TIMEOUT_MS = 150_000
export const STREAM_HEADER_TIMEOUT_MS = 30_000

export function socketConnect(path: string): Connect {
    return () => createConnection(path)
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout()
            reject(new AgentUnavailableError(`the agent did not answer within ${ms / 1000} seconds`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function parseLine(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw new AgentUnavailableError('the agent sent an unreadable reply')
    }
}

function open(connect: Connect, request: AgentRequest) {
    const socket = connect()
    let failure: Error | null = null
    const reader = createInterface({ input: socket, crlfDelay: Infinity })
    const iterator = reader[Symbol.asyncIterator]()
    // readline does not end on a socket error, so close it by hand; next() then reports the failure.
    socket.on('error', error => {
        failure = error
        reader.close()
    })
    // The write side stays open: the agent reads the peer leaving as "stop streaming".
    socket.write(`${JSON.stringify(request)}\n`)

    async function next(): Promise<string | null> {
        let result: IteratorResult<string>
        try {
            result = await iterator.next()
        } catch (error) {
            throw new AgentUnavailableError(`the agent connection failed: ${describeError(error)}`)
        }
        return result.done ? null : result.value
    }

    async function first(): Promise<string> {
        const value = await next()
        if (value !== null) return value
        const reason = failure as Error | null
        throw new AgentUnavailableError(reason ? `the agent connection failed: ${reason.message}` : 'the agent closed the connection without answering')
    }

    function close(): void {
        reader.close()
        socket.end()
        // A real socket that never acknowledges the end is torn down anyway.
        setTimeout(() => socket.destroy(), 5_000).unref()
    }

    return { first, next, close }
}

export function createAgentClient(
    connect: Connect,
    options: { callTimeoutMs?: number, headerTimeoutMs?: number } = {},
): AgentClient {
    const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    const headerTimeoutMs = options.headerTimeoutMs ?? STREAM_HEADER_TIMEOUT_MS

    return {
        async call(request) {
            const connection = open(connect, request)
            try {
                const reply = parseLine(await withTimeout(connection.first(), callTimeoutMs, connection.close))
                if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new AgentUnavailableError('the agent sent an unreadable reply')
                return reply as AgentReply
            } finally {
                connection.close()
            }
        },

        async stream(request) {
            const connection = open(connect, request)
            let header: unknown
            try {
                header = parseLine(await withTimeout(connection.first(), headerTimeoutMs, connection.close))
            } catch (error) {
                connection.close()
                throw error
            }
            if (isRecord(header) && header.ok === false) {
                connection.close()
                return header as Refusal
            }
            if (!isRecord(header) || header.ok !== true || header.stream !== true) {
                connection.close()
                throw new AgentUnavailableError('the agent answered a stream request without a stream')
            }

            async function* lines(): AsyncGenerator<LogLine> {
                try {
                    for (;;) {
                        const text = await connection.next()
                        if (text === null) return
                        yield parseLine(text) as LogLine
                    }
                } finally {
                    connection.close()
                }
            }
            return { ok: true, lines: lines(), close: connection.close }
        },
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/api/agent-client.ts hostd/src/api/agent-client.test.ts
git commit -m "Talk to the agent over its socket, telling a refusal apart from an agent that is down"
```

---

### Task 12: The audit log

One JSON line per event in `YYYY-MM.jsonl`, keeping 12 months. A failed write never fails the request that caused it, because the action has already happened by then. It becomes a health warning instead, so the operator learns that the record has a gap.

**Files:**
- Create: `hostd/src/api/audit.ts`
- Test: `hostd/src/api/audit.test.ts`

**Interfaces:**
- Consumes: from Task 1, `describeError`.
- Produces:
  - `type AuditOutcome = 'ok' | 'refused' | 'failed'`
  - `type AuditEvent = { ts: string, actor: string, user: string, project: string | null, verb: string, target: string | null, outcome: AuditOutcome, reason?: string, durationMs: number, output?: string }`
  - `RETENTION_MONTHS = 12`, `MAX_AUDIT_READ = 500`
  - `monthFile(date: Date): string`, `filesToPrune(names: string[], now: Date): string[]`
  - `class AuditLog { constructor(dir: string, now?: () => Date); append(event: AuditEvent): Promise<void>; read(options: { project?: string, limit: number }): Promise<AuditEvent[]>; prune(): Promise<string[]>; warnings(): string[] }`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/audit.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog, monthFile, filesToPrune, type AuditEvent } from './audit.ts'

function event(ts: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
    return { ts, actor: 'client:cl_1', user: 'u1', project: 'acme', verb: 'lifecycle', target: 'start', outcome: 'ok', durationMs: 5, ...overrides }
}

describe('monthFile and filesToPrune', () => {
    it('names files by UTC month', () => {
        assert.equal(monthFile(new Date('2026-09-30T23:59:59Z')), '2026-09.jsonl')
        assert.equal(monthFile(new Date('2026-01-01T00:00:00Z')), '2026-01.jsonl')
    })

    it('keeps the current month and the eleven before it, and ignores other files', () => {
        const names = ['2025-09.jsonl', '2025-10.jsonl', '2026-09.jsonl', 'notes.txt', '2024-01.jsonl']
        assert.deepEqual(filesToPrune(names, new Date('2026-09-20T00:00:00Z')), ['2025-09.jsonl', '2024-01.jsonl'])
    })
})

describe('AuditLog', () => {
    let dir = ''
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hostd-audit-')) })
    afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

    it('appends to the month file of the event and reads newest first', async () => {
        const log = new AuditLog(join(dir, 'audit'))
        await log.append(event('2026-08-31T10:00:00Z', { target: 'stop' }))
        await log.append(event('2026-09-01T10:00:00Z', { target: 'start' }))
        await log.append(event('2026-09-02T10:00:00Z', { target: 'restart' }))
        assert.deepEqual((await readdir(join(dir, 'audit'))).sort(), ['2026-08.jsonl', '2026-09.jsonl'])
        assert.deepEqual((await log.read({ limit: 10 })).map(e => e.target), ['restart', 'start', 'stop'])
    })

    it('filters by project and stops at the limit', async () => {
        const log = new AuditLog(dir)
        await log.append(event('2026-09-01T00:00:00Z', { project: 'acme', target: 'a1' }))
        await log.append(event('2026-09-02T00:00:00Z', { project: 'other', target: 'o1' }))
        await log.append(event('2026-09-03T00:00:00Z', { project: 'acme', target: 'a2' }))
        assert.deepEqual((await log.read({ project: 'acme', limit: 10 })).map(e => e.target), ['a2', 'a1'])
        assert.deepEqual((await log.read({ limit: 1 })).map(e => e.target), ['a2'])
    })

    it('skips a corrupted line rather than failing the read', async () => {
        const log = new AuditLog(dir)
        await log.append(event('2026-09-01T00:00:00Z', { target: 'good' }))
        await appendFile(join(dir, '2026-09.jsonl'), '{"truncated\n')
        assert.deepEqual((await log.read({ limit: 10 })).map(e => e.target), ['good'])
    })

    it('reads nothing from a directory that does not exist yet', async () => {
        assert.deepEqual(await new AuditLog(join(dir, 'missing')).read({ limit: 10 }), [])
    })

    it('prunes months past retention', async () => {
        const log = new AuditLog(dir, () => new Date('2026-09-20T00:00:00Z'))
        await log.append(event('2025-09-15T00:00:00Z'))
        await log.append(event('2026-09-15T00:00:00Z'))
        assert.deepEqual(await log.prune(), ['2025-09.jsonl'])
        assert.deepEqual(await readdir(dir), ['2026-09.jsonl'])
    })

    // The action already happened; refusing to answer would not undo it. The gap is reported instead.
    it('turns a failed write into a warning instead of an error, and clears it after a good write', async () => {
        const blocker = join(dir, 'not-a-directory')
        await writeFile(blocker, 'x')
        const log = new AuditLog(join(blocker, 'audit'))
        await log.append(event('2026-09-01T00:00:00Z'))
        assert.match(log.warnings()[0] ?? '', /^the audit log could not be written: /)

        const healthy = new AuditLog(dir)
        await healthy.append(event('2026-09-01T00:00:00Z'))
        assert.deepEqual(healthy.warnings(), [])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './audit.ts'`.

- [ ] **Step 3: Implement the audit log**

Create `hostd/src/api/audit.ts`:

```ts
// The audit log: one JSON line per event, one file per UTC month, twelve months kept. Every mutation,
// every log stream opened and every refusal is recorded; plain reads are not. The agent keeps its own
// record on stdout, which this process cannot reach.

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describeError } from '../shared/formats.ts'

export type AuditOutcome = 'ok' | 'refused' | 'failed'
export type AuditEvent = {
    ts: string
    actor: string
    user: string
    project: string | null
    verb: string
    target: string | null
    outcome: AuditOutcome
    reason?: string
    durationMs: number
    output?: string
}

export const RETENTION_MONTHS = 12
export const MAX_AUDIT_READ = 500
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/

export function monthFile(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

export function filesToPrune(names: string[], now: Date): string[] {
    const current = now.getUTCFullYear() * 12 + now.getUTCMonth()
    return names.filter(name => {
        const match = name.match(MONTH_FILE)
        if (!match) return false
        const index = Number(match[1]) * 12 + Number(match[2]) - 1
        return index <= current - RETENTION_MONTHS
    })
}

export class AuditLog {
    private lastError: string | null = null

    constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

    // Never throws: by the time an event is written, the action it records has already happened.
    async append(event: AuditEvent): Promise<void> {
        try {
            await mkdir(this.dir, { recursive: true })
            await appendFile(join(this.dir, monthFile(new Date(event.ts))), `${JSON.stringify(event)}\n`)
            this.lastError = null
        } catch (error) {
            this.lastError = describeError(error)
            console.error(`[api] ${new Date().toISOString()} audit write failed: ${this.lastError}`)
        }
    }

    async read(options: { project?: string, limit: number }): Promise<AuditEvent[]> {
        let names: string[]
        try {
            names = await readdir(this.dir)
        } catch {
            return []
        }
        const events: AuditEvent[] = []
        for (const name of names.filter(n => MONTH_FILE.test(n)).sort().reverse()) {
            const lines = (await readFile(join(this.dir, name), 'utf8')).split('\n').reverse()
            for (const line of lines) {
                if (line === '') continue
                let parsed: AuditEvent
                try {
                    parsed = JSON.parse(line) as AuditEvent
                } catch {
                    continue
                }
                if (options.project !== undefined && parsed.project !== options.project) continue
                events.push(parsed)
                if (events.length >= options.limit) return events
            }
        }
        return events
    }

    async prune(): Promise<string[]> {
        let names: string[]
        try {
            names = await readdir(this.dir)
        } catch {
            return []
        }
        const expired = filesToPrune(names, this.now())
        for (const name of expired) await rm(join(this.dir, name), { force: true })
        return expired
    }

    warnings(): string[] {
        return this.lastError ? [`the audit log could not be written: ${this.lastError}`] : []
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/api/audit.ts hostd/src/api/audit.test.ts
git commit -m "Keep a monthly JSONL audit log whose write failures surface as health warnings"
```

---

### Task 13: HTTP routes and Server-Sent Events

`api`'s HTTP surface for phase 1. It authenticates every request first, checks every project request against the policy before the agent sees it, and audits every change, every log stream opened and every refusal. Status and audit reads are not audited. The tests run the real handler on a local port against a fake agent client and a real audit log in a temporary directory.

**Endpoints:**

```
GET    /projects                           projects visible to the actor, with validity
GET    /projects/:id                       status per service
POST   /projects/:id/start | stop | restart
GET    /projects/:id/logs?service=&tail=&since=&follow=   Server-Sent Events
GET    /projects/:id/audit?limit=          the project's audit trail, newest first
GET    /audit?limit=                       everything, admin only
```

`since` accepts Unix seconds (`1726790400.5`) or an RFC 3339 timestamp, which is what the portal will have from the last `line` event. Timestamps are converted to seconds with millisecond precision, so a reconnect can repeat the lines in the final millisecond. The portal drops a line whose `ts` it has already shown.

Agent refusal codes map to HTTP statuses as: `bad-request` 400, `capability-disabled` 403, `unknown-project` and `unknown-service` 404, `invalid-project` and `busy` 409, `failed` 502, `unavailable` 503. When the agent cannot be reached at all the answer is 503 with code `agent-unavailable`.

**Files:**
- Create: `hostd/src/api/sse.ts`
- Create: `hostd/src/api/routes.ts`
- Test: `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: from Task 1, `PROJECT_ID`, `SERVICE_NAME`, `describeError`; from Task 2, `type Registry`; from Task 4, `LIFECYCLE_ACTIONS`, `MAX_TAIL`, `DEFAULT_TAIL`, and the request, reply and `LogsArgs` types; from Task 10, `authenticate`, `actorLabel`, `authorize`, `visibleProjects`; from Task 11, `AgentUnavailableError`, `type AgentClient`; from Task 12, `AuditLog`, `MAX_AUDIT_READ`, `type AuditOutcome`.
- Produces:
  - `sseEvent(event: string, data: unknown): string`, `SSE_KEEPALIVE: string`
  - `type Route` and `matchRoute(method: string, pathname: string): Route`
  - `parseLogsQuery(params: URLSearchParams): { ok: true, args: LogsArgs } | { ok: false, message: string }`
  - `type ApiDeps = { token: string, registry: () => Registry, agent: AgentClient, audit: AuditLog, now?: () => number, keepaliveMs?: number }`
  - `createHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void`

- [ ] **Step 1: Write the failing test**

Create `hostd/src/api/routes.test.ts`:

```ts
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler, matchRoute, parseLogsQuery } from './routes.ts'
import { AuditLog } from './audit.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { AgentReply, AgentRequest, LogLine } from '../shared/protocol.ts'

const TOKEN = 'k'.repeat(64)
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  other:
    client: cl_2
    name: Other
    dir: /var/www/other
    upstream: 127.0.0.1:5012
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  broken:
    client: cl_1
`)

const logLine: LogLine = { stream: 'stdout', ts: '2026-09-20T00:00:00Z', text: 'hello', truncated: false }

// The agent as api sees it. Tests replace call or stream to simulate refusals and outages.
function fakeAgent() {
    const calls: AgentRequest[] = []
    const agent: AgentClient & { calls: AgentRequest[], reply: (request: AgentRequest) => AgentReply } = {
        calls,
        reply: request => {
            switch (request.verb) {
                case 'health': return { ok: true, warnings: [], invalid: { acme: 'guard says no' } }
                case 'status': return { ok: true, services: [] }
                default: return { ok: true, output: 'done' }
            }
        },
        async call(request) {
            calls.push(request)
            return agent.reply(request)
        },
        async stream(request) {
            calls.push(request)
            return { ok: true, lines: (async function* () { yield logLine })(), close() {} }
        },
    }
    return agent
}

let server: Server
let base = ''
let dir = ''
let audit: AuditLog
let agent: ReturnType<typeof fakeAgent>

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hostd-routes-'))
    server = createServer((req, res) => handler(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
})

let handler: ReturnType<typeof createHandler>
beforeEach(async () => {
    audit = new AuditLog(join(dir, `audit-${Math.random().toString(36).slice(2)}`))
    agent = fakeAgent()
    handler = createHandler({ token: TOKEN, registry: () => registry, agent, audit, keepaliveMs: 60_000 })
})

function request(path: string, options: { method?: string, actor?: string, token?: string | null } = {}) {
    const headers: Record<string, string> = { 'x-hostd-actor': options.actor ?? 'client:cl_1', 'x-hostd-user': 'user_1' }
    if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
    return fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
}

describe('matchRoute', () => {
    it('matches every phase 1 route and refuses the rest', () => {
        assert.deepEqual(matchRoute('GET', '/projects'), { verb: 'list' })
        assert.deepEqual(matchRoute('GET', '/audit'), { verb: 'audit-all' })
        assert.deepEqual(matchRoute('GET', '/projects/acme'), { verb: 'status', project: 'acme' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/restart'), { verb: 'lifecycle', project: 'acme', action: 'restart' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/logs'), { verb: 'logs', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/audit'), { verb: 'audit', project: 'acme' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/start'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('GET', '/projects/%2e%2e'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/files'), { verb: 'not-found' })
        assert.deepEqual(matchRoute('GET', '/'), { verb: 'not-found' })
    })
})

describe('parseLogsQuery', () => {
    const parse = (query: string) => parseLogsQuery(new URLSearchParams(query))

    it('defaults tail, since and follow', () => {
        assert.deepEqual(parse('service=web'), { ok: true, args: { service: 'web', tail: 200, since: null, follow: false } })
    })

    it('accepts since as Unix seconds or as an RFC 3339 timestamp', () => {
        assert.deepEqual(parse('service=web&since=1726790400.5&follow=1&tail=0'), { ok: true, args: { service: 'web', tail: 0, since: 1726790400.5, follow: true } })
        const parsed = parse('service=web&since=2026-09-20T00:00:00.123456789Z')
        assert.equal(parsed.ok && parsed.args.since, Date.parse('2026-09-20T00:00:00.123Z') / 1000)
    })

    it('refuses bad values', () => {
        for (const query of ['', 'service=a/b', 'service=web&tail=5001', 'service=web&tail=1.5', 'service=web&since=yesterday', 'service=web&follow=maybe']) {
            assert.equal(parse(query).ok, false, query)
        }
    })
})

describe('authentication', () => {
    it('answers 401 without the token and audits the attempt', async () => {
        const response = await request('/projects', { token: null })
        assert.equal(response.status, 401)
        const [entry] = await audit.read({ limit: 10 })
        assert.equal(entry?.actor, 'unauthenticated (claimed client:cl_1)')
        assert.equal(entry?.outcome, 'refused')
        assert.deepEqual(agent.calls, [])
    })

    it('answers 400 for a malformed actor', async () => {
        const response = await request('/projects', { actor: 'root' })
        assert.equal(response.status, 400)
    })
})

describe('GET /projects', () => {
    it('lists only the client\'s own projects, with validity from the agent', async () => {
        const body = await (await request('/projects')).json()
        assert.deepEqual(body, {
            ok: true,
            projects: [
                { id: 'acme', name: 'Acme', capabilities: ['lifecycle', 'logs'], valid: false, reason: 'guard says no' },
                { id: 'quiet', name: 'Quiet', capabilities: [], valid: true },
            ],
        })
    })

    it('shows the admin every project, invalid registry entries included', async () => {
        const body = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<{ id: string, valid: boolean }> }
        assert.deepEqual(body.projects.map(p => [p.id, p.valid]), [['acme', false], ['quiet', true], ['other', true], ['broken', false]])
    })
})

describe('project routes', () => {
    it('answers 404 for another client\'s project without asking the agent', async () => {
        const response = await request('/projects/other/start', { method: 'POST' })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.outcome, entry?.reason, entry?.project], ['refused', 'not-found', 'other'])
    })

    it('answers 403 for a switched-off capability without asking the agent', async () => {
        const response = await request('/projects/quiet/restart', { method: 'POST' })
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })

    it('runs a lifecycle action through the agent and audits it with its output', async () => {
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, output: 'done' })
        assert.deepEqual(agent.calls, [{ verb: 'lifecycle', project: 'acme', args: { action: 'start' } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual(
            [entry?.actor, entry?.user, entry?.project, entry?.verb, entry?.target, entry?.outcome, entry?.output],
            ['client:cl_1', 'user_1', 'acme', 'lifecycle', 'start', 'ok', 'done'],
        )
    })

    it('passes an agent refusal through with its HTTP status', async () => {
        agent.reply = () => ({ ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        const response = await request('/projects/acme/stop', { method: 'POST' })
        assert.equal(response.status, 409)
        assert.deepEqual(await response.json(), { ok: false, code: 'busy', message: 'acme already has a lifecycle action running' })
        assert.equal((await audit.read({ limit: 1 }))[0]?.outcome, 'refused')
    })

    it('reports a failed command as 502 with its output, audited as failed', async () => {
        agent.reply = () => ({ ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 502)
        assert.deepEqual(await response.json(), { ok: false, code: 'failed', message: 'start exited with code 1', output: 'no such image' })
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.outcome, entry?.reason, entry?.output], ['failed', 'start exited with code 1', 'no such image'])
    })

    it('answers 503 when the agent cannot be reached', async () => {
        agent.call = async () => { throw new AgentUnavailableError('the agent closed the connection without answering') }
        const response = await request('/projects/acme/start', { method: 'POST' })
        assert.equal(response.status, 503)
        assert.equal(((await response.json()) as { code: string }).code, 'agent-unavailable')
        assert.equal((await audit.read({ limit: 1 }))[0]?.outcome, 'failed')
    })

    it('returns status without auditing a plain read', async () => {
        const response = await request('/projects/acme')
        assert.deepEqual(await response.json(), { ok: true, services: [] })
        assert.deepEqual(await audit.read({ limit: 10 }), [])
    })

    it('answers 405 and 404 for the wrong method or path', async () => {
        assert.equal((await request('/projects/acme', { method: 'DELETE' })).status, 405)
        assert.equal((await request('/nope')).status, 404)
    })
})

describe('GET /projects/:id/logs', () => {
    it('streams log lines as Server-Sent Events, ending with an end event', async () => {
        const response = await request('/projects/acme/logs?service=web&tail=5')
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
        const text = await response.text()
        assert.ok(text.includes(`event: line\ndata: ${JSON.stringify(logLine)}\n\n`), text)
        assert.ok(text.endsWith('event: end\ndata: {}\n\n'), text)
        assert.deepEqual(agent.calls, [{ verb: 'logs', project: 'acme', args: { service: 'web', tail: 5, since: null, follow: false } }])
        const [entry] = await audit.read({ limit: 1 })
        assert.deepEqual([entry?.verb, entry?.target, entry?.outcome], ['logs', 'web', 'ok'])
    })

    it('answers 400 for a bad query without asking the agent', async () => {
        const response = await request('/projects/acme/logs?service=web&tail=99999')
        assert.equal(response.status, 400)
        assert.deepEqual(agent.calls, [])
    })

    it('passes a stream refusal through as JSON', async () => {
        agent.stream = async () => ({ ok: false, code: 'busy', message: 'acme already has 4 log streams open' })
        const response = await request('/projects/acme/logs?service=web&follow=1')
        assert.equal(response.status, 409)
    })
})

describe('audit routes', () => {
    it('shows a project\'s own trail to its owner, and all of it only to the admin', async () => {
        await request('/projects/acme/start', { method: 'POST' })
        await request('/projects/other/start', { method: 'POST', actor: 'client:cl_2' })

        const own = await (await request('/projects/acme/audit')).json() as { events: Array<{ project: string }> }
        assert.deepEqual(own.events.map(e => e.project), ['acme'])

        assert.equal((await request('/audit')).status, 403)
        const all = await (await request('/audit', { actor: 'admin' })).json() as { events: unknown[] }
        // The two starts, plus the refused client attempt at /audit just above.
        assert.equal(all.events.length, 3)
    })

    it('refuses a bad limit', async () => {
        assert.equal((await request('/projects/acme/audit?limit=0')).status, 400)
        assert.equal((await request('/projects/acme/audit?limit=501')).status, 400)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && npm test`
Expected: FAIL, `Cannot find module './routes.ts'`.

- [ ] **Step 3: Implement the SSE helpers**

Create `hostd/src/api/sse.ts`:

```ts
// Server-Sent Events framing. JSON.stringify never emits a raw newline, so one data line per event is
// always enough.

export function sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// A comment line. Keeps an idle follow stream from being timed out by anything in between.
export const SSE_KEEPALIVE = ': keepalive\n\n'
```

- [ ] **Step 4: Implement the routes**

Create `hostd/src/api/routes.ts`:

```ts
// api's HTTP surface. Every request is authenticated first; every project request passes the policy
// before the agent hears of it; every change, every stream opened and every refusal is audited.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROJECT_ID, SERVICE_NAME, describeError } from '../shared/formats.ts'
import {
    LIFECYCLE_ACTIONS, MAX_TAIL, DEFAULT_TAIL,
    type AgentReply, type AgentRequest, type LifecycleAction, type LogsArgs, type RefusalCode,
} from '../shared/protocol.ts'
import type { Registry } from '../shared/registry.ts'
import { authenticate, actorLabel, type Caller } from './auth.ts'
import { authorize, visibleProjects, type PolicyVerb } from './policy.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { MAX_AUDIT_READ, type AuditLog, type AuditOutcome } from './audit.ts'
import { sseEvent, SSE_KEEPALIVE } from './sse.ts'

export type ApiDeps = {
    token: string
    registry: () => Registry
    agent: AgentClient
    audit: AuditLog
    now?: () => number
    keepaliveMs?: number
}

export type Route =
    | { verb: 'list' }
    | { verb: 'audit-all' }
    | { verb: 'status', project: string }
    | { verb: 'lifecycle', project: string, action: LifecycleAction }
    | { verb: 'logs', project: string }
    | { verb: 'audit', project: string }
    | { verb: 'not-found' }
    | { verb: 'method-not-allowed' }

const AGENT_STATUS: Record<RefusalCode, number> = {
    'bad-request': 400,
    'capability-disabled': 403,
    'unknown-project': 404,
    'unknown-service': 404,
    'invalid-project': 409,
    busy: 409,
    failed: 502,
    unavailable: 503,
}

const DEFAULT_AUDIT_LIMIT = 100
const KEEPALIVE_MS = 25_000

export function matchRoute(method: string, pathname: string): Route {
    const parts = pathname.split('/').filter(part => part !== '')
    const only = (wanted: string, route: Route): Route => (method === wanted ? route : { verb: 'method-not-allowed' })
    if (parts.length === 1 && parts[0] === 'projects') return only('GET', { verb: 'list' })
    if (parts.length === 1 && parts[0] === 'audit') return only('GET', { verb: 'audit-all' })
    if (parts[0] !== 'projects' || parts.length < 2 || parts.length > 3) return { verb: 'not-found' }
    const project = parts[1] ?? ''
    if (!PROJECT_ID.test(project)) return { verb: 'not-found' }
    if (parts.length === 2) return only('GET', { verb: 'status', project })
    const action = parts[2] ?? ''
    if ((LIFECYCLE_ACTIONS as readonly string[]).includes(action)) return only('POST', { verb: 'lifecycle', project, action: action as LifecycleAction })
    if (action === 'logs') return only('GET', { verb: 'logs', project })
    if (action === 'audit') return only('GET', { verb: 'audit', project })
    return { verb: 'not-found' }
}

export function parseLogsQuery(params: URLSearchParams): { ok: true, args: LogsArgs } | { ok: false, message: string } {
    const service = params.get('service')
    if (!service || !SERVICE_NAME.test(service)) return { ok: false, message: 'service is required and must be a compose service name' }

    const tailRaw = params.get('tail')
    const tail = tailRaw === null ? DEFAULT_TAIL : /^\d{1,5}$/.test(tailRaw) ? Number(tailRaw) : NaN
    if (!Number.isInteger(tail) || tail > MAX_TAIL) return { ok: false, message: `tail must be a whole number from 0 to ${MAX_TAIL}` }

    const sinceRaw = params.get('since')
    let since: number | null = null
    if (sinceRaw !== null) {
        const seconds = /^\d+(\.\d+)?$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw) / 1000
        if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, message: 'since must be Unix seconds or an RFC 3339 timestamp' }
        since = seconds
    }

    const followRaw = params.get('follow')
    if (followRaw !== null && !['0', '1', 'true', 'false'].includes(followRaw)) return { ok: false, message: 'follow must be 1 or 0' }
    return { ok: true, args: { service, tail, since, follow: followRaw === '1' || followRaw === 'true' } }
}

function parseLimit(params: URLSearchParams): number | null {
    const raw = params.get('limit')
    if (raw === null) return DEFAULT_AUDIT_LIMIT
    const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0
    return limit >= 1 && limit <= MAX_AUDIT_READ ? limit : null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

function waitForDrain(res: ServerResponse): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
        }
        res.on('drain', done)
        res.on('close', done)
    })
}

export function createHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
    const now = deps.now ?? Date.now

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const started = now()
        const url = new URL(req.url ?? '/', 'http://hostd')
        const route = matchRoute(req.method ?? 'GET', url.pathname)

        const audit = (
            who: { actor: string, user: string },
            fields: { project: string | null, verb: string, target: string | null, outcome: AuditOutcome, reason?: string, output?: string },
        ) => deps.audit.append({ ts: new Date(started).toISOString(), ...who, durationMs: now() - started, ...fields })

        const auth = authenticate(req.headers, deps.token)
        if (!auth.ok) {
            await audit({ actor: auth.label, user: auth.user }, { project: null, verb: route.verb, target: url.pathname.slice(0, 200), outcome: 'refused', reason: auth.code })
            return sendJson(res, auth.status, { ok: false, code: auth.code, message: auth.message })
        }
        const caller: Caller = auth.caller
        const who = { actor: actorLabel(caller.actor), user: caller.user }

        const refuseRoute = async (status: number, code: string, message: string, project: string | null, verb: string, target: string | null = null) => {
            await audit(who, { project, verb, target, outcome: 'refused', reason: code })
            sendJson(res, status, { ok: false, code, message })
        }

        const decide = async (project: string, verb: PolicyVerb, target: string | null) => {
            const decision = authorize(deps.registry(), caller.actor, project, verb)
            if (!decision.ok) await refuseRoute(decision.status, decision.code, decision.message, project, verb, target)
            return decision.ok
        }

        const callAgent = async (request: AgentRequest): Promise<AgentReply | null> => {
            try {
                return await deps.agent.call(request)
            } catch (error) {
                if (!(error instanceof AgentUnavailableError)) throw error
                sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                return null
            }
        }

        switch (route.verb) {
            case 'not-found':
                return refuseRoute(404, 'not-found', 'no such route', null, 'unknown', url.pathname.slice(0, 200))

            case 'method-not-allowed':
                return refuseRoute(405, 'method-not-allowed', `${req.method} is not allowed here`, null, 'unknown', url.pathname.slice(0, 200))

            case 'list': {
                const health = await callAgent({ verb: 'health' })
                if (!health) return
                const invalid = health.ok && 'invalid' in health ? health.invalid : {}
                const registry = deps.registry()
                const projects: Array<Record<string, unknown>> = visibleProjects(registry, caller.actor).map(project => {
                    const reason = Object.hasOwn(invalid, project.id) ? invalid[project.id] : undefined
                    return {
                        id: project.id,
                        name: project.name,
                        capabilities: [...project.capabilities],
                        valid: reason === undefined,
                        ...(reason === undefined ? {} : { reason }),
                    }
                })
                if (caller.actor.kind === 'admin') {
                    for (const [id, reason] of registry.invalid) projects.push({ id, valid: false, reason })
                }
                return sendJson(res, 200, { ok: true, projects })
            }

            case 'audit-all': {
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read the whole audit log', null, 'audit')
                const limit = parseLimit(url.searchParams)
                if (limit === null) return sendJson(res, 400, { ok: false, code: 'bad-request', message: `limit must be 1 to ${MAX_AUDIT_READ}` })
                return sendJson(res, 200, { ok: true, events: await deps.audit.read({ limit }) })
            }

            case 'audit': {
                if (!(await decide(route.project, 'audit', null))) return
                const limit = parseLimit(url.searchParams)
                if (limit === null) return sendJson(res, 400, { ok: false, code: 'bad-request', message: `limit must be 1 to ${MAX_AUDIT_READ}` })
                return sendJson(res, 200, { ok: true, events: await deps.audit.read({ project: route.project, limit }) })
            }

            case 'status': {
                if (!(await decide(route.project, 'status', null))) return
                const reply = await callAgent({ verb: 'status', project: route.project })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'status')
                return sendJson(res, 200, reply)
            }

            case 'lifecycle': {
                const { project, action } = route
                if (!(await decide(project, 'lifecycle', action))) return
                let reply: AgentReply
                try {
                    reply = await deps.agent.call({ verb: 'lifecycle', project, args: { action } })
                } catch (error) {
                    if (!(error instanceof AgentUnavailableError)) throw error
                    await audit(who, { project, verb: 'lifecycle', target: action, outcome: 'failed', reason: error.message })
                    return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                }
                if (reply.ok) {
                    const output = 'output' in reply ? reply.output : ''
                    await audit(who, { project, verb: 'lifecycle', target: action, outcome: 'ok', output })
                    return sendJson(res, 200, { ok: true, output })
                }
                const outcome: AuditOutcome = reply.code === 'failed' ? 'failed' : 'refused'
                await audit(who, {
                    project, verb: 'lifecycle', target: action, outcome,
                    reason: outcome === 'failed' ? reply.message : reply.code,
                    ...(reply.output === undefined ? {} : { output: reply.output }),
                })
                return sendJson(res, AGENT_STATUS[reply.code], reply)
            }

            case 'logs': {
                const parsed = parseLogsQuery(url.searchParams)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'logs')
                const { args } = parsed
                const target = `${args.service}${args.follow ? ' follow' : ''}`
                if (!(await decide(route.project, 'logs', target))) return

                let stream: Awaited<ReturnType<AgentClient['stream']>>
                try {
                    stream = await deps.agent.stream({ verb: 'logs', project: route.project, args })
                } catch (error) {
                    if (!(error instanceof AgentUnavailableError)) throw error
                    await audit(who, { project: route.project, verb: 'logs', target, outcome: 'failed', reason: error.message })
                    return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                }
                if (!stream.ok) return refuseRoute(AGENT_STATUS[stream.code], stream.code, stream.message, route.project, 'logs', target)
                await audit(who, { project: route.project, verb: 'logs', target, outcome: 'ok' })

                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                })
                const logStream = stream
                const stop = () => logStream.close()
                res.on('close', stop)
                const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), deps.keepaliveMs ?? KEEPALIVE_MS)
                try {
                    for await (const line of logStream.lines) {
                        if (!res.write(sseEvent('line', line))) await waitForDrain(res)
                        if (res.destroyed) break
                    }
                    res.write(sseEvent('end', {}))
                } catch (error) {
                    console.error(`[api] ${new Date().toISOString()} log stream for ${route.project} failed: ${describeError(error)}`)
                    res.write(sseEvent('error', { message: 'the log stream failed' }))
                } finally {
                    clearInterval(keepalive)
                    res.off('close', stop)
                    logStream.close()
                    res.end()
                }
                return
            }
        }
    }

    return (req, res) => {
        handle(req, res).catch(error => {
            console.error(`[api] ${new Date().toISOString()} ${req.method} ${req.url} failed: ${describeError(error)}`)
            if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: 'internal error' })
            else res.destroy()
        })
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add hostd/src/api/sse.ts hostd/src/api/routes.ts hostd/src/api/routes.test.ts
git commit -m "Serve status, lifecycle, logs and the audit trail over HTTP behind auth and policy"
```

---

### Task 14: The api entrypoint

The hard gate first: the token must be at least 32 characters, the registry must load, and the agent must answer within about 75 seconds. Then it listens on `:8080` and loops. It polls the registry every 10 seconds, checks the agent every minute, prunes the audit log daily, and writes `status.json` every cycle.

**Files:**
- Create: `hostd/src/api/index.ts`

**Interfaces:**
- Consumes: from Task 3, `RegistryStore`, `explainRegistryError`, `buildStatus`, `writeStatus`; from Task 11, `createAgentClient`, `socketConnect`; from Task 12, `AuditLog`; from Task 13, `createHandler`.
- Produces: the process. It reads `HOSTD_API_TOKEN` (required), `HOSTD_REGISTRY_FILE`, `HOSTD_AGENT_SOCKET`, `HOSTD_STATE_DIR` and `HOSTD_STATUS_FILE`, with the defaults shown below.

- [ ] **Step 1: Write the entrypoint**

Create `hostd/src/api/index.ts`. Like the agent's entrypoint, it is covered by the live checks in the runbook rather than by unit tests.

```ts
// api: boot gate, then HTTP on the private hostd network. Holds the API token and nothing else of value.

import { createServer } from 'node:http'
import { join } from 'node:path'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createAgentClient, socketConnect } from './agent-client.ts'
import { AuditLog } from './audit.ts'
import { createHandler } from './routes.ts'

const TOKEN = process.env.HOSTD_API_TOKEN ?? ''
const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/projects.yaml'
const AGENT_SOCKET = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const STATE_DIR = process.env.HOSTD_STATE_DIR ?? '/state'
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const PORT = 8080
const POLL_MS = 10_000
const AGENT_CHECK_MS = 60_000
const PRUNE_MS = 24 * 60 * 60_000
const MIN_TOKEN_LENGTH = 32
const BOOT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]

const log = (message: string) => console.log(`[api] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

async function main(): Promise<void> {
    const failures: string[] = []
    if (TOKEN.length < MIN_TOKEN_LENGTH) {
        failures.push(`HOSTD_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; generate one on the dedi with: openssl rand -hex 32`)
    }
    const store = new RegistryStore(REGISTRY_FILE)
    try {
        await store.load()
    } catch (error) {
        failures.push(`the registry ${REGISTRY_FILE} could not be loaded: ${explainRegistryError(error)}`)
    }
    if (failures.length > 0) fail(failures)

    // A short timeout for health checks, so a wedged agent is reported promptly.
    const agent = createAgentClient(socketConnect(AGENT_SOCKET), { callTimeoutMs: 15_000 })
    const agentAnswers = async () => {
        try {
            await agent.call({ verb: 'health' })
            return true
        } catch {
            return false
        }
    }
    let reachable = await agentAnswers()
    for (const delay of BOOT_BACKOFF_MS) {
        if (reachable) break
        log(`the agent is not answering on ${AGENT_SOCKET}, retrying in ${delay / 1000}s`)
        await sleep(delay)
        reachable = await agentAnswers()
    }
    if (!reachable) fail([`the agent is not answering on ${AGENT_SOCKET}`])

    const audit = new AuditLog(join(STATE_DIR, 'audit'))
    const pruned = await audit.prune()
    if (pruned.length > 0) log(`pruned audit files: ${pruned.join(', ')}`)

    // Lifecycle calls get the full timeout; only the health probe above uses the short one.
    const handler = createHandler({
        token: TOKEN,
        registry: () => store.current(),
        agent: createAgentClient(socketConnect(AGENT_SOCKET)),
        audit,
    })
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(PORT, '0.0.0.0', resolve))
    log(`listening on :${PORT}`)

    let agentWarning: string | null = null
    let lastAgentCheck = Date.now()
    let lastPrune = Date.now()
    let lastWarnings = ''
    for (;;) {
        const warnings = [...store.warnings(), ...audit.warnings(), ...(agentWarning ? [agentWarning] : [])]
        if (warnings.join('\n') !== lastWarnings) {
            for (const warning of warnings) log(`WARN ${warning}`)
            if (warnings.length === 0 && lastWarnings !== '') log('all warnings cleared')
            lastWarnings = warnings.join('\n')
        }
        await writeStatus(STATUS_FILE, buildStatus(warnings, new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)

        if (await store.refresh()) log('registry reloaded')
        if (Date.now() - lastAgentCheck >= AGENT_CHECK_MS) {
            agentWarning = (await agentAnswers()) ? null : `the agent is not answering on ${AGENT_SOCKET}`
            lastAgentCheck = Date.now()
        }
        if (Date.now() - lastPrune >= PRUNE_MS) {
            const removed = await audit.prune()
            if (removed.length > 0) log(`pruned audit files: ${removed.join(', ')}`)
            lastPrune = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
```

- [ ] **Step 2: Typecheck and run the whole suite**

Run: `cd hostd && npm run typecheck && npm test`
Expected: typecheck exit 0; every test passes.

- [ ] **Step 3: Commit**

```bash
git add hostd/src/api/index.ts
git commit -m "Run api: gate on the token, registry and agent, then serve on the private network"
```

---

### Task 15: Deployment files and the runbook

Packages both processes and documents how to run and verify them on the dedi. Code reaches the dedi only through a merged PR and a `git pull` there, and Docker commands cannot be run from the dev machine, so the runbook is written for the operator to follow on the dedi, pasting output back when something disagrees with what it says to expect.

**Files:**
- Create: `hostd/Dockerfile`
- Create: `hostd/.dockerignore`
- Create: `hostd/docker-compose.yml`
- Create: `hostd/example.env`
- Create: `hostd/projects.example.yaml`
- Create: `hostd/RUNBOOK.md`
- Modify: `.dockerignore` (repo root), adding one line

**Interfaces:**
- Consumes: the entrypoints from Tasks 9 and 14, `src/shared/healthcheck.ts` from Task 3, and the environment variables those read.
- Produces: the `hostd` compose project, the external Docker network `hostd` that the portal will join in a later part, and the operator's procedure.

- [ ] **Step 1: Create the Dockerfile**

Create `hostd/Dockerfile`:

```dockerfile
# One recipe, two targets. The whole test suite runs in the shared stage, so an image whose tests fail is
# never built and a deploy can never replace a running container with one.

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm test

FROM base AS api
# A named volume copies the ownership of the directory it is first mounted over, so this is what lets the
# unprivileged api write its audit log.
RUN mkdir -p /state && chown node:node /state
USER node
CMD ["node", "--import", "tsx", "src/api/index.ts"]

FROM base AS agent
RUN apk add --no-cache docker-cli docker-cli-compose
CMD ["node", "--import", "tsx", "src/agent/index.ts"]
```

- [ ] **Step 2: Create the ignore file for the build context**

Create `hostd/.dockerignore`. The registry and env files must never be baked into an image:

```
node_modules
.env
.env.*
projects.yaml
```

- [ ] **Step 3: Create the compose file**

Create `hostd/docker-compose.yml`:

```yaml
# hostd: the service the client portal will call to control client sites. Deployed on its own, like
# mail/. Nothing is published on the host: api is reachable only on the hostd network, and the agent has
# no network at all in phase 1.

name: hostd

services:
  agent:
    build:
      context: .
      target: agent
    container_name: hostd-agent
    # Root, because it holds the Docker socket. It listens only on the Unix socket in hostd-sock.
    network_mode: none
    environment:
      HOSTD_REGISTRY_FILE: /etc/hostd/projects.yaml
      HOSTD_AGENT_SOCKET: /run/hostd/agent.sock
      # The node user's group in the api image, so api can connect and nothing else can.
      HOSTD_SOCKET_GID: "1000"
      HOSTD_STATUS_FILE: /tmp/hostd-status.json
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # The same path inside as outside: compose hands bind mount sources to the daemon as host paths.
      # Read-only in phase 1, which only reads compose files; file access in phase 3 changes this.
      - /var/www:/var/www:ro
      - ./projects.yaml:/etc/hostd/projects.yaml:ro
      - hostd-sock:/run/hostd
    healthcheck:
      test: ["CMD", "node", "--import", "tsx", "src/shared/healthcheck.ts", "/tmp/hostd-status.json"]
      interval: 60s
      timeout: 15s
      retries: 3
      start_period: 120s
    restart: unless-stopped

  api:
    build:
      context: .
      target: api
    container_name: hostd-api
    env_file: .env
    environment:
      HOSTD_REGISTRY_FILE: /etc/hostd/projects.yaml
      HOSTD_AGENT_SOCKET: /run/hostd/agent.sock
      HOSTD_STATE_DIR: /state
      HOSTD_STATUS_FILE: /tmp/hostd-status.json
    volumes:
      - ./projects.yaml:/etc/hostd/projects.yaml:ro
      - hostd-state:/state
      - hostd-sock:/run/hostd
    networks:
      - hostd
    depends_on:
      - agent
    healthcheck:
      test: ["CMD", "node", "--import", "tsx", "src/shared/healthcheck.ts", "/tmp/hostd-status.json"]
      interval: 60s
      timeout: 15s
      retries: 3
      start_period: 120s
    restart: unless-stopped

networks:
  hostd:
    name: hostd

volumes:
  hostd-state:
  hostd-sock:
```

- [ ] **Step 4: Create the examples**

Create `hostd/example.env`:

```
# Copy to hostd/.env on the dedi and fill in. Never commit the filled-in copy.
# Generate the token on the dedi with:  openssl rand -hex 32
# The portal will hold the same value when it is built; until then only the runbook's checks use it.
HOSTD_API_TOKEN=
```

Create `hostd/projects.example.yaml`:

```yaml
# The registry of client projects. Copy to hostd/projects.yaml on the dedi (gitignored: it names
# clients). hostd reads it and never writes it; edits take effect within 10 seconds, and an edit that
# breaks the file is rejected as a whole, leaving the last good version in force.

# Hostnames at or below these are never accepted as client domains (phase 4).
reserved: [horizons.gg]

# Offsite backup retention, which only the operator sets (phase 2).
offsite:
  keep: { daily: 14, weekly: 8, monthly: 6 }

projects:
  # The id is also the compose project name. It must match what `docker compose ls` shows for the site,
  # or the compose file must say `name: <id>`.
  acme-bakery:
    client: cl_8f2k1              # the portal's client id
    name: Acme Bakery
    dir: /var/www/acme-bakery     # exactly one segment below /var/www
    compose: docker-compose.yml   # relative to dir
    upstream: 127.0.0.1:5010      # what the vhost will proxy to (phase 4)
    services:
      web: { role: site }
      db: { role: database, engine: postgres }   # postgres | mysql | mariadb | mongodb | sqlite | redis | generic
    storage:
      # Each must be a bind mount of a site service, must not be mounted into a database service, and
      # must not contain the compose file, an env file, a build context or a Dockerfile.
      media: { path: uploads, mode: rw }         # rw | ro | hidden (backed up, never shown)
    capabilities: [lifecycle, logs]              # lifecycle | logs | files | backups | domains
```

- [ ] **Step 5: Keep hostd out of the site image**

Modify the repo root `.dockerignore`. It currently ends with `mail/` and `docs/`; add `hostd/` on its own line after `mail/`, keeping the file's CRLF line endings. The result:

```
.next/
node_modules/
.env*
mail/
hostd/
docs/
```

- [ ] **Step 6: Write the runbook**

Create `hostd/RUNBOOK.md`:

````markdown
# hostd runbook

hostd lets the client portal control client sites on this dedi. Phase 1 covers status, start, stop,
restart and logs. It is two containers:

- `hostd-agent` holds the Docker socket. It has no network and listens only on a Unix socket.
- `hostd-api` speaks HTTP on the private `hostd` Docker network. Nothing is published on the host.

Client sites never depend on hostd. If it is down, every site keeps serving; only the portal's controls
stop working.

## Before the first start

1. Pull the repo on the dedi, then work in `hostd/`.
2. Create `hostd/.env` from `hostd/example.env`. Generate the token here on the dedi, and paste it into
   the file yourself:

   ```bash
   openssl rand -hex 32
   ```

3. Create `hostd/projects.yaml` from `hostd/projects.example.yaml`, and delete the example project for
   now. **This must exist before the first `docker compose up`:** if it does not, Docker creates a
   directory with that name instead, and both containers refuse to start with a message saying so. If
   that happens, remove the directory, create the file, and start again.

## First start

```bash
cd hostd
docker compose up -d --build
docker compose ps
```

The build runs the whole test suite. A failing test stops the build, and whatever was running before
keeps running.

Both containers should report `healthy` within about two minutes. Both logs should show `listening`:

```bash
docker compose logs agent | tail -20
docker compose logs api | tail -20
```

If a container exits, its log names the failed check on a `FATAL` line.

## Calling the API from the dedi

The portal does not exist yet, so the checks below call the API from a throwaway container on the
`hostd` network. Define this helper in the shell, from `hostd/`. It reads the token from `.env` inside
the throwaway container, so the token never appears in the host's process list:

```bash
hc() {
  docker run --rm --network hostd --env-file .env -e ACTOR="${ACTOR:-admin}" curlimages/curl:8.10.1 \
    sh -c 'curl -sS -N -H "Authorization: Bearer $HOSTD_API_TOKEN" -H "X-Hostd-Actor: $ACTOR" -H "X-Hostd-User: runbook" "$@"' curl "$@"
}
```

`ACTOR` defaults to `admin`. Prefix a call with `ACTOR=client:<id>` to act as a client.

## Live checks with a throwaway project

These prove phase 1 end to end. Do them once after the first deploy, and again after any change to
hostd.

### Set up the test project

```bash
sudo mkdir -p /var/www/hostd-test/html
echo 'hostd test page' | sudo tee /var/www/hostd-test/html/index.html
sudo tee /var/www/hostd-test/docker-compose.yml >/dev/null <<'EOF'
name: hostd-test
services:
  web:
    image: nginx:1.27-alpine
    ports: ["127.0.0.1:5099:80"]
    volumes:
      - ./html:/usr/share/nginx/html
  db:
    image: postgres:16-alpine
    environment:
      # A throwaway value for a throwaway database with no published port.
      POSTGRES_PASSWORD: hostd-test-only
    volumes:
      - ./db:/var/lib/postgresql/data
EOF
cd /var/www/hostd-test && sudo docker compose up -d && cd -
```

Add this entry under `projects:` in `hostd/projects.yaml`:

```yaml
  hostd-test:
    client: cl_test
    name: hostd test
    dir: /var/www/hostd-test
    upstream: 127.0.0.1:5099
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      html: { path: html, mode: rw }
    capabilities: [lifecycle, logs]
```

Wait ten seconds for the reload, then run each check. Each one says what to expect.

| # | Command | Expect |
| --- | --- | --- |
| 1 | `hc http://hostd-api:8080/projects` | `hostd-test` listed with `"valid":true` |
| 2 | `hc http://hostd-api:8080/projects/hostd-test` | `web` and `db` both `"state":"running"` |
| 3 | `hc -X POST http://hostd-api:8080/projects/hostd-test/stop` | `{"ok":true,...}`; check 2 then shows both `exited` |
| 4 | `hc -X POST http://hostd-api:8080/projects/hostd-test/start` | `{"ok":true,...}`; check 2 shows both `running` again |
| 5 | `hc -X POST http://hostd-api:8080/projects/hostd-test/restart` | `{"ok":true,...}`; `startedAt` in check 2 moves forward |
| 6 | `hc 'http://hostd-api:8080/projects/hostd-test/logs?service=web&tail=5'` | up to five `event: line` blocks, then `event: end` |
| 7 | `hc 'http://hostd-api:8080/projects/hostd-test/logs?service=web&tail=0&follow=1'`, then in another shell `curl -s http://127.0.0.1:5099/` | a new `event: line` for that request appears at once; Ctrl-C to stop |
| 8 | `ACTOR=client:cl_test hc http://hostd-api:8080/projects` | only `hostd-test` |
| 9 | `ACTOR=client:someone-else hc http://hostd-api:8080/projects/hostd-test` | `404`, `"code":"not-found"` |
| 10 | `ACTOR=client:someone-else hc -X POST http://hostd-api:8080/projects/hostd-test/stop` | `404`; check 2 shows the site still running |
| 11 | `hc http://hostd-api:8080/projects/hostd-test/audit` | the stop, start, restart, log streams and refusals above, newest first |
| 12 | `docker logs hostd-agent \| tail -20` | the agent's own record of the same verbs |

### The capability switch

Remove `lifecycle` from the test entry's `capabilities` and wait ten seconds. Then:

```bash
hc -X POST http://hostd-api:8080/projects/hostd-test/stop
```

Expect `403` with `"code":"capability-disabled"`. Put `lifecycle` back.

### The storage guard

This proves that a database directory can never be exposed. Add a second storage entry that points at
the database's directory:

```yaml
      dbfiles: { path: db, mode: ro }
```

Wait ten seconds. Then:

```bash
hc http://hostd-api:8080/projects
hc -X POST http://hostd-api:8080/projects/hostd-test/restart
docker compose logs agent | tail -5
```

Expect:
- The listing shows `hostd-test` with `"valid":false` and a reason. The reason says both that `dbfiles`
  is not bind-mounted into a site service and that it overlaps a database service's mount.
- The restart is refused with `409` and `"code":"invalid-project"`.
- The agent log has a `WARN project hostd-test is invalid` line.
- `docker compose ps` shows the agent `unhealthy` after its next healthcheck.

Remove the `dbfiles` line. Within ten seconds the project is valid again, and the agent becomes healthy
at its next healthcheck.

### The boundary itself

```bash
docker port hostd-api
docker inspect hostd-agent --format '{{.HostConfig.NetworkMode}}'
docker exec hostd-agent ls -ln /run/hostd/agent.sock
```

Expect:
- `docker port` prints nothing: no host port is published.
- The network mode is `none`.
- The socket is `srw-rw----` owned by `0 1000`.

### A registry edit that breaks the file

Add a stray `[` anywhere in `projects.yaml`. Within ten seconds, both logs show `WARN registry reload
rejected, still using the last good version`, and check 2 still works. Remove the `[`, and the warning
clears.

### Clean up

```bash
cd /var/www/hostd-test && sudo docker compose down && cd -
sudo rm -rf /var/www/hostd-test
```

Then remove the `hostd-test` entry from `projects.yaml`.

## Enrolling a real site

1. Find the site's compose project name:

   ```bash
   docker compose ls
   ```

   Use that name as the registry id. If you want a different id, add `name: <id>` at the top of the
   site's compose file and run `docker compose up -d` there once first. Otherwise hostd refuses the
   project with a message that says so. That refusal is deliberate: starting it under a different name
   would create a second copy of the site beside the running one.

2. Add the entry. List every service in the compose file that you want visible, with its role, and give
   each database its engine.

3. Only add `storage` entries for directories that are bind mounts of the site container, such as
   uploads or media. Never add the site directory itself, and never a directory holding the compose
   file, `.env`, an env file, a Dockerfile or a build context. hostd refuses those anyway, and says why.

4. Wait ten seconds, then run `hc http://hostd-api:8080/projects` and confirm `"valid":true`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL ... is not a file (was projects.yaml created before the first docker compose up?)` | Docker created a directory at `projects.yaml`. Remove it, create the file, start again. |
| `FATAL HOSTD_API_TOKEN must be at least 32 characters` | `.env` is missing, or the token is empty or too short. |
| `FATAL the agent is not answering on /run/hostd/agent.sock` (api) | The agent is not running or failed its own gate. Read `docker compose logs agent`. |
| `503` with `"code":"agent-unavailable"` | The same, after startup. |
| A project is `"valid":false` with `compose resolves the project name ...` | See step 1 of Enrolling a real site. |
| A project is `"valid":false` with `... does not exist on the dedi` | `dir` is wrong, or the directory was removed. |
| `api` unhealthy with `the audit log could not be written` | The `hostd-state` volume is full or has the wrong owner. |
````

- [ ] **Step 7: Build the image locally if Docker is available, otherwise rely on the suite**

The dev machine cannot reach the dedi's Docker, and may not have Docker at all. If `docker` is available locally, run:

```bash
cd hostd && docker build --target agent -t hostd-agent-check . && docker build --target api -t hostd-api-check .
```

Expected: both builds succeed, including the `npm test` layer. If Docker is not available locally, skip this step and say so in the PR description; the first build on the dedi runs the same test layer.

- [ ] **Step 8: Run the whole suite and the typecheck one last time**

Run: `cd hostd && npm run typecheck && npm test`
Expected: exit 0 and every test passing.

- [ ] **Step 9: Scan for em dashes**

Use the Grep tool to search `hostd/` and `.dockerignore` for the em dash character (U+2014) and for the text `&mdash;`.
Expected: no matches outside code comments. Fix any match in prose, runbook text or YAML comments with a comma, colon, full stop or parentheses. (Comments in `.ts` files and the Dockerfile may keep them, but there is no need to add any.)

- [ ] **Step 10: Commit**

```bash
git add hostd/Dockerfile hostd/.dockerignore hostd/docker-compose.yml hostd/example.env hostd/projects.example.yaml hostd/RUNBOOK.md .dockerignore
git commit -m "Package hostd as two containers with a runbook for the dedi"
```

---

## After the last task

- Use superpowers:finishing-a-development-branch. Push the branch and open a PR against `Master`. The PR description lists the five differences from the spec recorded in this plan, and the storage guard's one-directional rule from Task 5, and ends with the attribution line.
- The operator merges quickly. Before pushing any follow-up commit, check the PR is still open with `gh pr view <n> --json state`; if it has merged, open a new PR instead.
- Deployment and the live checks are the operator's, on the dedi, following `hostd/RUNBOOK.md`.
